import type { PersistentCache } from "./cache";
import { DemandCache } from "./demand-cache";
import { formatUnits } from "./evm";
import { createHash } from "node:crypto";

const THORCHAIN_MIDGARD = { url: "https://gateway.liquify.com/chain/thorchain_midgard", asset: "THOR.RUNE" };

const COSMOS: Readonly<Record<string, { endpoints: readonly string[]; denom: string; decimals: number; midgard?: { url: string; asset: string } }>> = {
	// Keplr's Cosmos Hub LCD currently returns HTTP 200 with an empty result for
	// known indexed message.sender queries. An empty 200 is indistinguishable
	// from real inactivity, so history uses the two mirrors that retain the index.
	"cosmos:cosmoshub-4": { endpoints: ["https://rest.cosmos.directory/cosmoshub", "https://cosmos-rest.publicnode.com"], denom: "uatom", decimals: 6 },
	// THORChain LCDs never answer transfer.recipient queries (both mirrors hang),
	// so RUNE sends come from Midgard's indexed send actions instead.
	"cosmos:thorchain-mainnet-v1": { endpoints: ["https://rest.cosmos.directory/thorchain", "https://gateway.liquify.com/chain/thorchain_api"], denom: "rune", decimals: 8, midgard: THORCHAIN_MIDGARD },
	"cosmos:thorchain-1": { endpoints: ["https://rest.cosmos.directory/thorchain", "https://gateway.liquify.com/chain/thorchain_api"], denom: "rune", decimals: 8, midgard: THORCHAIN_MIDGARD },
	// Every MayaChain LCD tx index is unusable (403 or timeout), so history is
	// Midgard-only: CACAO sends in both directions; swaps are not included.
	"cosmos:mayachain-mainnet-v1": { endpoints: [], denom: "cacao", decimals: 10, midgard: { url: "https://midgard.mayachain.info", asset: "MAYA.CACAO" } },
	"cosmos:osmosis-1": { endpoints: ["https://lcd-osmosis.keplr.app", "https://rest.cosmos.directory/osmosis", "https://osmosis-rest.publicnode.com"], denom: "uosmo", decimals: 6 },
};

export class ChainHistoryError extends Error {
	constructor(message: string, public readonly status = 502) { super(message); }
}

export class ChainHistoryClient {
	private readonly cache: DemandCache;
	private requestId = 0;
	constructor(private readonly options: { apiKey: string; cache: PersistentCache; fetch?: typeof fetch }) {
		this.cache = new DemandCache(options.cache, 1_000);
	}

	async getTransactionHistory(caip: string, address: string, page = 1): Promise<Record<string, unknown>[]> {
		const networkId = caip.split("/")[0];
		if (!address.trim() || address.length > 512) throw new ChainHistoryError("Invalid history address", 400);
		return this.cache.get({ namespace: "chain_history_v2", key: `${networkId}:${address}:${page}`, freshForMs: 15_000, staleForMs: 5 * 60_000, source: "chain-history" }, async () => {
			if (COSMOS[networkId]) return this.cosmos(networkId, address, page);
			if (networkId.startsWith("ripple:")) return this.xrp(networkId, address, page);
			if (networkId.startsWith("solana:")) return this.solana(networkId, address, page);
			if (networkId.startsWith("tron:")) return this.tron(networkId, address, page);
			if (networkId.startsWith("ton:")) return this.ton(networkId, address, page);
			throw new ChainHistoryError(`Unsupported transaction-history network: ${networkId}`, 422);
		});
	}

