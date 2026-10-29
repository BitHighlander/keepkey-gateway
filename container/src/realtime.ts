import type { HistoryClient } from "./history";
import chains from "../data/chains.json";

const POLL_INTERVAL_MS = 30_000;
const MAX_ADDRESSES = 200;
const MAX_SEEN_PER_WATCH = 200;
const MAX_HISTORY_BATCH = 100;
const MAX_QUIET_MULTIPLIER = 10;
const nativeCaipByNetwork = new Map(Object.entries(chains as Record<string, any>).map(([networkId, chain]) => [networkId, String(chain.nativeAssetCaip || "")]));

export interface WatchAddress { address: string; networkId: string }
type EventName = "tx:incoming" | "tx:confirmed";
type Sender = (event: string, data: Record<string, unknown>) => void;

interface Subscription {
	clientId: string;
	addresses: WatchAddress[];
	events: Set<EventName>;
	send: Sender;
}

export class RealtimeError extends Error {
	constructor(message: string, public readonly status = 400) { super(message); }
}

/**
 * One in-process event hub for SSE and Socket.IO. Upstream polling starts on
 * the first address subscription and is torn down on the last disconnect.
 */
export class RealtimeHub {
	private readonly subscriptions = new Map<string, Subscription>();
	private readonly socketSenders = new Map<string, Map<string, Sender>>();
	private readonly snapshots = new Map<string, Map<string, string>>();
	private timer?: ReturnType<typeof setTimeout>;
	private polling = false;
	private generation = 0;
	private quietPolls = 0;

	constructor(private readonly history: Pick<HistoryClient, "getTransactionHistory">, private readonly intervalMs = POLL_INTERVAL_MS) {}

