import { AsyncLocalStorage } from "node:async_hooks";

export type ProviderSource = "http" | "background_monitor" | "realtime_poll" | "unknown" | "collector";
export interface ProviderContext { source: ProviderSource; clientId?: string; requestId?: string; cacheOnly?: boolean; refreshReason?: string }
export const providerContext = new AsyncLocalStorage<ProviderContext>();
export type ZerionOperation = "chains" | "wallet_positions" | "defi_positions" | "transactions" | "collector";
export interface ProviderUsage {
 bucket: string; instanceId: string; provider: "zerion"; source: ProviderSource;
 clientId: string; operation: ZerionOperation; outcome: string; forced: boolean;
 status: number; count: number; durationMs: number; credentialId: string; refreshReason: string;
}

/** Minute totals are cumulative per process. Re-sending a snapshot is idempotent,
 * including an ambiguous commit. Structured upstream logs cover the flush gap.
 * Bounded cardinality and failures never delay a wallet/provider request. */
export class ProviderMetrics {
 private readonly instanceId = crypto.randomUUID();
 private readonly buckets = new Map<string, ProviderUsage>();
 private flushing?: Promise<void>;
 private timer?: ReturnType<typeof setInterval>;
 constructor(private readonly write: (rows: ProviderUsage[]) => Promise<void>,
  private readonly log: (record: Record<string, unknown>) => void = record => console.log(JSON.stringify(record)),
  private readonly now: () => number = Date.now,
  private readonly credentialId = "") {}

 start(): void {
  if (this.timer) return;
  this.timer = setInterval(() => { void this.flush(); }, 10_000);
  this.timer.unref();
 }

 record(operation: ZerionOperation, outcome: string, options: { forced?: boolean; status?: number; durationMs?: number; count?: number } = {}): void {
  try {
   const context = providerContext.getStore();
   const row: ProviderUsage = {
    bucket: new Date(Math.floor(this.now() / 60_000) * 60_000).toISOString(), instanceId: this.instanceId,
    provider: "zerion", source: context?.source || "unknown", clientId: context?.clientId || "",
    operation, outcome, forced: options.forced === true, status: options.status || 0,
    credentialId: this.credentialId, refreshReason: context?.refreshReason || "",
    count: options.count ?? 1, durationMs: Math.max(0, Math.round(options.durationMs || 0)),
   };
   const key = JSON.stringify([row.bucket, row.source, row.clientId, operation, outcome, row.forced, row.status]);
   const existing = this.buckets.get(key);
   if (existing) { existing.count += row.count; existing.durationMs += row.durationMs; if(existing.refreshReason!==row.refreshReason)existing.refreshReason='mixed'; }
   else if (this.buckets.size < 2000) this.buckets.set(key, row);
   else this.log({ event: "provider_metrics_overflow", provider: "zerion" });
   if (outcome.startsWith("upstream_")) this.log({ event: "provider_request", ...row, requestId: context?.requestId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(context.requestId) ? context.requestId : undefined });
  } catch { /* Metrics cannot break provider reads, even if the logger fails. */ }
 }

 flush(): Promise<void> {
  if (this.flushing) return this.flushing;
  providerContext.run({source:"collector"},()=>this.record("collector","heartbeat",{count:0}));
    const entries = [...this.buckets.entries()].map(([key, row]) => [key, { ...row }] as const);
  const rows = entries.map(([, row]) => row);
  if (!rows.length) return Promise.resolve();
  this.flushing = (async () => {
   try {
    await this.write(rows);
    for (const [key, sent] of entries) {
     if (Date.parse(sent.bucket) < this.now() - 120_000 && this.buckets.get(key)?.count === sent.count) this.buckets.delete(key);
    }
   } catch {
    try { this.log({ event: "provider_metrics_write_failed", provider: "zerion", buckets: rows.length }); } catch {}
   }
  })().finally(() => { this.flushing = undefined; });
  return this.flushing;
 }

 async close(): Promise<void> {
  if (this.timer) clearInterval(this.timer);
  if (this.flushing) await this.flushing;
  await this.flush();
 }
}