	private async cosmos(networkId: string, address: string, page: number): Promise<Record<string, unknown>[]> {
		const chain = COSMOS[networkId];
		const query = async (event: string): Promise<any> => {
			const expression = `${event}='${address}'`;
			// SDK 0.50 replaced the repeated `events` field with `query`, and
			// page/limit replaced the deprecated pagination object. THORChain and
			// MayaChain nodes can still expose the older gateway, so retain both.
			const modern = new URLSearchParams({ query: expression, limit: "50", order_by: "ORDER_BY_DESC" });
			// Cosmos Hub currently returns an empty set when page=1 is supplied even
			// though the same query without it returns the first page.
			if (page > 1) modern.set("page", String(page));
			try {
				return await getAcross(this.fetcher, chain.endpoints, `/cosmos/tx/v1beta1/txs?${modern}`);
			} catch {
				const legacy = new URLSearchParams({ events: expression, "pagination.limit": "50", "pagination.offset": String((page - 1) * 50), order_by: "ORDER_BY_DESC" });
				return getAcross(this.fetcher, chain.endpoints, `/cosmos/tx/v1beta1/txs?${legacy}`);
			}
		};
		const midgardSends = async (): Promise<any> => {
			const params = new URLSearchParams({ address, type: "send", limit: "50", offset: String((page - 1) * 50) });
			return getAcross(this.fetcher, [chain.midgard!.url], `/v2/actions?${params}`);
		};
		const [sent, received] = await Promise.all([chain.endpoints.length ? query("message.sender") : null, chain.midgard ? midgardSends() : query("transfer.recipient")]);
		const byHash = new Map<string, Record<string, unknown>>();
		for (const action of array(received?.actions)) {
			const tx = normalizeMidgardSend(address, networkId, chain.midgard!.asset, chain.decimals, action);
			if (tx) byHash.set(String(tx.txid), tx);
		}
		for (const body of [sent, received]) {
			const txs = array(body?.txs);
			for (const [index, rawResponse] of array(body?.tx_responses).entries()) {
				const tx = normalizeCosmos(address, networkId, chain.denom, chain.decimals, txs[index], rawResponse);
				if (tx) byHash.set(String(tx.txid), tx);
			}
		}
		return [...byHash.values()].sort((left: any, right: any) => Number(right.timestamp || 0) - Number(left.timestamp || 0));
	}

	private async xrp(networkId: string, address: string, page: number): Promise<Record<string, unknown>[]> {
		if (page > 1) return [];
		const body = await this.rpc("https://xrp.nownodes.io/", { method: "account_tx", params: [{ account: address, ledger_index_min: -1, ledger_index_max: -1, limit: 50, forward: false }] });
		if (body?.result?.error) throw new ChainHistoryError(`XRP account_tx failed: ${body.result.error_message || body.result.error}`);
		return array(body?.result?.transactions).map((entry: any) => normalizeXrp(address, networkId, entry)).filter(nonNull);
	}

	private async solana(networkId: string, address: string, page: number): Promise<Record<string, unknown>[]> {
		if (page > 1) return [];
		const id = ++this.requestId;
		const body = await this.rpc("https://sol.nownodes.io/", { jsonrpc: "2.0", id, method: "getSignaturesForAddress", params: [address, { limit: 50, commitment: "confirmed" }] });
		if (body?.error || !Array.isArray(body?.result)) throw new ChainHistoryError(`Solana history failed: ${body?.error?.message || "invalid result"}`);
		return body.result.map((entry: any) => ({ txid: String(entry.signature), networkId, direction: "self", type: "transfer", status: entry.err ? "failed" : "confirmed", blockHeight: Number(entry.slot || 0), timestamp: Number(entry.blockTime || 0), from: [address], to: [], value: "0", ...(entry.memo ? { memo: entry.memo } : {}) }));
	}

