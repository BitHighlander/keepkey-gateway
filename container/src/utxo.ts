import { createHash } from "node:crypto";
import type { PersistentCache } from "./cache";
import { DemandCache } from "./demand-cache";

const REQUEST_TIMEOUT_MS = 15_000;
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const EXTENDED_KEY_PREFIXES = ["xpub", "ypub", "zpub", "tpub", "upub", "vpub", "dgub", "Ltub", "Mtub", "drkp"];
const VERSION_REMAP: Readonly<Record<string, string>> = {
	dgub: "0488b21e",
	Ltub: "0488b21e",
	Mtub: "049d7cb2",
	drkp: "0488b21e",
};

export interface UtxoNetwork {
	networkId: string;
	symbol: string;
	host: string;
}

const NETWORKS: readonly UtxoNetwork[] = [
	{ networkId: "bip122:000000000019d6689c085ae165831e93", symbol: "BTC", host: "btcbook.nownodes.io" },
	{ networkId: "bip122:000000000000000000651ef99cb9fcbe", symbol: "BCH", host: "bchbook.nownodes.io" },
	{ networkId: "bip122:000007d91d1254d60e2dd1ae58038307", symbol: "DASH", host: "dashbook.nownodes.io" },
	{ networkId: "bip122:00000000001a91e3dace36e2be3bf030", symbol: "DOGE", host: "dogebook.nownodes.io" },
	{ networkId: "bip122:12a765e31ffd4059bada1e25190f6e98", symbol: "LTC", host: "ltcbook.nownodes.io" },
	{ networkId: "bip122:4da631f2ac1bed857bd968c67c913978", symbol: "DGB", host: "dgbbook.nownodes.io" },
	{ networkId: "bip122:00040fe8ec8471911baa1db1266ea15d", symbol: "ZEC", host: "zecbook.nownodes.io" },
];
const SLIP44_BY_SYMBOL: Readonly<Record<string, number>> = { BTC: 0, LTC: 2, DOGE: 3, DASH: 5, DGB: 20, BCH: 145, ZEC: 133 };

interface UtxoClientOptions {
	apiKey: string;
	cache: PersistentCache;
	fetch?: typeof fetch;
	networks?: readonly UtxoNetwork[];
}

export class UtxoError extends Error {
	constructor(message: string, public readonly status = 502) {
		super(message);
	}
}

function sha256(value: Uint8Array): Buffer {
	return createHash("sha256").update(value).digest();
}

function decodeBase58(value: string): Buffer {
	let number = 0n;
	for (const character of value) {
		const index = BASE58_ALPHABET.indexOf(character);
		if (index < 0) throw new UtxoError("Invalid extended public key", 400);
		number = number * 58n + BigInt(index);
	}
	let hex = number.toString(16);
	if (hex.length % 2) hex = `0${hex}`;
	const decoded = number === 0n ? Buffer.alloc(0) : Buffer.from(hex, "hex");
	let leadingZeroes = 0;
	while (value[leadingZeroes] === "1") leadingZeroes++;
	return Buffer.concat([Buffer.alloc(leadingZeroes), decoded]);
}

function encodeBase58(value: Uint8Array): string {
	let number = BigInt(`0x${Buffer.from(value).toString("hex") || "0"}`);
	let encoded = "";
	while (number > 0n) {
		const remainder = Number(number % 58n);
		encoded = BASE58_ALPHABET[remainder] + encoded;
		number /= 58n;
	}
	let leadingZeroes = 0;
	while (value[leadingZeroes] === 0) leadingZeroes++;
	return "1".repeat(leadingZeroes) + encoded;
}

export function normalizeExtendedKeyVersion(value: string): string {
	const descriptor = /^tr\((.+)\)$/.exec(value);
	if (descriptor) return `tr(${normalizeExtendedKeyVersion(descriptor[1])})`;
	const target = VERSION_REMAP[value.slice(0, 4)];
	if (!target) return value;
	const decoded = decodeBase58(value);
	if (decoded.length !== 82) throw new UtxoError("Invalid extended public key length", 400);
	const payload = decoded.subarray(0, -4);
	const expectedChecksum = sha256(sha256(payload)).subarray(0, 4);
	if (!Buffer.from(decoded.subarray(-4)).equals(expectedChecksum)) throw new UtxoError("Invalid extended public key checksum", 400);
	const remapped = Buffer.concat([Buffer.from(target, "hex"), payload.subarray(4)]);
	const checksum = sha256(sha256(remapped)).subarray(0, 4);
	return encodeBase58(Buffer.concat([remapped, checksum]));
}

