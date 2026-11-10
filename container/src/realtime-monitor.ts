import { providerContext } from "./provider-metrics";
import { createHash } from "node:crypto";
import type { HistoryClient } from "./history";
import type { DurableEventInput, DurableRealtimeStore, DurableWatch } from "./realtime-store";
import { RealtimeError, validateAddresses } from "./realtime";
import { watchKey, canPollHistory } from "./realtime-watch";
import chains from "../data/chains.json";
const nativeCaip = new Map(Object.entries(chains as Record<string, any>).map(([id, chain]) => [id, String(chain.nativeAssetCaip || "")]));
/** The Worker alarm calls tick even with Vault closed. Registrations, dedupe and
 * queue cursors live in PostgreSQL; this process has no offline timer daemon. */
export class RealtimeMonitor {
 private running?: Promise<{ watches: number; queued: number; failures: number }>;
 constructor(private readonly history: Pick<HistoryClient, "getTransactionHistory">, readonly store: DurableRealtimeStore,
  private readonly publish: (clientId: string, scope: string, event: "tx:incoming" | "tx:confirmed", payload: Record<string, unknown>, cursor: string) => void) {}
 async register(clientId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const walletScope = scope(body.walletScope);
  if (typeof body.enabled !== "boolean") throw new RealtimeError("enabled must be a boolean");
  const { addresses, unsupported } = body.enabled ? validateAddresses(body.addresses) : { addresses: [], unsupported: [] };
  if (body.since !== undefined && (typeof body.since !== "number" || !Number.isSafeInteger(body.since) || body.since < 0 || body.since > Date.now() + 60_000)) throw new RealtimeError("Invalid durable since cursor");
  if (body.revision !== undefined && (typeof body.revision !== "number" || !Number.isSafeInteger(body.revision) || body.revision < 0)) throw new RealtimeError("Invalid registration revision");
  await this.store.replaceWatches(clientId, walletScope, addresses, { enabled: body.enabled,
   ...(body.since !== undefined ? { since: body.since as number } : {}), ...(body.revision !== undefined ? { revision: body.revision as number } : {}) });
  // The edge arms the durable alarm immediately after this successful response.
  return { success: true, walletScope, enabled: body.enabled, watching: addresses.length, unsupported,
   backgroundMonitoring: body.enabled && addresses.some(w => canPollHistory(w.networkId)),
   onDemandNetworks: [...new Set(addresses.filter(w => !canPollHistory(w.networkId)).map(w => w.networkId))],
   retentionSeconds: 7 * 24 * 60 * 60, replayRequiresAcknowledgement: true,
   historyCoverage: "latest-provider-page", historyPageLimit: 50 };
 }
 tick(): Promise<{ watches: number; queued: number; failures: number }> {
  if (this.running) return this.running;
  this.running = this.run().finally(() => { this.running = undefined; }); return this.running;
 }
 private async run(): Promise<{ watches: number; queued: number; failures: number }> {
  // Keep registrations/replay intact, but never turn EVM watches into paid reads.
  // Returning zero polling watches also lets the scheduler disarm EVM-only alarms.
  const rows = (await this.store.listActiveWatches()).filter(w => canPollHistory(w.networkId));
  const grouped = new Map<string, DurableWatch[]>();
  for (const row of rows) { const key = watchKey(row), group = grouped.get(key) || []; group.push(row); grouped.set(key, group); }
  const batches = [...grouped.values()].map(owners => [owners]);
  const incoming: DurableEventInput[] = []; let failures = 0, queued = 0, next = 0, possiblyTruncated = 0, unknownConfirmedTimestamps = 0;
  // Bound upstream concurrency while letting a slow chain yield to other work.
  await Promise.all(Array.from({ length: Math.min(6, batches.length) }, async () => {
   for (;;) {
    const index = next++; if (index >= batches.length) return;
    const batch = batches[index].filter(owners => {
     if (nativeCaip.has(owners[0].networkId)) return true;
     failures++; return false;
    });
    if (!batch.length) continue;
    try {
     const clients = new Set(batch.flat().map(owner => owner.clientId));
     const result: any = await providerContext.run({ source: "background_monitor", ...(clients.size === 1 ? { clientId: [...clients][0] } : {}) },
      () => this.history.getTransactionHistory({ queries: batch.map(owners => ({ caip: nativeCaip.get(owners[0].networkId)!, pubkey: owners[0].address })) }, { forceRefresh: true }));
     for (let item = 0; item < batch.length; item++) {
      const owners = batch[item];
      const txs = result?.histories?.[item]?.transactions;
      if (!Array.isArray(txs)) { failures++; continue; }
      if (txs.length >= 50) possiblyTruncated++;
      for (const tx of txs.slice(0, 200)) {
       if (typeof tx?.txid !== "string" || !tx.txid || tx.txid.length > 256 || /\s/.test(tx.txid) || /^(?:0x)?0+$/i.test(tx.txid)) continue;
       const raw = Number(tx.timestamp), suppliedTime = raw < 1e12 ? raw * 1000 : raw;
       const estimated = (!Number.isFinite(suppliedTime) || suppliedTime <= 0) && tx.status === "pending";
       const timestamp = estimated ? Date.now() : suppliedTime;
       if (!Number.isFinite(timestamp) || timestamp <= 0) { unknownConfirmedTimestamps++; continue; }
       if (timestamp > Date.now() + 60_000) continue;
       for (const owner of owners) {
        // One-second overlap protects second-resolution block timestamps at the
        // watch-registration boundary. Stable IDs make that overlap idempotent.
        if (timestamp < owner.since - 1_000) continue;
        const names: Array<"tx:incoming" | "tx:confirmed"> = tx.status === "confirmed" ? ["tx:incoming", "tx:confirmed"] : ["tx:incoming"];
        for (const eventName of names) {
         const eventId = createHash("sha256").update(`${watchKey(owner)}:${tx.txid}:${eventName}`).digest("hex");
         incoming.push({ clientId: owner.clientId, walletScope: owner.walletScope, eventId, eventName,
          payload: { address: owner.address, watchAddress: owner.address, networkId: owner.networkId, txid: tx.txid,
           eventId, cursor: Date.now(), ...(estimated ? { timestampEstimated: true } : {}), refreshHint: true, reason: "durable-monitor", type: eventName === "tx:confirmed" ? "confirmation_update" : "activity" } });
        }
       }
      }
     }
    } catch { failures += batch.length; } // Provider-controlled errors may contain wallet data.
   }
  }));
  for (let index = 0; index < incoming.length; index += 500) {
   const created = await this.store.enqueueEvents(incoming.slice(index, index + 500)); queued += created.length;
   for (const event of created) this.publish(event.clientId, event.walletScope, event.eventName, event.payload, event.id);
  }
  await this.store.prune();
  return { watches: rows.length, queued, failures, ...(possiblyTruncated || unknownConfirmedTimestamps ? {
   diagnostics: { historyCoverage: "latest-provider-page", possiblyTruncated, unknownConfirmedTimestamps },
  } : {}) };
 }
}
export function scope(raw: unknown): string {
 if (typeof raw !== "string" || !/^[A-Za-z0-9:_-]{1,160}$/.test(raw)) throw new RealtimeError("Invalid wallet scope"); return raw;
}
