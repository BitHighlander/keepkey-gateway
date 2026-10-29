import type { PersistentCache } from "./cache";
import { DemandCache } from "./demand-cache";

const ENDPOINTS = {
	cosmos: ["https://rest.cosmos.directory/cosmoshub", "https://lcd-cosmoshub.keplr.app", "https://cosmos-rest.publicnode.com"],
	osmosis: ["https://lcd-osmosis.keplr.app", "https://rest.cosmos.directory/osmosis", "https://osmosis-rest.publicnode.com"],
	thorchain: ["https://rest.cosmos.directory/thorchain", "https://gateway.liquify.com/chain/thorchain_api"],
	mayachain: ["https://mayanode.mayachain.info", "https://rest.cosmos.directory/mayachain", "https://api-maya.liquify.com"],
} as const;

export class CosmosFeatureError extends Error {
	constructor(message: string, public readonly status = 502) { super(message); }
}

export class CosmosFeatures {
	private readonly cache: DemandCache;
	constructor(cache: PersistentCache, private readonly fetcher: typeof fetch = fetch) {
		this.cache = new DemandCache(cache, 1_000);
	}

	async staking(network: string, address: string): Promise<{ data: Record<string, unknown>[] }> {
		const chain = network.toLowerCase() as "cosmos" | "osmosis";
		if (chain !== "cosmos" && chain !== "osmosis") throw new CosmosFeatureError(`Staking is not supported for ${network}`, 422);
		const prefix = chain === "cosmos" ? "cosmos1" : "osmo1";
		if (!address.startsWith(prefix) || address.length > 128) throw new CosmosFeatureError(`Invalid ${chain} address`, 400);
		return this.cache.get({ namespace: "staking", key: `${chain}:${address}`, freshForMs: 5_000, staleForMs: 30_000, source: "cosmos-rest" }, async () => {
			const [delegations, rewards, unbondings] = await Promise.all([
				this.getAcross(ENDPOINTS[chain], `/cosmos/staking/v1beta1/delegations/${encodeURIComponent(address)}`).catch(() => ({})),
				this.getAcross(ENDPOINTS[chain], `/cosmos/distribution/v1beta1/delegators/${encodeURIComponent(address)}/rewards`).catch(() => ({})),
				this.getAcross(ENDPOINTS[chain], `/cosmos/staking/v1beta1/delegators/${encodeURIComponent(address)}/unbonding_delegations`).catch(() => ({})),
			]);
			const denom = chain === "cosmos" ? "uatom" : "uosmo";
			const ticker = chain === "cosmos" ? "ATOM" : "OSMO";
			const caip = chain === "cosmos" ? "cosmos:cosmoshub-4/slip44:118" : "cosmos:osmosis-1/slip44:118";
			const networkId = caip.split("/")[0];
			const positions: Record<string, unknown>[] = [];
			for (const item of array((delegations as any).delegation_responses)) {
				positions.push(position("delegation", String(item?.balance?.amount || "0"), item?.delegation?.validator_address, "active", denom, ticker, caip, networkId, address));
			}
			for (const item of array((rewards as any).rewards)) {
				const units = array(item?.reward).filter((coin: any) => coin?.denom === denom).reduce((sum: bigint, coin: any) => sum + BigInt(integer(coin?.amount)), 0n);
				if (units > 0n) positions.push(position("reward", units.toString(), item?.validator_address, "claimable", denom, ticker, caip, networkId, address));
			}
			for (const item of array((unbondings as any).unbonding_responses)) {
				for (const entry of array(item?.entries)) positions.push({ ...position("unbonding", String(entry?.balance || "0"), item?.validator_address, "unbonding", denom, ticker, caip, networkId, address), completionTime: entry?.completion_time });
			}
			return { data: positions };
		});
	}

	async nameLookup(network: string, name: string): Promise<{ data: Record<string, unknown> }> {
		const chain = normalizeNameNetwork(network);
		const label = name.trim();
		if (!label || label.length > 30 || !/^[a-zA-Z0-9+_-]+$/.test(label)) throw new CosmosFeatureError("Invalid name", 400);
		return this.cache.get({ namespace: "chain_name", key: `${chain}:${label.toLowerCase()}`, freshForMs: 30_000, staleForMs: 300_000, source: `${chain}-node` }, async () => {
			const prefix = chain === "thorchain" ? "thorchain/thorname" : "mayachain/mayaname";
			const result = await this.getAcrossName(ENDPOINTS[chain], `/${prefix}/${encodeURIComponent(label)}`);
			if (!result || !result.owner) return { data: { found: false, name: label } };
			return { data: { found: true, name: result.name || label, owner: result.owner, expireBlockHeight: numberMaybe(result.expire_block_height), aliases: array(result.aliases).map((alias: any) => ({ chain: alias.chain, address: alias.address })), preferredAsset: result.preferred_asset && result.preferred_asset !== "." ? result.preferred_asset : "" } };
		});
	}