function isExtendedKey(value: string): boolean {
	return value.startsWith("tr(") || EXTENDED_KEY_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function txid(value: string): string {
	const normalized = value.replace(/^0x/i, "").toLowerCase();
	if (!/^[a-f0-9]{64}$/.test(normalized)) throw new UtxoError("Invalid transaction id", 400);
	return normalized;
}

function serializedTransaction(value: string): string {
	const normalized = value.replace(/^0x/i, "").toLowerCase();
	if (!normalized || normalized.length % 2 || !/^[a-f0-9]+$/.test(normalized) || normalized.length > 2_000_000) {
		throw new UtxoError("Invalid serialized transaction hex", 400);
	}
	return normalized;
}

function normalizeTransaction(raw: any): any {
	return {
		...raw,
		txid: raw?.txid,
		hash: raw?.txid,
		locktime: raw?.lockTime ?? raw?.locktime,
		vin: Array.isArray(raw?.vin) ? raw.vin.map((input: any) => ({
			...input,
			addr: input?.addr || input?.addresses?.[0],
			valueSat: input?.value == null ? undefined : Number(input.value),
			value: input?.value == null ? undefined : Number(input.value) / 100_000_000,
		})) : [],
		vout: Array.isArray(raw?.vout) ? raw.vout.map((output: any) => ({
			...output,
			scriptPubKey: output?.scriptPubKey || { hex: output?.hex },
		})) : [],
	};
}

export class UtxoClient {
	private readonly fetcher: typeof fetch;
	private readonly networks: readonly UtxoNetwork[];
	private readonly cache: DemandCache;

	constructor(private readonly options: UtxoClientOptions) {
		this.fetcher = options.fetch || fetch;
		this.networks = options.networks || NETWORKS;
		this.cache = new DemandCache(options.cache, 4_000);
	}

	resolveNetwork(value: string): UtxoNetwork {
		const normalized = value.toUpperCase();
		const network = this.networks.find((candidate) => candidate.networkId === value || candidate.symbol === normalized);
		if (!network) throw new UtxoError(`Unsupported UTXO network: ${value}`, 422);
		return network;
	}

	async getPubkeyInfo(networkValue: string, publicKey: string): Promise<any> {
		const network = this.resolveNetwork(networkValue);
		const normalized = normalizeExtendedKeyVersion(publicKey);
		if (!normalized || normalized.length > 512) throw new UtxoError("Invalid public key or address", 400);
		const route = isExtendedKey(normalized)
			? `xpub/${encodeURIComponent(normalized)}?details=tokens&tokens=derived&gap=20&page=1`
			: `address/${encodeURIComponent(this.cashAddress(network, normalized))}?details=txs&page=1`;
		return this.cache.get({ namespace: "utxo_pubkey", key: `${network.symbol}:${normalized}`, freshForMs: 15_000, staleForMs: 60_000, source: "nownodes-blockbook" }, async () => {
			const response = await this.request(network, route, {}, true);
			if (response === null) return { balance: "0", unconfirmedBalance: "0", totalReceived: "0", totalSent: "0", txs: 0, usedTokens: 0, tokens: [] };
			const body = response as any;
			if (!Array.isArray(body.tokens)) body.tokens = [];
			return body;
		});
	}

	async listUnspent(networkValue: string, publicKey: string): Promise<any[]> {
		const network = this.resolveNetwork(networkValue);
		const normalized = normalizeExtendedKeyVersion(publicKey);
		if (!normalized || normalized.length > 512) throw new UtxoError("Invalid public key or address", 400);
		return this.cache.get({ namespace: "utxo_set", key: `${network.symbol}:${normalized}`, freshForMs: 2_000, staleForMs: 2_000, source: "nownodes-blockbook" }, async () => {
			const inputs = await this.request(network, `utxo/${encodeURIComponent(this.cashAddress(network, normalized))}?gap=20&confirmed=false`);
			if (!Array.isArray(inputs)) throw new UtxoError("Blockbook returned an invalid UTXO set");
			const transactions = new Map<string, any>();
			await Promise.all([...new Set(inputs.map((input: any) => txid(String(input.txid))))].map(async (id) => {
				transactions.set(id, await this.lookupTransaction(network.networkId, id));
			}));
			return inputs.map((input: any) => {
				const id = txid(String(input.txid));
				const transaction = transactions.get(id);
				return { ...input, txid: id, value: String(input.value), coin: network.symbol, network: network.symbol, tx: transaction, hex: transaction?.hex };
			});
		});
	}

	async getTransactionHistory(networkValue: string, publicKey: string): Promise<any[]> {
		const network = this.resolveNetwork(networkValue);
		const normalized = normalizeExtendedKeyVersion(publicKey);
		if (!normalized || normalized.length > 512) throw new UtxoError("Invalid public key or address", 400);
		const route = isExtendedKey(normalized)
			? `xpub/${encodeURIComponent(normalized)}?details=txs&tokens=used&gap=20&page=1&pageSize=50`
			: `address/${encodeURIComponent(this.cashAddress(network, normalized))}?details=txs&page=1&pageSize=50`;
		return this.cache.get({ namespace: "utxo_history", key: `${network.symbol}:${normalized}:1`, freshForMs: 15_000, staleForMs: 5 * 60_000, source: "nownodes-blockbook" }, async () => {
			const body = await this.request(network, route, {}, true) as any;
			if (body === null) return [];
			// Blockbook omits `transactions` entirely (omitempty) for accounts with no history.
			if (typeof body !== "object" || (body.transactions != null && !Array.isArray(body.transactions))) throw new UtxoError(`Blockbook returned invalid transaction history for ${network.symbol}: ${JSON.stringify(body).slice(0, 160)}`);
			return (body.transactions || []).map((tx: any) => {
				const hasOwnInput = Array.isArray(tx?.vin) && tx.vin.some((input: any) => input?.isOwn === true);
				const hasOwnOutput = Array.isArray(tx?.vout) && tx.vout.some((output: any) => output?.isOwn === true);
				return {
					txid: String(tx?.txid || ""),
					caip: `${network.networkId}/slip44:${SLIP44_BY_SYMBOL[network.symbol] ?? 0}`,
					networkId: network.networkId,
					direction: hasOwnInput && hasOwnOutput ? "self" : hasOwnInput ? "sent" : "received",
					type: "transfer",
					status: Number(tx?.confirmations) > 0 ? "confirmed" : "pending",
					blockHeight: Number.isInteger(Number(tx?.blockHeight)) ? Number(tx.blockHeight) : undefined,
					timestamp: Number(tx?.blockTime) > 0 ? Number(tx.blockTime) : Math.floor(Date.now() / 1000),
					confirmations: Number.isInteger(Number(tx?.confirmations)) ? Math.max(0, Number(tx.confirmations)) : undefined,
					from: Array.isArray(tx?.vin) ? tx.vin.flatMap((input: any) => Array.isArray(input?.addresses) ? input.addresses : []) : [],
					to: Array.isArray(tx?.vout) ? tx.vout.flatMap((output: any) => Array.isArray(output?.addresses) ? output.addresses : []) : [],
					value: String(tx?.value || "0"),
					fee: tx?.fees == null ? undefined : String(tx.fees),
				};
			});
		});
	}

	async getFeeRate(networkValue: string): Promise<{ slow: number; average: number; fast: number; fastest: number }> {
		const network = this.resolveNetwork(networkValue);
		return this.cache.get({ namespace: "utxo_fee", key: network.symbol, freshForMs: 30_000, staleForMs: 5 * 60_000, source: "nownodes-blockbook" }, async () => {
			const [fast, average, slow] = await Promise.all([1, 3, 6].map(async (blocks) => {
				const body = await this.request(network, `estimatefee/${blocks}`) as any;
				const coinPerKb = Number(body?.result ?? body);
				const satPerVbyte = coinPerKb * 100_000;
				if (!Number.isFinite(satPerVbyte) || satPerVbyte < 0) throw new UtxoError("Blockbook returned an invalid fee estimate");
				return Math.max(1, satPerVbyte);
			}));
			return { slow, average, fast, fastest: fast };
		});
	}

	async lookupTransaction(networkValue: string, transactionId: string): Promise<any> {
		const network = this.resolveNetwork(networkValue);
		const id = txid(transactionId);
		return this.cache.get({ namespace: "utxo_transaction", key: `${network.symbol}:${id}`, freshForMs: 30_000, staleForMs: 60 * 60_000, source: "nownodes-blockbook" }, async () => {
			return normalizeTransaction(await this.request(network, `tx/${id}`));
		});
	}

	async broadcast(networkValue: string, rawTransaction: string): Promise<{ success: true; txid: string }> {
		const network = this.resolveNetwork(networkValue);
		const serialized = serializedTransaction(rawTransaction);
		const body = await this.request(network, "sendtx/", { method: "POST", headers: { "Content-Type": "text/plain" }, body: serialized }) as any;
		const id = String(body?.result ?? body ?? "").replace(/^0x/, "");
		if (!/^[a-fA-F0-9]{64}$/.test(id)) throw new UtxoError("Blockbook broadcast returned no transaction id");
		return { success: true, txid: id.toLowerCase() };
	}

	private cashAddress(network: UtxoNetwork, value: string): string {
		return network.symbol === "BCH" && /^[qp][a-z0-9]+$/.test(value) ? `bitcoincash:${value}` : value;
	}

	private async request(network: UtxoNetwork, route: string, init: RequestInit = {}, notFoundAsNull = false): Promise<unknown | null> {
		let response: Response;
		try {
			response = await this.fetcher(`https://${network.host}/${encodeURIComponent(this.options.apiKey)}/api/v2/${route}`, {
				...init,
				// Blockbook authenticates through the URL path. The api-key header is
				// correct for NOWNodes JSON-RPC but makes Blockbook GETs return 405.
				headers: { Accept: "application/json", ...(init.headers || {}) },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (error) {
			throw new UtxoError(`Blockbook request failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (notFoundAsNull && response.status === 404) return null;
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			throw new UtxoError(`Blockbook request failed (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`, response.status >= 400 && response.status < 500 ? response.status : 502);
		}
		const text = await response.text();
		try { return JSON.parse(text); } catch { return text; }
	}
}
