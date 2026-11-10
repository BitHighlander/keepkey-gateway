import { providerContext } from "./provider-metrics";
import { createHash } from "node:crypto";
import type { HistoryClient } from "./history";
import type { LiveWatchFeed } from "./blockbook-live";
import chains from "../data/chains.json";
import { watchKey, canPollHistory, type WatchAddress } from "./realtime-watch";
export type { WatchAddress } from "./realtime-watch";
const POLL_INTERVAL_MS = 15_000, MAX_ADDRESSES = 200, MAX_SEEN = 200, INVENTORY_TTL_MS = 10 * 60_000;
const nativeCaip = new Map(Object.entries(chains as Record<string, any>).map(([id, c]) => [id, String(c.nativeAssetCaip || "")]));
type EventName = "tx:incoming" | "tx:confirmed";
type Sender = (event: string, data: Record<string, unknown>) => void;
interface Subscription { clientId: string; addresses: WatchAddress[]; events: Set<EventName>; send: Sender; since?: number; walletScope?: string; catchup: Set<string>; sent: Set<string>; explicit: boolean; dispose?: () => void }
interface Socket { clientId: string; send: Sender; explicit: boolean }
interface Inventory { addresses: WatchAddress[]; expiresAt: number; overflow: number }
export class RealtimeError extends Error { constructor(message: string, public readonly status = 400) { super(message); } }
/** Active-connection leases only: both transports share watches and upstreams.
 * Notifications are refresh hints, never an unverified native/token credit. */