	async nameQuote(network: string): Promise<{ data: Record<string, unknown> }> {
		const chain = normalizeNameNetwork(network);
		return this.cache.get({ namespace: "chain_name_quote", key: chain, freshForMs: 10_000, staleForMs: 60_000, source: `${chain}-node` }, async () => {
			if (chain === "thorchain") {
				const [networkData, constants, block] = await Promise.all([
					this.getAcross(ENDPOINTS.thorchain, "/thorchain/network"),
					this.getAcross(ENDPOINTS.thorchain, "/thorchain/constants"),
					this.getAcross(ENDPOINTS.thorchain, "/cosmos/base/tendermint/v1beta1/blocks/latest"),
				]);
				return { data: { registerFeeBase: String((networkData as any).tns_register_fee_rune), feePerBlockBase: String((networkData as any).tns_fee_per_block_rune), blocksPerYear: Number((constants as any)?.int_64_values?.BlocksPerYear), currentBlockHeight: Number((block as any)?.block?.header?.height) } };
			}
			const [constants, block] = await Promise.all([
				this.getAcross(ENDPOINTS.mayachain, "/mayachain/constants"),
				this.getAcross(ENDPOINTS.mayachain, "/cosmos/base/tendermint/v1beta1/blocks/latest"),
			]);
			const ints = (constants as any)?.int_64_values || {};
			return { data: { registerFeeBase: String(ints.TNSRegisterFee), feePerBlockBase: String(ints.TNSFeePerBlock), blocksPerYear: Number(ints.BlocksPerYear), currentBlockHeight: Number((block as any)?.block?.header?.height) } };
		});
	}

	private async getAcross(endpoints: readonly string[], path: string): Promise<any> {
		let last: unknown;
		for (const endpoint of endpoints) {
			try {
				const response = await this.fetcher(`${endpoint}${path}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
				const body = await response.json().catch(() => null) as any;
				if (!response.ok) throw new Error(`HTTP ${response.status}: ${body?.message || body?.error || "request failed"}`);
				return body;
			} catch (error) { last = error; }
		}
		throw new CosmosFeatureError(`All ${path} endpoints failed: ${last instanceof Error ? last.message : String(last)}`);
	}

	private async getAcrossName(endpoints: readonly string[], path: string): Promise<any | null> {
		let last: unknown;
		for (const endpoint of endpoints) {
			try { return await this.getAcross([endpoint], path); }
			catch (error) {
				last = error;
				if (/does ?n['’]?t exist|does not exist/i.test(error instanceof Error ? error.message : String(error))) return null;
			}
		}
		throw last;
	}
}

function normalizeNameNetwork(network: string): "thorchain" | "mayachain" {
	const value = network.toLowerCase();
	if (value === "thor" || value === "thorchain") return "thorchain";
	if (value === "maya" || value === "mayachain") return "mayachain";
	throw new CosmosFeatureError(`Names are not supported for ${network}`, 422);
}

function position(type: string, rawUnits: string, validator: unknown, status: string, denom: string, ticker: string, caip: string, networkId: string, pubkey: string): Record<string, unknown> {
	const decimals = 6;
	const units = integer(rawUnits);
	const balance = `${units.slice(0, -decimals) || "0"}.${units.slice(-decimals).padStart(decimals, "0")}`.replace(/\.?0+$/, "") || "0";
	return { type, balance, valueUsd: 0, ticker, symbol: ticker, validator: String(validator || ""), validatorAddress: String(validator || ""), status, denom, caip, networkId, pubkey };
}

function array(raw: unknown): any[] { return Array.isArray(raw) ? raw : []; }
function integer(raw: unknown): string { const match = String(raw || "0").match(/^\d+/); return match?.[0] || "0"; }
function numberMaybe(raw: unknown): number | undefined { const value = Number(raw); return Number.isFinite(value) ? value : undefined; }
