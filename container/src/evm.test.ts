import { describe, expect, test } from "bun:test";
import type { PersistentCache } from "./cache";
import { EvmClient, formatUnits } from "./evm";

class TestCache implements PersistentCache {
	private values = new Map<string, unknown>();
	async getFresh<T>(namespace: string, key: string): Promise<T | null> { return (this.values.get(`${namespace}:${key}`) as T) ?? null; }
	async getStale<T>(): Promise<T | null> { return null; }
	async set(namespace: string, key: string, value: unknown): Promise<void> { this.values.set(`${namespace}:${key}`, value); }
	async runExclusive<T>(_key: string, task: () => Promise<T>): Promise<T> { return task(); }
}

describe("EvmClient", () => {
	test("does not call an upstream provider until requested", async () => {
		let calls = 0;
		new EvmClient({
			apiKey: "test",
			cache: new TestCache(),
			fetch: (async (_input: string | URL | Request) => { calls++; return Response.json({}); }) as unknown as typeof fetch,
		});
		await Promise.resolve();
		expect(calls).toBe(0);
	});

	test("formats base units without floating-point loss", () => {
		expect(formatUnits(1234567890123456789n, 18)).toBe("1.234567890123456789");
		expect(formatUnits(1_000_000n, 6)).toBe("1");
	});

	test("validates the provider chain and preserves Vault response shapes", async () => {
		let calls = 0;
		const fakeFetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			calls++;
			const payload = JSON.parse(String(init?.body));
			const requests = Array.isArray(payload) ? payload : [payload];
			return Response.json(requests.map((request: any) => ({
				jsonrpc: "2.0",
				id: request.id,
				result: request.method === "eth_chainId" ? "0x1" : request.method === "eth_getBalance" ? "0xde0b6b3a7640000" : "0x7",
			})));
		};
		const client = new EvmClient({ apiKey: "test", cache: new TestCache(), fetch: fakeFetch as typeof fetch, endpoints: { "eip155:1": "https://rpc.test" } });
		expect(await client.getBalance("eip155:1", "0x0000000000000000000000000000000000000001")).toEqual({ balance: "1" });
		expect(await client.getNonce("eip155:1", "0x0000000000000000000000000000000000000001")).toEqual({ nonce: 7 });
		expect(calls).toBe(2);
	});
});