export class RealtimeHub {
 private subscriptions = new Map<string, Subscription>();
 private sockets = new Map<string, Socket>();
 private inventories = new Map<string, Inventory>();
 private snapshots = new Map<string, Map<string, string>>();
 private timer?: ReturnType<typeof setTimeout>;
 private polling = false;
 private generation = 0;
 private quietPolls = 0;
 private forceNetworks = new Set<string>();
 private feed?: LiveWatchFeed;
 private syncTimer?: ReturnType<typeof setTimeout>;
 private pendingSync = new Map<string, string>();
 constructor(private readonly history: Pick<HistoryClient, "getTransactionHistory">, private readonly intervalMs = POLL_INTERVAL_MS) {}
 setUpstream(feed: LiveWatchFeed): void { this.feed?.close(); this.feed = feed; this.feed.replace([...this.uniqueWatches().values()]); }
 createSse(clientId: string, rawAddresses: unknown, rawEvents: unknown, options: { since?: unknown; walletScope?: string } = {}): Response {
  const validated = validateAddresses(rawAddresses), events = validateEvents(rawEvents), since = validateSince(options.since);
  const id = `sse:${crypto.randomUUID()}`, encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
   start: controller => {
    const send: Sender = (event, data) => controller.enqueue(encoder.encode(`id: ${data.cursor || Date.now()}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    this.explicitInventory(clientId, validated.addresses);
    this.install(id, { clientId, addresses: validated.addresses, events, send, since, walletScope: options.walletScope, catchup: new Set(since === undefined ? [] : validated.addresses.map(watchKey)), sent: new Set(), explicit: true,
     dispose: () => { if (heartbeat) clearInterval(heartbeat); try { controller.close(); } catch {} } });
    send("connected", { sessionId: id, watching: validated.addresses.length, cursor: Date.now(), transport: "upstream-with-fallback", ...(validated.unsupported.length ? { unsupported: validated.unsupported } : {}) });
    this.syncSubscription(this.subscriptions.get(id)!, "subscribe");
    heartbeat = setInterval(() => { try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch { if (heartbeat) clearInterval(heartbeat); this.removeSubscription(id); } }, 20_000);
   },
   cancel: () => { if (heartbeat) clearInterval(heartbeat); this.removeSubscription(id); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
 }
 addSocket(clientId: string, socketId: string, send: Sender): void {
  const prior = this.sockets.get(socketId);
  if (prior && prior.clientId !== clientId) throw new RealtimeError("Socket authentication cannot change identity", 403);
  this.sockets.set(socketId, { clientId, send, explicit: prior?.explicit || false });
  const inventory = this.inventories.get(clientId);
  if (!prior?.explicit && inventory && inventory.expiresAt > Date.now()) this.installImplicit(socketId, inventory);
 }
 subscribeSocket(clientId: string, socketId: string, rawAddresses: unknown, rawEvents: unknown, options: { since?: unknown; walletScope?: string } = {}): Record<string, unknown> {
  const socket = this.ownedSocket(clientId, socketId), validated = validateAddresses(rawAddresses), events = validateEvents(rawEvents), since = validateSince(options.since);
  socket.explicit = true; this.explicitInventory(clientId, validated.addresses);
  this.install(`socket:${socketId}`, { clientId, addresses: validated.addresses, events, send: socket.send, since, walletScope: options.walletScope, catchup: new Set(since === undefined ? [] : validated.addresses.map(watchKey)), sent: new Set(), explicit: true });
  const ack = { success: true, watching: validated.addresses.length, cursor: Date.now(), ...(validated.unsupported.length ? { unsupported: validated.unsupported } : {}) };
  socket.send("subscribed", ack); this.syncSubscription(this.subscriptions.get(`socket:${socketId}`)!, "subscribe"); return ack;
 }
 unsubscribeSocket(clientId: string, socketId: string): void { this.ownedSocket(clientId, socketId).explicit = true; this.removeSubscription(`socket:${socketId}`); }
 removeSocket(clientId: string | undefined, socketId: string): void {
  if (!clientId || this.sockets.get(socketId)?.clientId !== clientId) return;
  this.sockets.delete(socketId); this.removeSubscription(`socket:${socketId}`);
 }
 /** Legacy SDK auth/join receives only its own recent REST portfolio inventory.
  * Chunks merge while no explicit wallet lease owns this client identity. */
 rememberPortfolio(clientId: string, raw: unknown): void {
  if ([...this.subscriptions.values()].some(s => s.clientId === clientId && s.explicit)) return;
  if (!Array.isArray(raw)) return;
  const previous = this.inventories.get(clientId), candidates = new Map<string, WatchAddress>();
  if (previous && previous.expiresAt > Date.now()) for (const address of previous.addresses) candidates.set(watchKey(address), address);
  for (const item of raw) {
   const address = typeof item?.pubkey === "string" ? item.pubkey.trim() : "", networkId = typeof item?.caip === "string" ? item.caip.split("/")[0] : "";
   if (address && address.length <= 512 && !/\s/.test(address) && nativeCaip.has(networkId)) candidates.set(watchKey({ address, networkId }), { address, networkId });
  }
  if (!candidates.size) return;
  const inventory = { addresses: [...candidates.values()].slice(0, MAX_ADDRESSES), expiresAt: Date.now() + INVENTORY_TTL_MS, overflow: Math.max(0, candidates.size - MAX_ADDRESSES) };
  this.inventories.delete(clientId); this.inventories.set(clientId, inventory);
  while (this.inventories.size > 1000) this.inventories.delete(this.inventories.keys().next().value!);
  for (const [id, socket] of this.sockets) if (socket.clientId === clientId && !socket.explicit) this.installImplicit(id, inventory);
 }
 upstreamChange(watch: WatchAddress, txid?: string, confirmed = false): void {
  if (!this.uniqueWatches().has(watchKey(watch))) return;
  this.emit(watch, "tx:incoming", txid, "upstream");
  if (confirmed) this.emit(watch, "tx:confirmed", txid, "upstream");
  this.requestSync(watch.networkId);
 }
 publishStored(clientId: string, walletScope: string, eventName: "tx:incoming" | "tx:confirmed", payload: Record<string, unknown>, replayCursor: string): void {
  const address = payload.watchAddress || payload.address, networkId = payload.networkId;
  if (typeof address !== "string" || typeof networkId !== "string") return;
  const watch = { address, networkId };
  for (const subscription of this.subscriptions.values()) {
   if (subscription.clientId !== clientId || subscription.walletScope && subscription.walletScope !== walletScope
    || !subscription.addresses.some(w => watchKey(w) === watchKey(watch))) continue;
   this.deliver(subscription, watch, eventName, typeof payload.txid === "string" ? payload.txid : undefined, "queued-event", replayCursor);
  }
 }
 upstreamSync(networkId: string, reason: "upstream_reconnected" | "new_block"): void {
  if (![...this.subscriptions.values()].some(s => s.addresses.some(w => w.networkId === networkId))) return;
  this.scheduleSync(networkId, reason);
  this.requestSync(networkId);
 }
 close(): void {
  for (const subscription of this.subscriptions.values()) subscription.dispose?.();
  this.subscriptions.clear(); this.sockets.clear(); this.inventories.clear(); this.snapshots.clear(); this.generation++;
  if (this.timer) clearTimeout(this.timer); if (this.syncTimer) clearTimeout(this.syncTimer);
  this.timer = undefined; this.syncTimer = undefined; this.pendingSync.clear(); this.forceNetworks.clear(); this.feed?.close();
 }
 activeAddressCount(): number { return this.uniqueWatches().size; }
 activeSubscriptionCount(): number { return this.subscriptions.size; }
 private ownedSocket(clientId: string, socketId: string): Socket {
  const socket = this.sockets.get(socketId); if (!socket || socket.clientId !== clientId) throw new RealtimeError("Socket is not authenticated for this client", 403); return socket;
 }
 private explicitInventory(clientId: string, addresses: WatchAddress[]): void {
  this.inventories.set(clientId, { addresses, expiresAt: Date.now() + INVENTORY_TTL_MS, overflow: 0 });
  for (const [id, socket] of this.sockets) if (socket.clientId === clientId && !socket.explicit) this.installImplicit(id, { addresses, expiresAt: Date.now() + INVENTORY_TTL_MS, overflow: 0 });
 }
 private installImplicit(socketId: string, inventory: Inventory): void {
  const socket = this.sockets.get(socketId); if (!socket || socket.explicit) return;
  this.install(`socket:${socketId}`, { clientId: socket.clientId, addresses: inventory.addresses, events: validateEvents(undefined), send: socket.send, catchup: new Set(), sent: new Set(), explicit: false });
  socket.send("subscribed", { success: true, watching: inventory.addresses.length, overflow: inventory.overflow, cursor: Date.now(), source: "portfolio-inventory" });
  this.syncSubscription(this.subscriptions.get(`socket:${socketId}`)!, "subscribe");
 }
 private install(id: string, subscription: Subscription): void {
  this.subscriptions.set(id, subscription); this.watchesChanged();
 }
 private removeSubscription(id: string): void {
  const prior = this.subscriptions.get(id); this.subscriptions.delete(id); prior?.dispose?.();
  if (prior?.explicit && ![...this.subscriptions.values()].some(s => s.clientId === prior.clientId && s.explicit)) {
   this.inventories.delete(prior.clientId);
   for (const [socketId, socket] of this.sockets) if (socket.clientId === prior.clientId && !socket.explicit) this.subscriptions.delete(`socket:${socketId}`);
  }
  this.watchesChanged();
 }
 private watchesChanged(): void {
  this.generation++;
  const watches = this.uniqueWatches(); for (const key of this.snapshots.keys()) if (!watches.has(key)) this.snapshots.delete(key);
  if (this.timer) clearTimeout(this.timer); this.timer = undefined;
  if (!watches.size) {
   this.feed?.close(); this.quietPolls = 0; this.forceNetworks.clear();
   if (this.syncTimer) clearTimeout(this.syncTimer); this.syncTimer = undefined; this.pendingSync.clear();
  }
  else { this.feed?.replace([...watches.values()]); this.ensurePolling(); }
 }
 private uniqueWatches(): Map<string, WatchAddress> {
  const result = new Map<string, WatchAddress>(); for (const sub of this.subscriptions.values()) for (const watch of sub.addresses) result.set(watchKey(watch), watch); return result;
 }
 private syncSubscription(subscription: Subscription, reason: string, networkIds = [...new Set(subscription.addresses.map(w => w.networkId))]): void {
  try { subscription.send("sync:required", { refreshHint: true, reason, networkIds, cursor: Date.now() }); } catch {}
 }
 private scheduleSync(networkId: string, reason: string): void {
  this.pendingSync.set(networkId, reason);
  if (this.syncTimer) return;
  this.syncTimer = setTimeout(() => {
   this.syncTimer = undefined; const pending = new Map(this.pendingSync); this.pendingSync.clear();
   for (const subscription of this.subscriptions.values()) {
    const networks = [...new Set(subscription.addresses.map(w => w.networkId))].filter(network => pending.has(network));
    if (networks.length) this.syncSubscription(subscription, [...pending.values()].includes("upstream_reconnected") ? "upstream_reconnected" : "baseline_ready", networks);
   }
  }, 200);
 }
 private requestSync(networkId: string): void {
  this.forceNetworks.add(networkId); this.quietPolls = 0;
  if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.ensurePolling();
 }
 private ensurePolling(): void { if (!this.polling && !this.timer && this.subscriptions.size) void this.poll(); }
 private async poll(): Promise<void> {
  if (this.polling || !this.subscriptions.size) return;
  this.polling = true; const generation = this.generation, forced = new Set(this.forceNetworks); this.forceNetworks.clear();
  const records = [...this.uniqueWatches().entries()].map(([key, watch]) => ({ key, watch, caip: nativeCaip.get(watch.networkId)! }))
   .filter(r => canPollHistory(r.watch.networkId))
   .filter(r => !this.feed?.covers(r.watch) || forced.has(r.watch.networkId) || !this.snapshots.has(r.key) || [...this.subscriptions.values()].some(s => s.catchup.has(r.key)));
  // EVM subscriptions retain push routing, but never start a Zerion history loop.
  if (!records.length) { this.polling = false; return; }
  const batches = records.map(record => [record]);
  let changed = false;
  for (const batch of batches) {
   if (generation !== this.generation) break;
   try {
    const result: any = await providerContext.run({ source: "realtime_poll" }, () => this.history.getTransactionHistory({ queries: batch.map(r => ({ caip: r.caip, pubkey: r.watch.address })) }, { forceRefresh: true }));
    if (generation !== this.generation) break;
    const histories = Array.isArray(result?.histories) ? result.histories : [];
    batch.forEach((record, index) => {
     if (!Array.isArray(histories[index]?.transactions)) return; // Failed reads are not empty snapshots.
     const transactions = histories[index].transactions.slice(0, MAX_SEEN);
     if (this.diffAndEmit(record.key, record.watch, transactions)) changed = true;
    });
   } catch { /* Bounded active fallback retries; never log wallet identifiers. */ }
  }
  this.polling = false;
  if (!this.subscriptions.size) return;
  if (generation !== this.generation || this.forceNetworks.size) { this.ensurePolling(); return; }
  this.quietPolls = changed ? 0 : this.quietPolls + 1;
  // Active polling fallback stays at a bounded cadence; healthy UTXO streams
  // skip those HTTP reads and deliver their own address/block notifications.
  this.timer = setTimeout(() => { this.timer = undefined; void this.poll(); }, this.intervalMs);
 }
 private diffAndEmit(key: string, watch: WatchAddress, transactions: any[]): boolean {
  const previous = this.snapshots.get(key), current = new Map<string, string>(); let changed = false;
  for (const tx of transactions) if (typeof tx?.txid === "string" && tx.txid) current.set(tx.txid, String(tx.status || "pending"));
  this.snapshots.set(key, current);
  if (!previous) this.scheduleSync(watch.networkId, "baseline_ready");
  for (const tx of transactions) {
   if (typeof tx?.txid !== "string" || !tx.txid) continue;
   const oldStatus = previous?.get(tx.txid);
   if (previous && !oldStatus) { this.emit(watch, "tx:incoming", tx.txid, "history"); changed = true; }
   if (previous && oldStatus !== "confirmed" && tx.status === "confirmed") { this.emit(watch, "tx:confirmed", tx.txid, "history"); changed = true; }
   for (const subscription of this.subscriptions.values()) if (subscription.catchup.has(key) && subscription.since !== undefined) {
    const rawTime = Number(tx.timestamp), timestamp = rawTime < 1e12 ? rawTime * 1000 : rawTime;
    if (Number.isFinite(timestamp) && timestamp >= subscription.since && timestamp <= Date.now() + 60_000) {
     this.deliver(subscription, watch, "tx:incoming", tx.txid, "reconnect-catchup");
     if (tx.status === "confirmed") this.deliver(subscription, watch, "tx:confirmed", tx.txid, "reconnect-catchup");
    }
   }
  }
  for (const subscription of this.subscriptions.values()) subscription.catchup.delete(key);
  return changed;
 }
 private emit(watch: WatchAddress, event: EventName, txid: string | undefined, reason: string): void {
  for (const subscription of this.subscriptions.values()) this.deliver(subscription, watch, event, txid, reason);
 }
 private deliver(subscription: Subscription, watch: WatchAddress, event: EventName, txid: string | undefined, reason: string, replayCursor?: string): void {
  if (!subscription.events.has(event) || !subscription.addresses.some(w => watchKey(w) === watchKey(watch))) return;
  const eventId = createHash("sha256").update(`${watchKey(watch)}:${txid || Math.floor(Date.now() / 2_000)}:${event}`).digest("hex");
  if (subscription.sent.has(eventId)) return;
  subscription.sent.add(eventId); while (subscription.sent.size > 1000) subscription.sent.delete(subscription.sent.values().next().value!);
  const data = { address: watch.address, watchAddress: watch.address, networkId: watch.networkId, ...(txid ? { txid } : {}), eventId,
   cursor: Date.now(), ...(replayCursor ? { replayCursor, walletScope: subscription.walletScope } : {}), refreshHint: true, reason, type: event === "tx:confirmed" ? "confirmation_update" : "activity" };
  try { subscription.send(event, data); } catch { return; }
  // Keep the legacy listener, but only on the connection that owns this watch.
  if ([...this.subscriptions.entries()].some(([id, s]) => s === subscription && id.startsWith("socket:"))) {
   try { subscription.send("transaction:incoming", data); } catch {}
  }
 }
}
export function validateAddresses(raw: unknown): { addresses: WatchAddress[]; unsupported: string[] } {
 if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_ADDRESSES) throw new RealtimeError(`addresses must contain between 1 and ${MAX_ADDRESSES} entries`);
 const addresses = new Map<string, WatchAddress>(), unsupported = new Set<string>();
 for (const item of raw) {
  const address = typeof item?.address === "string" ? item.address.trim() : "", networkId = typeof item?.networkId === "string" ? item.networkId.trim() : "";
  if (!address || address.length > 512 || /\s/.test(address)) throw new RealtimeError("Each address requires a supported networkId and non-empty address");
  if (!nativeCaip.has(networkId)) { unsupported.add(networkId); continue; }
  addresses.set(watchKey({ address, networkId }), { address, networkId });
 }
 if (!addresses.size) throw new RealtimeError("Each address requires a supported networkId and non-empty address");
 return { addresses: [...addresses.values()], unsupported: [...unsupported] };
}
function validateEvents(raw: unknown): Set<EventName> {
 if (!Array.isArray(raw) || !raw.length) return new Set(["tx:incoming", "tx:confirmed"]);
 const result = new Set<EventName>(); for (const event of raw) { if (event !== "tx:incoming" && event !== "tx:confirmed") throw new RealtimeError(`Unsupported event: ${String(event)}`); result.add(event); } return result;
}
function validateSince(raw: unknown): number | undefined {
 if (raw === undefined || raw === null) return undefined;
 if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0 || raw > Date.now() + 60_000) throw new RealtimeError("since must be an epoch-millisecond cursor");
 return Math.max(raw, Date.now() - 24 * 60 * 60_000);
}
