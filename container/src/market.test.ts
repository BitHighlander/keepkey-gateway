import { describe, expect, test } from "bun:test";
import type { PersistentCache } from "./cache";
import { MarketClient } from "./market";

class TestCache implements PersistentCache {
	private values = new Map<string, unknown>();
	async getFresh<T>(namespace: string, key: string): Promise<T | null> { return (this.values.get(`${namespace}:${key}`) as T) ?? null; }
	async getStale<T>(): Promise<T | null> { return null; }
	async set(namespace: string, key: string, value: unknown): Promise<void> { this.values.set(`${namespace}:${key}`, value); }
	async runExclusive<T>(_key: string, task: () => Promise<T>): Promise<T> { return task(); }
}

describe("MarketClient", () => {
	test("does not call CoinGecko until prices are requested", async () => {
		let calls = 0;
		new MarketClient({
			apiKey: "test",
			cache: new TestCache(),
			fetch: (async (_input: string | URL | Request) => { calls++; return Response.json({}); }) as unknown as typeof fetch,
		});
		await Promise.resolve();
		expect(calls).toBe(0);
	});

	test("batches mapped CAIPs, preserves order, and reuses its cache", async () => {
		let calls = 0;
		const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
			calls++;
			expect(String(input)).toContain("ids=bitcoin%2Cethereum");
			return Response.json({ bitcoin: { usd: 60_000 }, ethereum: { usd: 3_000 } });
		};
		const client = new MarketClient({
			apiKey: "test",
			cache: new TestCache(),
			fetch: fakeFetch as typeof fetch,
			baseUrl: "https://prices.test",
			mapping: { btc: "bitcoin", eth: "ethereum" },
		});
		expect(await client.getPrices(["btc", "eth", "btc", "unknown"])).toEqual([60_000, 3_000, 60_000, 0]);
		expect(await client.getPrices(["eth", "btc"])).toEqual([3_000, 60_000]);
		expect(calls).toBe(1);
	});
});
