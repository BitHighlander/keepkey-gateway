import { describe, expect, test } from "bun:test";
import type { PersistentCache } from "./cache";
import { MultichainClient } from "./multichain";
import coingeckoMapping from "../data/coingecko-mapping.json";

class TestCache implements PersistentCache {
	private values = new Map<string, unknown>();
	async getFresh<T>(namespace: string, key: string): Promise<T | null> { return (this.values.get(`${namespace}:${key}`) as T) ?? null; }
	async getStale<T>(): Promise<T | null> { return null; }
	async set(namespace: string, key: string, value: unknown): Promise<void> { this.values.set(`${namespace}:${key}`, value); }
	async runExclusive<T>(_key: string, task: () => Promise<T>): Promise<T> { return task(); }
}

describe("MultichainClient", () => {
	test("is completely idle until a balance is requested", () => {
		let calls = 0;
		new MultichainClient({ apiKey: "test", cache: new TestCache(), fetch: (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch });
		expect(calls).toBe(0);
	});

	test("reads and caches a Cosmos native balance without manufacturing tokens", async () => {
		let calls = 0;
		const client = new MultichainClient({ apiKey: "test", cache: new TestCache(), fetch: (async () => { calls++; return Response.json({ balances: [{ denom: "uatom", amount: "1234567" }] }); }) as unknown as typeof fetch });
		const caip = "cosmos:cosmoshub-4/slip44:118";
		const address = "cosmos1rs7fckgznkaxs4sq02pexwjgar43p5wn7akqnc";
		expect(await client.getBalances(caip, address)).toMatchObject([{ caip, balance: "1.234567", symbol: "ATOM", isNative: true }]);
		await client.getBalances(caip, address);
		expect(calls).toBe(1);
	});

	test("gets native SOL and all SPL accounts in one RPC batch", async () => {
		let calls = 0;
		const client = new MultichainClient({ apiKey: "test", cache: new TestCache(), fetch: (async (_input, init) => {
			calls++;
			const request = JSON.parse(String(init?.body));
			expect(request).toHaveLength(2);
			return Response.json([
				{ id: request[0].id, result: { value: 1_500_000_000 } },
				{ id: request[1].id, result: { value: [{ account: { data: { parsed: { info: { mint: "Mint1111111111111111111111111111111111111", tokenAmount: { amount: "2500000", decimals: 6 } } } } } }] } },
			]);
		}) as typeof fetch });
		const balances = await client.getBalances("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501", "2hYvcUnojGD5JfBtb3hStqFtU8GzFh2mToyxboPVu9MQ");
		expect(balances.map((item) => [item.type, item.balance])).toEqual([["native", "1.5"], ["token", "2.5"]]);
		expect(calls).toBe(1);
	});

	test("names and keys a known SPL token like the catalog and market mapping do (EPjFWd, $0 regression)", async () => {
		const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", UNKNOWN = "Mint1111111111111111111111111111111111111";
		const account = (mint: string) => ({ account: { data: { parsed: { info: { mint, tokenAmount: { amount: "553110300", decimals: 6 } } } } } });
		const client = new MultichainClient({ apiKey: "test", cache: new TestCache(), fetch: (async (_input, init) => {
			const request = JSON.parse(String(init?.body));
			return Response.json([{ id: request[0].id, result: { value: 1 } }, { id: request[1].id, result: { value: [account(USDC), account(UNKNOWN)] } }]);
		}) as typeof fetch });
		const [, usdc, unknown] = await client.getBalances("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501", "2hYvcUnojGD5JfBtb3hStqFtU8GzFh2mToyxboPVu9MQ");
		expect(usdc).toMatchObject({ caip: `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:${USDC}`, symbol: "USDC", name: "USDC", balance: "553.1103", contract: USDC });
		expect(usdc.icon).toStartWith("https://");
		// The emitted CAIP must be one the price mapping knows, or the token stays at $0.
		expect((coingeckoMapping as Record<string, string>)[usdc.caip]).toBe("usd-coin");
		// A mint the catalog does not list keeps its truncated mint, never a borrowed identity.
		expect(unknown).toMatchObject({ caip: `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:${UNKNOWN}`, symbol: "Mint11", name: "Solana token" });
	});
});