	private async tron(networkId: string, address: string, page: number): Promise<Record<string, unknown>[]> {
		const params = new URLSearchParams({ only_confirmed: "true", limit: "50", order_by: "block_timestamp,desc", min_block_timestamp: "0" });
		if (page > 1) return [];
		// A java-tron full node does not index history by account. NowNodes serves
		// the full-node API at trx.nownodes.io, so forwarding TronGrid's /v1 path
		// there returns 404. Use TRON's official demand-only index endpoint for
		// history; current-state and broadcast operations remain on NowNodes.
		const response = await this.fetcher(`https://api.trongrid.io/v1/accounts/${encodeURIComponent(address)}/transactions?${params}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
		const body = await response.json().catch(() => null) as any;
		if (!response.ok || !Array.isArray(body?.data)) throw new ChainHistoryError(`TRON history failed (${response.status})`);
		return body.data.map((entry: any) => normalizeTron(address, networkId, entry)).filter(Boolean);
	}

	private async ton(networkId: string, address: string, page: number): Promise<Record<string, unknown>[]> {
		const params = new URLSearchParams({ address, limit: "50", archival: "true" });
		if (page > 1) return [];
		// NOWNodes' TON v2 gateway intermittently answers getTransactions with 500;
		// toncenter serves the same v2 API keyless, so it is the fallback.
		const failures: string[] = [];
		for (const [base, headers] of [["https://ton.nownodes.io", this.headers()], ["https://toncenter.com", { Accept: "application/json" }]] as const) {
			try {
				const response = await this.fetcher(`${base}/api/v2/getTransactions?${params}`, { headers, signal: AbortSignal.timeout(12_000) });
				const body = await response.json().catch(() => null) as any;
				if (!response.ok || body?.ok === false || !Array.isArray(body?.result ?? body)) {
					failures.push(`${new URL(base).host} ${response.status}${body?.error ? ` ${String(body.error).slice(0, 80)}` : ""}`);
					continue;
				}
				return array(body?.result ?? body).map((entry: any) => normalizeTon(address, networkId, entry)).filter(nonNull);
			} catch (error) {
				failures.push(`${new URL(base).host} ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		throw new ChainHistoryError(`TON history failed: ${failures.join("; ")}`);
	}

	private get fetcher(): typeof fetch { return this.options.fetch || fetch; }
	private headers(): Record<string, string> { return { Accept: "application/json", "Content-Type": "application/json", "api-key": this.options.apiKey }; }
	private async rpc(endpoint: string, payload: unknown): Promise<any> {
		const response = await this.fetcher(endpoint, { method: "POST", headers: this.headers(), body: JSON.stringify(payload), signal: AbortSignal.timeout(12_000) });
		const body = await response.json().catch(() => null);
		if (!response.ok) throw new ChainHistoryError(`History RPC failed (${response.status})`);
		return body;
	}
}

function normalizeCosmos(address: string, networkId: string, denom: string, decimals: number, tx: any, response: any): Record<string, unknown> | null {
	const txid = String(response?.txhash || "");
	if (!txid) return null;
	const messages = array(tx?.body?.messages);
	const flattened = messages.flatMap((message: any) => [message, ...array(message?.msgs)]);
	const message = flattened.find((candidate: any) => candidate?.from_address === address || candidate?.sender === address || candidate?.signer === address || candidate?.to_address === address || candidate?.receiver === address) || flattened[0] || {};
	const from = String(message.from_address || message.sender || message.signer || "");
	const to = String(message.to_address || message.receiver || "");
	const coins = array(message.amount || message.coins);
	const coin = coins.find((candidate: any) => candidate?.denom === denom) || coins[0];
	const rawAmount = typeof coin?.amount === "string" && /^\d+$/.test(coin.amount) ? coin.amount : "0";
	const feeCoin = array(tx?.auth_info?.fee?.amount).find((candidate: any) => candidate?.denom === denom);
	const direction = from === address ? (to === address ? "self" : "sent") : "received";
	return { txid, networkId, direction, type: String(message["@type"] || "transfer").split(".").pop()?.replace(/^Msg/, "").toLowerCase() || "transfer", status: Number(response?.code || 0) === 0 ? "confirmed" : "failed", blockHeight: Number(response?.height || 0), timestamp: Math.floor(Date.parse(String(response?.timestamp || "")) / 1000) || 0, from: from ? [from] : [], to: to ? [to] : [], value: formatUnits(BigInt(rawAmount), decimals), ...(feeCoin?.amount && /^\d+$/.test(feeCoin.amount) ? { fee: formatUnits(BigInt(feeCoin.amount), decimals) } : {}) };
}

function normalizeMidgardSend(address: string, networkId: string, asset: string, decimals: number, action: any): Record<string, unknown> | null {
	const input = array(action?.in)[0];
	const txid = String(input?.txID || "");
	if (!txid) return null;
	const from = String(input?.address || "");
	const to = String(array(action?.out)[0]?.address || "");
	const coin = array(input?.coins).find((candidate: any) => candidate?.asset === asset);
	const rawAmount = typeof coin?.amount === "string" && /^\d+$/.test(coin.amount) ? coin.amount : "0";
	// Midgard dates are nanoseconds since the epoch.
	return { txid, networkId, direction: from === address ? (to === address ? "self" : "sent") : "received", type: "send", status: action?.status === "success" ? "confirmed" : "failed", blockHeight: Number(action?.height || 0), timestamp: Math.floor(Number(action?.date || 0) / 1e9), from: from ? [from] : [], to: to ? [to] : [], value: formatUnits(BigInt(rawAmount), decimals) };
}

function normalizeXrp(address: string, networkId: string, entry: any): Record<string, unknown> | null {
	const tx = entry?.tx || entry?.tx_json || entry || {};
	const txid = String(tx.hash || entry?.hash || "");
	if (!txid) return null;
	const from = String(tx.Account || "");
	const to = String(tx.Destination || "");
	const rawAmount = typeof tx.Amount === "string" && /^\d+$/.test(tx.Amount) ? tx.Amount : "0";
	const rippleTime = Number(tx.date || 0);
	return { txid, networkId, direction: from === address ? (to === address ? "self" : "sent") : "received", type: String(tx.TransactionType || "Payment").toLowerCase(), status: entry?.validated === false || entry?.meta?.TransactionResult && entry.meta.TransactionResult !== "tesSUCCESS" ? "failed" : "confirmed", blockHeight: Number(tx.ledger_index || entry?.ledger_index || 0), timestamp: rippleTime > 0 ? rippleTime + 946_684_800 : 0, from: from ? [from] : [], to: to ? [to] : [], value: formatUnits(BigInt(rawAmount), 6), ...(typeof tx.Fee === "string" && /^\d+$/.test(tx.Fee) ? { fee: formatUnits(BigInt(tx.Fee), 6) } : {}) };
}

function normalizeTron(address: string, networkId: string, entry: any): Record<string, unknown> | null {
	const contract = entry?.raw_data?.contract?.[0];
	const value = contract?.parameter?.value || {};
	const txid = String(entry?.txID || "");
	if (!txid) return null;
	const from = normalizeTronAddress(value.owner_address);
	const to = normalizeTronAddress(value.to_address || value.contract_address);
	const amount = /^\d+$/.test(String(value.amount || "")) ? String(value.amount) : "0";
	return { txid, networkId, direction: from === address ? (to === address ? "self" : "sent") : "received", type: String(contract?.type || "transfer").replace(/Contract$/, "").toLowerCase(), status: entry?.ret?.[0]?.contractRet === "SUCCESS" ? "confirmed" : "failed", blockHeight: Number(entry?.blockNumber || 0), timestamp: Math.floor(Number(entry?.block_timestamp || entry?.raw_data?.timestamp || 0) / 1000), from: from ? [from] : [], to: to ? [to] : [], value: formatUnits(BigInt(amount), 6), fee: formatUnits(BigInt(String(entry?.fee || "0")), 6) };
}

function normalizeTronAddress(raw: unknown): string {
	const value = String(raw || "");
	if (!/^41[a-fA-F0-9]{40}$/.test(value)) return value;
	const payload = Buffer.from(value, "hex");
	const first = createHash("sha256").update(payload).digest();
	const checksum = createHash("sha256").update(first).digest().subarray(0, 4);
	return base58(Buffer.concat([payload, checksum]));
}

function base58(bytes: Uint8Array): string {
	const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
	let number = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
	let output = "";
	while (number > 0n) {
		const remainder = Number(number % 58n);
		output = alphabet[remainder] + output;
		number /= 58n;
	}
	for (const byte of bytes) {
		if (byte !== 0) break;
		output = `1${output}`;
	}
	return output || "1";
}

function normalizeTon(address: string, networkId: string, entry: any): Record<string, unknown> | null {
	const txid = String(entry?.transaction_id?.hash || entry?.hash || "");
	if (!txid) return null;
	const inbound = entry?.in_msg || {};
	const outbound = array(entry?.out_msgs)[0] || {};
	const from = String(inbound?.source || "");
	const received = String(inbound?.destination || "") === address;
	const to = received ? address : String(outbound?.destination || "");
	const amount = String((received ? inbound?.value : outbound?.value) || "0");
	return { txid, networkId, direction: received ? "received" : "sent", type: "transfer", status: entry?.description?.aborted ? "failed" : "confirmed", blockHeight: Number(entry?.transaction_id?.lt || 0), timestamp: Number(entry?.utime || 0), from: from ? [from] : [address], to: to ? [to] : [], value: /^\d+$/.test(amount) ? formatUnits(BigInt(amount), 9) : "0", fee: formatUnits(BigInt(String(entry?.fee || 0)), 9) };
}

async function getAcross(fetcher: typeof fetch, endpoints: readonly string[], path: string): Promise<any> {
	let last: unknown;
	for (const endpoint of endpoints) {
		try {
			const response = await fetcher(`${endpoint}${path}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return await response.json();
		} catch (error) { last = error; }
	}
	throw new ChainHistoryError(`All history endpoints failed: ${last instanceof Error ? last.message : String(last)}`);
}

function array(raw: unknown): any[] { return Array.isArray(raw) ? raw : []; }
function nonNull<T>(value: T | null): value is T { return value !== null; }
