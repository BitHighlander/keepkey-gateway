import type { PersistentCache } from "./cache";
import { DemandCache } from "./demand-cache";
import { formatUnits } from "./evm";

const COSMOS = {
	"cosmos:cosmoshub-4": { endpoints: ["https://rest.cosmos.directory/cosmoshub", "https://lcd-cosmoshub.keplr.app"], denom: "uatom", decimals: 6, symbol: "ATOM", name: "Cosmos" },
	"cosmos:thorchain-mainnet-v1": { endpoints: ["https://rest.cosmos.directory/thorchain", "https://gateway.liquify.com/chain/thorchain_api"], denom: "rune", decimals: 8, symbol: "RUNE", name: "THORChain" },
	"cosmos:thorchain-1": { endpoints: ["https://rest.cosmos.directory/thorchain", "https://gateway.liquify.com/chain/thorchain_api"], denom: "rune", decimals: 8, symbol: "RUNE", name: "THORChain" },
	"cosmos:mayachain-mainnet-v1": { endpoints: ["https://mayanode.mayachain.info", "https://rest.cosmos.directory/mayachain", "https://api-maya.liquify.com"], denom: "cacao", decimals: 10, symbol: "CACAO", name: "MayaChain" },
	"cosmos:osmosis-1": { endpoints: ["https://lcd-osmosis.keplr.app", "https://rest.cosmos.directory/osmosis"], denom: "uosmo", decimals: 6, symbol: "OSMO", name: "Osmosis" },
} as const;

export interface MultichainBalance {
	caip: string;
	pubkey: string;
	address: string;
	balance: string;
	networkId: string;
	symbol: string;
	name: string;
	decimals: number;
	type: "native" | "token";
	isNative: boolean;
	contract?: string;
	dataSource: string;
}

export class MultichainError extends Error {
	constructor(message: string, public readonly status = 502) { super(message); }
}

export class MultichainClient {
	private readonly cache: DemandCache;
	private requestId = 0;
	constructor(private readonly options: { apiKey: string; cache: PersistentCache; fetch?: typeof fetch }) {
		this.cache = new DemandCache(options.cache, 1_000);
	}

	async getBalances(caip: string, pubkey: string): Promise<MultichainBalance[]> {
		const networkId = caip.split("/")[0];
		if (!pubkey.trim() || pubkey.length > 512) throw new MultichainError("Invalid wallet address", 400);
		return this.cache.get({ namespace: "multichain_balances", key: `${caip}:${pubkey}`, freshForMs: 8_000, staleForMs: 60_000, source: "chain-rpc" }, async () => {
			if (networkId in COSMOS) return this.cosmos(caip, pubkey, networkId as keyof typeof COSMOS);
			if (networkId.startsWith("solana:")) return this.solana(caip, pubkey);
			if (networkId.startsWith("ripple:")) return this.xrp(caip, pubkey);
			if (networkId.startsWith("tron:")) return this.tron(caip, pubkey);
			if (networkId.startsWith("ton:")) return this.ton(caip, pubkey);
			throw new MultichainError(`Unsupported portfolio network: ${networkId}`, 422);
		});
	}

	private async cosmos(caip: string, address: string, networkId: keyof typeof COSMOS): Promise<MultichainBalance[]> {
		const chain = COSMOS[networkId];
		const body = await getAcross(this.fetcher, chain.endpoints, `/cosmos/bank/v1beta1/balances/${encodeURIComponent(address)}`);
		const requestedDenom = caip.includes("/denom:") ? decodeURIComponent(caip.split("/denom:")[1]) : chain.denom;
		const coin = array(body?.balances).find((candidate: any) => candidate?.denom === requestedDenom);
		if (requestedDenom !== chain.denom && !coin) return [];
		if (requestedDenom !== chain.denom) throw new MultichainError(`Token decimals are unknown for ${requestedDenom}`, 422);
		return [balance({ caip, pubkey: address, networkId, amount: String(coin?.amount || "0"), decimals: chain.decimals, symbol: chain.symbol, name: chain.name, dataSource: "cosmos-rest" })];
	}

