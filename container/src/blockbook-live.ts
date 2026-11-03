import type { UtxoClient } from "./utxo";
import { watchKey, type WatchAddress } from "./realtime-watch";
export interface LiveSocket {
 readyState: number; send(data: string): void; close(): void;
 addEventListener(event: string, listener: (event: any) => void): void;
}
export interface LiveWatchFeed {
 replace(watches: WatchAddress[]): void;
 covers(watch: WatchAddress): boolean;
 close(): void;
}
interface Callbacks {
 change(watch: WatchAddress, txid?: string, confirmed?: boolean): void;
 sync(networkId: string, reason: "upstream_reconnected" | "new_block"): void;
}
interface NetworkState {
 networkId: string; socket?: LiveSocket; retry?: ReturnType<typeof setTimeout>; ping?: ReturnType<typeof setInterval>;
 timeout?: ReturnType<typeof setTimeout>; attempts: number; connected: boolean; stopped: boolean;
 pongTimeout?: ReturnType<typeof setTimeout>;
 leaves: Map<string, WatchAddress[]>; covered: Set<string>; addressId: string; blockId: string; revision: number;
}
const KEY = /^(?:xpub|ypub|zpub|tpub|upub|vpub|Ltub|Mtub|dgub|drkp)|^tr\(/;
const MAX_LEAVES = 500;
/** One lazy upstream socket per watched UTXO network. Account keys are resolved
 * to derived leaf addresses; unresolved/over-limit accounts remain on polling. */
export class BlockbookLiveFeed implements LiveWatchFeed {
 private states = new Map<string, NetworkState>();
 private generation = 0;
 constructor(private readonly utxo: Pick<UtxoClient, "getPubkeyInfo" | "websocketEndpoint">,
  private readonly callbacks: Callbacks,
  private readonly options: { socket?: (url: string) => LiveSocket; retryMs?: number; timeoutMs?: number; pingMs?: number } = {}) {}
 replace(watches: WatchAddress[]): void {
  const generation = ++this.generation;
  const groups = new Map<string, WatchAddress[]>();
  for (const watch of watches) if (watch.networkId.startsWith("bip122:")) {
   const group = groups.get(watch.networkId) || []; group.push(watch); groups.set(watch.networkId, group);
  }
  for (const [network, state] of this.states) if (!groups.has(network)) { this.stop(state); this.states.delete(network); }
  for (const [network, group] of groups) {
   let state = this.states.get(network);
   if (!state) { state = { networkId: network, attempts: 0, connected: false, stopped: false, leaves: new Map(), covered: new Set(), addressId: "", blockId: "", revision: 0 }; this.states.set(network, state); }
   const current = state;
   void this.resolve(group).then(({ leaves, covered }) => {
    if (generation !== this.generation || this.states.get(network) !== current || current.stopped) return;
    current.leaves = leaves; current.covered = covered;
    if (!leaves.size) { this.stop(current); this.states.delete(network); return; }
    if (current.socket?.readyState === 1) this.subscribe(current);
    else if (!current.socket && !current.retry) this.connect(current);
   }).catch(() => {}); // Poll fallback is already active; never log wallet data.
  }
 }
 covers(watch: WatchAddress): boolean {
  const state = this.states.get(watch.networkId); return !!state?.connected && state.covered.has(watchKey(watch));
 }
 close(): void { this.generation++; for (const state of this.states.values()) this.stop(state); this.states.clear(); }
 private async resolve(watches: WatchAddress[]): Promise<{ leaves: Map<string, WatchAddress[]>; covered: Set<string> }> {
  const leaves = new Map<string, WatchAddress[]>(), covered = new Set<string>();
  for (const watch of watches) {
   let addresses: string[];
   if (KEY.test(watch.address)) {
    try { const info = await this.utxo.getPubkeyInfo(watch.networkId, watch.address, { forceRefresh: true });
     addresses = [...new Set<string>((Array.isArray(info?.tokens) ? info.tokens : []).map((token: any) => token?.name).filter((address: any) => typeof address === "string" && address.length <= 128 && !/\s/.test(address) && !KEY.test(address)))];
    } catch { continue; }
   } else addresses = [watch.address];
   if (!addresses.length || new Set([...leaves.keys(), ...addresses]).size > MAX_LEAVES) continue;
   for (const address of addresses) { const owners = leaves.get(address) || []; owners.push(watch); leaves.set(address, owners); }
   covered.add(watchKey(watch));
  }
  return { leaves, covered };
 }
 private connect(state: NetworkState): void {
  if (state.stopped || !state.leaves.size) return;
  let url: string | null;
  try { url = this.utxo.websocketEndpoint(state.networkId); } catch { return; }
  if (!url) return;
  let socket: LiveSocket;
  try { socket = (this.options.socket || (url => new WebSocket(url)))(url); } catch { this.retry(state); return; }
  state.socket = socket; state.connected = false;
  state.timeout = setTimeout(() => this.failed(state, socket), this.options.timeoutMs ?? 8_000);
  socket.addEventListener("open", () => { if (this.current(state, socket)) this.subscribe(state); });
  socket.addEventListener("message", (event: any) => {
   if (!this.current(state, socket)) return;
   try {
    const message = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8"));
    if (message.id === "ping" && state.pongTimeout) { clearTimeout(state.pongTimeout); state.pongTimeout = undefined; }
    if (message.data?.error) { this.failed(state, socket); return; }
    if (message.id === state.addressId && message.data?.subscribed === true) {
     state.connected = true; state.attempts = 0; if (state.timeout) clearTimeout(state.timeout); state.timeout = undefined;
     if (state.ping) clearInterval(state.ping);
     state.ping = setInterval(() => {
      try {
       socket.send(JSON.stringify({ id: "ping", method: "ping", params: {} }));
       if (!state.pongTimeout) state.pongTimeout = setTimeout(() => this.failed(state, socket), this.options.timeoutMs ?? 8_000);
      } catch { this.failed(state, socket); }
     }, this.options.pingMs ?? 20_000);
     this.callbacks.sync(state.networkId, "upstream_reconnected");
    } else if (message.id === state.addressId && typeof message.data?.address === "string") {
     const owners = state.leaves.get(message.data.address); if (!owners) return;
     const tx = message.data.tx || {}, hash = typeof tx.txid === "string" && /^[0-9a-f]{64}$/i.test(tx.txid) ? tx.txid : undefined;
     for (const owner of owners) this.callbacks.change(owner, hash, Number(tx.confirmations) > 0 || Number(tx.blockHeight) > 0);
    } else if (message.id === state.blockId && Number.isInteger(message.data?.height)) this.callbacks.sync(state.networkId, "new_block");
   } catch { /* Invalid upstream frames are not payment evidence. */ }
  });
  socket.addEventListener("error", () => this.failed(state, socket));
  socket.addEventListener("close", () => this.failed(state, socket));
 }
 private current(state: NetworkState, socket: LiveSocket): boolean { return !state.stopped && this.states.get(state.networkId) === state && state.socket === socket; }
 private subscribe(state: NetworkState): void {
  const socket = state.socket; if (!socket || socket.readyState !== 1) return;
  state.connected = false; const revision = ++state.revision;
  if (state.timeout) clearTimeout(state.timeout);
  state.timeout = setTimeout(() => this.failed(state, socket), this.options.timeoutMs ?? 8_000);
  state.addressId = `addresses-${revision}`; state.blockId = `blocks-${revision}`;
  try {
   socket.send(JSON.stringify({ id: state.addressId, method: "subscribeAddresses", params: { addresses: [...state.leaves.keys()] } }));
   socket.send(JSON.stringify({ id: state.blockId, method: "subscribeNewBlock", params: {} }));
  } catch { this.failed(state, socket); }
 }
 private failed(state: NetworkState, socket: LiveSocket): void {
  if (!this.current(state, socket)) return;
  state.socket = undefined; state.connected = false;
  if (state.timeout) clearTimeout(state.timeout); if (state.ping) clearInterval(state.ping);
  if (state.pongTimeout) clearTimeout(state.pongTimeout); state.pongTimeout = undefined;
  state.timeout = undefined; state.ping = undefined; try { socket.close(); } catch {}
  this.retry(state);
 }
 private retry(state: NetworkState): void {
  if (state.stopped || state.retry || !state.leaves.size) return;
  const delay = Math.min(30_000, (this.options.retryMs ?? 1_000) * 2 ** Math.min(state.attempts++, 5));
  state.retry = setTimeout(() => { state.retry = undefined; this.connect(state); }, delay);
 }
 private stop(state: NetworkState): void {
  state.stopped = true; state.connected = false;
  if (state.retry) clearTimeout(state.retry); if (state.timeout) clearTimeout(state.timeout); if (state.ping) clearInterval(state.ping);
  if (state.pongTimeout) clearTimeout(state.pongTimeout);
  const socket = state.socket; state.socket = undefined; try { socket?.close(); } catch {}
 }
}