	createSse(clientId: string, rawAddresses: unknown, rawEvents: unknown): Response {
		const { addresses, unsupported } = validateAddresses(rawAddresses);
		const events = validateEvents(rawEvents);
		const sessionId = crypto.randomUUID();
		const encoder = new TextEncoder();
		let heartbeat: ReturnType<typeof setInterval> | undefined;
		const stream = new ReadableStream<Uint8Array>({
			start: (controller) => {
				const send: Sender = (event, data) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
				this.subscriptions.set(sessionId, { clientId, addresses, events, send });
				send("connected", { sessionId, watching: addresses.length, ...(unsupported.length ? { unsupported } : {}) });
				heartbeat = setInterval(() => {
					try { controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`)); } catch { this.removeSubscription(sessionId); }
				}, 20_000);
				this.ensurePolling();
			},
			cancel: () => {
				if (heartbeat) clearInterval(heartbeat);
				this.removeSubscription(sessionId);
			},
		});
		return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
	}

	addSocket(clientId: string, socketId: string, send: Sender): void {
		const sockets = this.socketSenders.get(clientId) || new Map<string, Sender>();
		sockets.set(socketId, send);
		this.socketSenders.set(clientId, sockets);
	}

	removeSocket(clientId: string | undefined, socketId: string): void {
		if (!clientId) return;
		const sockets = this.socketSenders.get(clientId);
		if (!sockets) return;
		sockets.delete(socketId);
		if (sockets.size === 0) this.socketSenders.delete(clientId);
	}

	activeAddressCount(): number { return this.uniqueWatches().size; }
	activeSubscriptionCount(): number { return this.subscriptions.size; }

	private removeSubscription(sessionId: string): void {
		this.subscriptions.delete(sessionId);
		if (this.subscriptions.size === 0) {
			this.generation++;
			if (this.timer) clearTimeout(this.timer);
			this.timer = undefined;
			this.snapshots.clear();
			this.quietPolls = 0;
		}
	}

	private ensurePolling(): void {
		if (this.polling || this.timer || this.subscriptions.size === 0) return;
		const generation = this.generation;
		void this.poll(generation);
	}

	private async poll(generation: number): Promise<void> {
		if (generation !== this.generation || this.subscriptions.size === 0 || this.polling) return;
		this.polling = true;
		const watches = this.uniqueWatches();
		const records = [...watches.entries()].flatMap(([key, watch]) => {
			const caip = nativeCaipByNetwork.get(watch.networkId);
			return caip ? [{ key, watch, caip }] : [];
		});
		const evmRecords = records.filter(({ watch }) => watch.networkId.startsWith("eip155:"));
		const isolatedRecords = records.filter(({ watch }) => !watch.networkId.startsWith("eip155:"));
		const batches = [
			...chunk(evmRecords, MAX_HISTORY_BATCH),
			...isolatedRecords.map((record) => [record]),
		];
		let changed = false;
		for (const batch of batches) {
			try {
				// One gateway history request batches every EVM network for the same
				// address into one Zerion call and retains one bounded call per other
				// chain. This is substantially cheaper than one internal request per
				// watch while preserving independent chain snapshots.
				const result = await this.history.getTransactionHistory({ queries: batch.map(({ caip, watch }) => ({ caip, pubkey: watch.address })) }) as any;
				const histories = Array.isArray(result?.histories) ? result.histories : [];
				batch.forEach((record, index) => {
					const transactions = Array.isArray(histories[index]?.transactions) ? histories[index].transactions.slice(0, MAX_SEEN_PER_WATCH) : [];
					if (this.diffAndEmit(record.key, record.watch, record.caip, transactions)) changed = true;
				});
			} catch (error) {
				console.warn(JSON.stringify({ event: "realtime_watch_batch_failed", watchCount: batch.length, error: error instanceof Error ? error.message : String(error) }));
			}
		}
		this.polling = false;
		if (generation === this.generation && this.subscriptions.size > 0) {
			this.quietPolls = changed ? 0 : this.quietPolls + 1;
			const multiplier = this.quietPolls <= 1 ? 1 : this.quietPolls === 2 ? 2 : this.quietPolls === 3 ? 4 : MAX_QUIET_MULTIPLIER;
			this.timer = setTimeout(() => { this.timer = undefined; void this.poll(generation); }, this.intervalMs * multiplier);
		}
	}

	private uniqueWatches(): Map<string, WatchAddress> {
		const result = new Map<string, WatchAddress>();
		for (const subscription of this.subscriptions.values()) {
			for (const watch of subscription.addresses) result.set(watchKey(watch), watch);
		}
		return result;
	}

	private diffAndEmit(key: string, watch: WatchAddress, caip: string, transactions: any[]): boolean {
		const previous = this.snapshots.get(key);
		const current = new Map<string, string>();
		for (const tx of transactions) {
			const txid = String(tx?.txid || "");
			if (txid) current.set(txid, String(tx?.status || "confirmed"));
		}
		this.snapshots.set(key, current);
		if (!previous) return false; // establish a baseline; never replay old activity
		let changed = false;
		for (const tx of transactions) {
			const txid = String(tx?.txid || "");
			if (!txid) continue;
			const oldStatus = previous.get(txid);
			if (!oldStatus) {
				changed = true;
				this.emit(watch, "tx:incoming", { address: watch.address, networkId: watch.networkId, caip, txid, value: String(tx?.value || "0"), from: Array.isArray(tx?.from) ? tx.from[0] : undefined, type: tx?.direction === "sent" ? "outgoing" : "incoming" });
			}
			if ((!oldStatus && tx?.status === "confirmed") || (oldStatus === "pending" && tx?.status === "confirmed")) {
				changed = true;
				this.emit(watch, "tx:confirmed", { address: watch.address, networkId: watch.networkId, txid, confirmations: 1 });
			}
		}
		return changed;
	}

	private emit(watch: WatchAddress, event: EventName, data: Record<string, unknown>): void {
		for (const subscription of this.subscriptions.values()) {
			if (!subscription.events.has(event) || !subscription.addresses.some((candidate) => watchKey(candidate) === watchKey(watch))) continue;
			try { subscription.send(event, data); } catch { /* cancellation removes the subscription */ }
			const socketEvent = event === "tx:incoming" ? data : { ...data, type: "confirmation_update" };
			for (const send of this.socketSenders.get(subscription.clientId)?.values() || []) {
				try { send("transaction:incoming", socketEvent); } catch { /* close handler removes socket */ }
			}
		}
	}
}

// Wallets subscribe with every account they hold; networks this gateway cannot
// watch are skipped (and reported) rather than rejecting the whole stream.
function validateAddresses(raw: unknown): { addresses: WatchAddress[]; unsupported: string[] } {
	if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_ADDRESSES) throw new RealtimeError(`addresses must contain between 1 and ${MAX_ADDRESSES} entries`);
	const deduped = new Map<string, WatchAddress>();
	const unsupported = new Set<string>();
	for (const item of raw) {
		const address = typeof item?.address === "string" ? item.address.trim() : "";
		const networkId = typeof item?.networkId === "string" ? item.networkId.trim() : "";
		if (!address || address.length > 512) throw new RealtimeError("Each address requires a supported networkId and non-empty address");
		if (!nativeCaipByNetwork.has(networkId)) { unsupported.add(networkId); continue; }
		const watch = { address, networkId };
		deduped.set(watchKey(watch), watch);
	}
	if (deduped.size === 0) throw new RealtimeError("Each address requires a supported networkId and non-empty address");
	return { addresses: [...deduped.values()], unsupported: [...unsupported] };
}

function validateEvents(raw: unknown): Set<EventName> {
	if (!Array.isArray(raw) || raw.length === 0) return new Set(["tx:incoming", "tx:confirmed"]);
	const events = new Set<EventName>();
	for (const event of raw) {
		if (event !== "tx:incoming" && event !== "tx:confirmed") throw new RealtimeError(`Unsupported event: ${String(event)}`);
		events.add(event);
	}
	return events;
}

function watchKey(watch: WatchAddress): string { return `${watch.networkId}:${watch.address.toLowerCase()}`; }
function chunk<T>(items: T[], size: number): T[][] {
	const result: T[][] = [];
	for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
	return result;
}