	private async solana(caip: string, address: string): Promise<MultichainBalance[]> {
		const networkId = caip.split("/")[0];
		const nativeId = ++this.requestId;
		const tokenId = ++this.requestId;
		const responses = await this.rpc("https://sol.nownodes.io/", [
			{ jsonrpc: "2.0", id: nativeId, method: "getBalance", params: [address, { commitment: "confirmed" }] },
			{ jsonrpc: "2.0", id: tokenId, method: "getTokenAccountsByOwner", params: [address, { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }, { encoding: "jsonParsed", commitment: "confirmed" }] },
		]);
		const native = responses.find((item: any) => item?.id === nativeId);
		if (native?.error || !Number.isSafeInteger(native?.result?.value)) throw new MultichainError(`Solana getBalance failed: ${native?.error?.message || "invalid result"}`);
		const output = [balance({ caip, pubkey: address, networkId, amount: String(native.result.value), decimals: 9, symbol: "SOL", name: "Solana", dataSource: "nownodes-solana" })];
		const tokenResponse = responses.find((item: any) => item?.id === tokenId);
		if (!tokenResponse?.error) {
			for (const account of array(tokenResponse?.result?.value)) {
				const info = account?.account?.data?.parsed?.info;
				const mint = String(info?.mint || "");
				const amount = String(info?.tokenAmount?.amount || "");
				const decimals = Number(info?.tokenAmount?.decimals);
				if (!mint || !/^\d+$/.test(amount) || !Number.isInteger(decimals)) continue;
				output.push(balance({ caip: `${networkId}/spl:${mint}`, pubkey: address, networkId, amount, decimals, symbol: mint.slice(0, 6), name: "Solana token", contract: mint, type: "token", dataSource: "nownodes-solana" }));
			}
		}
		return output;
	}

	private async xrp(caip: string, address: string): Promise<MultichainBalance[]> {
		const body = await this.rpc("https://xrp.nownodes.io/", { method: "account_info", params: [{ account: address, ledger_index: "current", queue: false }] });
		const result = body?.result || {};
		if (result.error === "actNotFound") return [balance({ caip, pubkey: address, networkId: caip.split("/")[0], amount: "0", decimals: 6, symbol: "XRP", name: "XRP", dataSource: "nownodes-xrp" })];
		if (result.error || !/^\d+$/.test(String(result?.account_data?.Balance || ""))) throw new MultichainError(`XRP account_info failed: ${result.error_message || result.error || "invalid result"}`);
		return [balance({ caip, pubkey: address, networkId: caip.split("/")[0], amount: String(result.account_data.Balance), decimals: 6, symbol: "XRP", name: "XRP", dataSource: "nownodes-xrp" })];
	}

	private async tron(caip: string, address: string): Promise<MultichainBalance[]> {
		const response = await this.fetcher("https://trx.nownodes.io/wallet/getaccount", { method: "POST", headers: this.headers(), body: JSON.stringify({ address, visible: true }), signal: AbortSignal.timeout(10_000) });
		const body = await response.json().catch(() => null) as any;
		if (!response.ok) throw new MultichainError(`TRON account request failed (${response.status})`);
		return [balance({ caip, pubkey: address, networkId: caip.split("/")[0], amount: String(body?.balance || "0"), decimals: 6, symbol: "TRX", name: "TRON", dataSource: "nownodes-tron" })];
	}

	private async ton(caip: string, address: string): Promise<MultichainBalance[]> {
		const response = await this.fetcher(`https://ton.nownodes.io/api/v2/getAddressInformation?address=${encodeURIComponent(address)}`, { headers: this.headers(), signal: AbortSignal.timeout(10_000) });
		const body = await response.json().catch(() => null) as any;
		if (!response.ok || body?.ok === false) throw new MultichainError(`TON account request failed (${response.status})`);
		return [balance({ caip, pubkey: address, networkId: caip.split("/")[0], amount: String(body?.result?.balance || body?.balance || "0"), decimals: 9, symbol: "TON", name: "Toncoin", dataSource: "nownodes-ton" })];
	}

	private get fetcher(): typeof fetch { return this.options.fetch || fetch; }
	private headers(): Record<string, string> { return { Accept: "application/json", "Content-Type": "application/json", "api-key": this.options.apiKey }; }
	private async rpc(endpoint: string, payload: any): Promise<any> {
		const response = await this.fetcher(endpoint, { method: "POST", headers: this.headers(), body: JSON.stringify(payload), signal: AbortSignal.timeout(12_000) });
		const body = await response.json().catch(() => null);
		if (!response.ok) throw new MultichainError(`RPC request failed (${response.status})`);
		return body;
	}
}

function balance(input: { caip: string; pubkey: string; networkId: string; amount: string; decimals: number; symbol: string; name: string; dataSource: string; contract?: string; type?: "native" | "token" }): MultichainBalance {
	const type = input.type || "native";
	return { caip: input.caip, pubkey: input.pubkey, address: input.pubkey, balance: formatUnits(BigInt(/^\d+$/.test(input.amount) ? input.amount : "0"), input.decimals), networkId: input.networkId, symbol: input.symbol, name: input.name, decimals: input.decimals, type, isNative: type === "native", contract: input.contract, dataSource: input.dataSource };
}

async function getAcross(fetcher: typeof fetch, endpoints: readonly string[], path: string): Promise<any> {
	let last: unknown;
	for (const endpoint of endpoints) {
		try {
			const response = await fetcher(`${endpoint}${path}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return await response.json();
		} catch (error) { last = error; }
	}
	throw new MultichainError(`All bank endpoints failed: ${last instanceof Error ? last.message : String(last)}`);
}

function array(raw: unknown): any[] { return Array.isArray(raw) ? raw : []; }
