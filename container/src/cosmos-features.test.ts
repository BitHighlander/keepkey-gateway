import { describe, expect, test } from "bun:test";
import type { PersistentCache } from "./cache";
import { CosmosFeatures } from "./cosmos-features";

class TestCache implements PersistentCache {
	private values = new Map<string, unknown>();
	async getFresh<T>(namespace: string, key: string): Promise<T | null> { return (this.values.get(`${namespace}:${key}`) as T) ?? null; }
	async getStale<T>(): Promise<T | null> { return null; }
	async set(namespace: string, key: string, value: unknown): Promise<void> { this.values.set(`${namespace}:${key}`, value); }
	async runExclusive<T>(_key: string, task: () => Promise<T>): Promise<T> { return task(); }
}

describe("demand-driven Cosmos features", () => {
	test("does no work until requested and merges staking sources", async () => {
		let calls = 0;
		const address = "cosmos1rs7fckgznkaxs4sq02pexwjgar43p5wn7akqnc";
		const features = new CosmosFeatures(new TestCache(), (async (input) => {
			calls++;
			const url = String(input);
			if (url.includes("/delegations/")) return Response.json({ delegation_responses: [{ delegation: { validator_address: "cosmosvaloper1a", shares: "1234567" }, balance: { amount: "1234567", denom: "uatom" } }] });
			if (url.includes("/rewards")) return Response.json({ rewards: [{ validator_address: "cosmosvaloper1a", reward: [{ amount: "250000", denom: "uatom" }] }] });
			return Response.json({ unbonding_responses: [{ validator_address: "cosmosvaloper1a", entries: [{ balance: "500000", completion_time: "2026-09-01T00:00:00Z" }] }] });
		}) as typeof fetch);
		expect(calls).toBe(0);
		const result = await features.staking("cosmos", address);
		expect(result.data.map((position) => position.type)).toEqual(["delegation", "reward", "unbonding"]);
		expect(result.data[0].balance).toBe("1.234567");
		expect(calls).toBe(3);
		await features.staking("cosmos", address);
		expect(calls).toBe(3);
	});

	test("normalizes name lookup and live registration constants", async () => {
		const features = new CosmosFeatures(new TestCache(), (async (input) => {
			const url = String(input);
			if (url.includes("/thorname/")) return Response.json({ name: "keepkey", owner: "thor1owner", expire_block_height: 123, aliases: [{ chain: "BTC", address: "bc1q" }], preferred_asset: "BTC.BTC" });
			if (url.endsWith("/thorchain/network")) return Response.json({ tns_register_fee_rune: "1000000000", tns_fee_per_block_rune: "20" });
			if (url.endsWith("/thorchain/constants")) return Response.json({ int_64_values: { BlocksPerYear: 5256000 } });
			return Response.json({ block: { header: { height: "999" } } });
		}) as typeof fetch);
		expect((await features.nameLookup("thorchain", "keepkey")).data).toMatchObject({ found: true, owner: "thor1owner", expireBlockHeight: 123, preferredAsset: "BTC.BTC" });
		expect((await features.nameQuote("thorchain")).data).toEqual({ registerFeeBase: "1000000000", feePerBlockBase: "20", blocksPerYear: 5256000, currentBlockHeight: 999 });
	});
});
