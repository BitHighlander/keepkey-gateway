import { describe, expect, test } from "bun:test";
import type { PersistentCache } from "./cache";
import { AccountClient } from "./account";

class TestCache implements PersistentCache {
	private values = new Map<string, unknown>();
	async getFresh<T>(namespace: string, key: string): Promise<T | null> { return (this.values.get(`${namespace}:${key}`) as T) ?? null; }
	async getStale<T>(): Promise<T | null> { return null; }
	async set(namespace: string, key: string, value: unknown): Promise<void> { this.values.set(`${namespace}:${key}`, value); }
	async runExclusive<T>(_key: string, task: () => Promise<T>): Promise<T> { return task(); }
}

const COSMOS = "cosmos1rs7fckgznkaxs4sq02pexwjgar43p5wn7akqnc";
const XRP = "rLRYvj3RXU16THYgwhWR3ZN639XAE68RLB";

describe("AccountClient", () => {
	test("does not contact nodes until account data is requested", () => {
		let calls = 0;
		new AccountClient({ apiKey: "test", cache: new TestCache(), fetch: (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch });
		expect(calls).toBe(0);
	});

	test("fails over and flattens Cosmos vesting account wrappers", async () => {
		let calls = 0;
		const fakeFetch = async (): Promise<Response> => {
			calls++;
			if (calls === 1) return new Response("bad gateway", { status: 502 });
			return Response.json({ account: { base_vesting_account: { base_account: { address: COSMOS, account_number: "17", sequence: "2" } } } });
		};
		const client = new AccountClient({ apiKey: "test", cache: new TestCache(), fetch: fakeFetch as unknown as typeof fetch, cosmosEndpoints: { cosmos: ["https://one.test", "https://two.test"] } });
		expect(await client.getAccountInfo("cosmos", COSMOS)).toEqual({ account: { address: COSMOS, account_number: "17", sequence: "2" } });
		expect(calls).toBe(2);
		await client.getAccountInfo("cosmos", COSMOS);
		expect(calls).toBe(2);
	});

	test("returns verified zero sequence when every Cosmos mirror says absent", async () => {
		const client = new AccountClient({
			apiKey: "test",
			cache: new TestCache(),
			fetch: (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch,
			cosmosEndpoints: { cosmos: ["https://one.test", "https://two.test"] },
		});
		expect(await client.getAccountInfo("cosmos", COSMOS)).toEqual({ account: { address: COSMOS, account_number: "0", sequence: "0", pub_key: null } });
	});

	test("uses one current-ledger XRP request for balance, sequence, and ledger index", async () => {
		let calls = 0;
		const client = new AccountClient({
			apiKey: "test",
			cache: new TestCache(),
			fetch: (async (_input, init) => {
				calls++;
				expect(JSON.parse(String(init?.body))).toEqual({ method: "account_info", params: [{ account: XRP, ledger_index: "current", queue: false }] });
				return Response.json({ result: { ledger_current_index: 99, account_data: { Account: XRP, Balance: "1234567", Sequence: 8 } } });
			}) as typeof fetch,
		});
		expect(await client.getAccountInfo("ripple", XRP)).toMatchObject({ Account: XRP, Balance: "1234567", Sequence: 8, ledger_index_current: 99 });
		expect(calls).toBe(1);
	});
});
