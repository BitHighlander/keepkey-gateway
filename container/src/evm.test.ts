import { describe, expect, test } from "bun:test";
import type { PersistentCache } from "./cache";
import type { AppConfig } from "./config";
import type { Database } from "./database";
import { EvmClient, formatUnits, normalizeReadRpcParams } from "./evm";
import { createApp } from "./http";

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

type RpcAnswer = { result?: unknown; error?: { code: number; message: string } };

/** A synthetic Base node: answers eth_chainId itself and every other method
 * from `answer`, recording each JSON-RPC call it receives. */
function fakeNode(answer: (method: string, params: any[]) => RpcAnswer) {
	const calls: { method: string; params: any[] }[] = [];
	let requests = 0;
	const fetcher = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		requests++;
		const payload = JSON.parse(String(init?.body));
		const batch = Array.isArray(payload) ? payload : [payload];
		const replies = batch.map((request: any) => {
			if (request.method === "eth_chainId") return { jsonrpc: "2.0", id: request.id, result: "0x2105" };
			calls.push({ method: request.method, params: request.params });
			return { jsonrpc: "2.0", id: request.id, ...answer(request.method, request.params) };
		});
		return Response.json(Array.isArray(payload) ? replies : replies[0]);
	};
	const client = new EvmClient({ apiKey: "test", cache: new TestCache(), fetch: fetcher as typeof fetch, endpoints: { "eip155:8453": "https://rpc.test" } });
	return { client, calls, requests: () => requests };
}

function abiString(text: string): string {
	const bytes = Buffer.from(text, "utf8").toString("hex");
	return `0x${(32).toString(16).padStart(64, "0")}${text.length.toString(16).padStart(64, "0")}${bytes.padEnd(Math.ceil(bytes.length / 64) * 64, "0")}`;
}

const uint = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const OWNER = "0x1111111111111111111111111111111111111111";
const SPENDER = "0x2222222222222222222222222222222222222222";
const TXID = `0x${"ab".repeat(32)}`;
const REVERT = { error: { code: 3, message: "execution reverted" } };

describe("EvmReadRpc", () => {
	test("returns the node's raw result in the { success, data } envelope", async () => {
		const { client, calls } = fakeNode(() => ({ result: "0x6080" }));
		expect(await client.readRpc("eip155:8453", "eth_getCode", [USDC, "latest"])).toEqual({ success: true, data: "0x6080" });
		expect(calls).toEqual([{ method: "eth_getCode", params: [USDC, "latest"] }]);
	});

	test("refuses methods outside the read-only allowlist without calling the node", async () => {
		const { client, requests } = fakeNode(() => ({ result: "0x" }));
		for (const method of ["eth_sendRawTransaction", "eth_sign", "eth_accounts", "debug_traceTransaction", 7]) {
			await expect(client.readRpc("eip155:8453", method, [])).rejects.toMatchObject({ status: 400 });
		}
		expect(requests()).toBe(0);
	});

	test("validates the network id and params", async () => {
		const { client, requests } = fakeNode(() => ({ result: "0x" }));
		await expect(client.readRpc("eip155:0", "eth_blockNumber", [])).rejects.toMatchObject({ status: 400 });
		await expect(client.readRpc("bip122:000000000019d6689c085ae165831e93", "eth_blockNumber", [])).rejects.toMatchObject({ status: 400 });
		await expect(client.readRpc("eip155:8453", "eth_blockNumber", {})).rejects.toMatchObject({ status: 400 });
		await expect(client.readRpc("eip155:999999", "eth_blockNumber", [])).rejects.toMatchObject({ status: 422 });
		expect(requests()).toBe(0);
	});

	test("a revert is the caller's 422, not a provider outage, and is never a success", async () => {
		const { client } = fakeNode(() => REVERT);
		await expect(client.readRpc("eip155:8453", "eth_call", [{ to: USDC, data: "0xdeadbeef" }, "latest"])).rejects.toMatchObject({ status: 422, message: "EVM JSON-RPC error 3: execution reverted" });
	});

	test("an unreachable node is a 502", async () => {
		const client = new EvmClient({ apiKey: "test", cache: new TestCache(), fetch: (async () => new Response("down", { status: 503 })) as unknown as typeof fetch, endpoints: { "eip155:8453": "https://rpc.test" } });
		await expect(client.readRpc("eip155:8453", "eth_blockNumber", [])).rejects.toMatchObject({ status: 502 });
	});

	test("shares one upstream call between concurrent identical reads and keeps nothing after", async () => {
		let block = 0x10;
		const { client, calls } = fakeNode(() => ({ result: `0x${(block++).toString(16)}` }));
		const [a, b] = await Promise.all([client.readRpc("eip155:8453", "eth_blockNumber", []), client.readRpc("eip155:8453", "eth_blockNumber", [])]);
		expect(a.data).toBe("0x10");
		expect(b.data).toBe("0x10");
		expect((await client.readRpc("eip155:8453", "eth_blockNumber", [])).data).toBe("0x11");
		expect(calls.length).toBe(2);
	});
});

describe("LookupTx", () => {
	test("returns the mined receipt the node reports", async () => {
		const receipt = { transactionHash: TXID, status: "0x1", gasUsed: "0x5208", blockNumber: "0x1b4", logs: [] };
		const tx = { hash: TXID, blockNumber: "0x1b4" };
		const { client, calls } = fakeNode((method) => ({ result: method === "eth_getTransactionReceipt" ? receipt : tx }));
		expect(await client.lookupTransaction("eip155:8453", TXID.toUpperCase().replace("0X", "0x"))).toEqual({ success: true, data: { tx, receipt } });
		expect(calls.map((call) => call.params[0])).toEqual([TXID, TXID]);
	});

	test("reports receipt null while the transaction is not mined", async () => {
		const { client } = fakeNode((method) => ({ result: method === "eth_getTransactionReceipt" ? null : { hash: TXID, blockNumber: null } }));
		const result = await client.lookupTransaction("eip155:8453", TXID);
		expect(result.data.receipt).toBeNull();
		expect(Object.prototype.hasOwnProperty.call(result.data, "receipt")).toBe(true);
	});

	test("rejects a malformed hash without calling the node", async () => {
		const { client, requests } = fakeNode(() => ({ result: null }));
		await expect(client.lookupTransaction("eip155:8453", "0x1234")).rejects.toMatchObject({ status: 400 });
		expect(requests()).toBe(0);
	});
});

describe("LookupTokenMetadata", () => {
	test("reads name, symbol, and decimals from the contract", async () => {
		// Recorded from https://mainnet.base.org for Base USDC on 2026-10-29.
		const recorded: Record<string, string> = {
			"0x313ce567": "0x0000000000000000000000000000000000000000000000000000000000000006",
			"0x95d89b41": "0x000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000045553444300000000000000000000000000000000000000000000000000000000",
			"0x06fdde03": "0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000855534420436f696e000000000000000000000000000000000000000000000000",
		};
		const { client } = fakeNode((_method, params) => ({ result: recorded[params[0].data as string] }));
		expect(await client.getTokenMetadata("eip155:8453", USDC)).toEqual({
			success: true,
			data: { name: "USD Coin", symbol: "USDC", decimals: 6, contractAddress: USDC.toLowerCase(), networkId: "eip155:8453", chainId: 8453, caip: `eip155:8453/erc20:${USDC.toLowerCase()}` },
		});
	});

	test("decodes bytes32 symbols and reports a missing name() as null", async () => {
		const mkr = `0x${Buffer.from("MKR").toString("hex").padEnd(64, "0")}`;
		const { client } = fakeNode((_method, params) => params[0].data === "0x06fdde03" ? REVERT : { result: params[0].data === "0x313ce567" ? uint(18n) : mkr });
		expect((await client.getTokenMetadata("eip155:8453", USDC)).data).toMatchObject({ name: null, symbol: "MKR", decimals: 18 });
	});

	test("refuses an address that is not an ERC-20 here instead of inventing metadata", async () => {
		const { client } = fakeNode(() => ({ result: "0x" }));
		await expect(client.getTokenMetadata("eip155:8453", OWNER)).rejects.toMatchObject({ status: 422 });
		const reverting = fakeNode(() => REVERT).client;
		await expect(reverting.getTokenMetadata("eip155:8453", USDC)).rejects.toMatchObject({ status: 422 });
	});

	test("a provider failure on name() fails the lookup rather than caching a null name", async () => {
		let reads = 0;
		const fetcher = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const payload = JSON.parse(String(init?.body));
			const batch = Array.isArray(payload) ? payload : [payload];
			if (batch.some((request: any) => request.params?.[0]?.data === "0x06fdde03")) return new Response("bad gateway", { status: 502 });
			reads++;
			return Response.json(batch.map((request: any) => ({ jsonrpc: "2.0", id: request.id, result: request.method === "eth_chainId" ? "0x2105" : request.params[0].data === "0x313ce567" ? uint(6n) : abiString("USDC") })));
		};
		const client = new EvmClient({ apiKey: "test", cache: new TestCache(), fetch: fetcher as typeof fetch, endpoints: { "eip155:8453": "https://rpc.test" } });
		await expect(client.getTokenMetadata("eip155:8453", USDC)).rejects.toMatchObject({ status: 502 });
		expect(reads).toBeGreaterThan(0);
	});
});

describe("GetTokenAllowance", () => {
	test("encodes allowance(owner, spender) and returns base units", async () => {
		const { client, calls } = fakeNode(() => ({ result: uint(2n ** 256n - 1n) }));
		expect(await client.getTokenAllowance("eip155:8453", USDC, OWNER, SPENDER)).toEqual({
			success: true,
			data: { allowance: (2n ** 256n - 1n).toString(), owner: OWNER, spender: SPENDER, token: USDC.toLowerCase() },
		});
		expect(calls[0]).toEqual({ method: "eth_call", params: [{ to: USDC.toLowerCase(), data: `0xdd62ed3e${OWNER.slice(2).padStart(64, "0")}${SPENDER.slice(2).padStart(64, "0")}` }, "latest"] });
	});

	test("a zero allowance is a real zero; an empty return is an error, never zero", async () => {
		expect((await fakeNode(() => ({ result: uint(0n) })).client.getTokenAllowance("eip155:8453", USDC, OWNER, SPENDER)).data.allowance).toBe("0");
		await expect(fakeNode(() => ({ result: "0x" })).client.getTokenAllowance("eip155:8453", OWNER, OWNER, SPENDER)).rejects.toMatchObject({ status: 422 });
	});

	test("rejects malformed addresses", async () => {
		const { client, requests } = fakeNode(() => ({ result: uint(0n) }));
		await expect(client.getTokenAllowance("eip155:8453", USDC, "0x123", SPENDER)).rejects.toMatchObject({ status: 400 });
		expect(requests()).toBe(0);
	});
});

describe("EVM read routes", () => {
	const database = { authenticate: async (key: string) => key === "good-key" ? { id: "client", username: "vault" } : null } as unknown as Database;
	const receipt = { status: "0x1", gasUsed: "0x5208", blockNumber: "0x1b4" };
	const { client: evm } = fakeNode((method, params) => {
		if (method === "eth_getTransactionReceipt") return { result: receipt };
		if (method === "eth_getTransactionByHash") return { result: { hash: params[0] } };
		if (method === "eth_blockNumber") return { result: "0x1b4" };
		const data = params[0].data as string;
		if (data.startsWith("0xdd62ed3e")) return { result: uint(1_000_000n) };
		return { result: { "0x313ce567": uint(6n), "0x95d89b41": abiString("USDC"), "0x06fdde03": abiString("USD Coin") }[data] };
	});
	const app = createApp({ config: {} as AppConfig, database, evm });
	const call = (path: string, init: RequestInit = {}) => app.fetch(new Request(`http://gateway.test/api/v1${path}`, { ...init, headers: { Authorization: "good-key", "Content-Type": "application/json" } }));

	test("serve the bodies Desktop's pioneer-evm.ts unwraps", async () => {
		const rpc = await call("/evm/rpc", { method: "POST", body: JSON.stringify({ networkId: "eip155:8453", method: "eth_blockNumber", params: [] }) });
		expect(await rpc.json()).toEqual({ success: true, data: "0x1b4" });

		const lookup = await (await call(`/evm/lookup/eip155:8453/${TXID}`)).json() as any;
		expect(lookup.data.receipt).toEqual(receipt);

		const meta = await (await call("/evm/token/lookup", { method: "POST", body: JSON.stringify({ networkId: "eip155:8453", contractAddress: USDC }) })).json() as any;
		expect(meta.data).toMatchObject({ symbol: "USDC", name: "USD Coin", decimals: 6 });

		const allowance = await (await call(`/evm/token/allowance/eip155:8453/${USDC}/${OWNER}/${SPENDER}`)).json() as any;
		expect(allowance.data).toMatchObject({ allowance: "1000000", owner: OWNER, spender: SPENDER });
	});

	test("GetTokenBalance carries the human balance as both balance and v3's data", async () => {
		const { client } = fakeNode((_method, params) => ({ result: params[0].data === "0x313ce567" ? uint(6n) : uint(1_500_000n) }));
		const balanceApp = createApp({ config: {} as AppConfig, database, evm: client });
		const response = await balanceApp.fetch(new Request(`http://gateway.test/api/v1/evm/token/balance/eip155:8453/${OWNER}/${USDC}`, { headers: { Authorization: "good-key" } }));
		expect(await response.json()).toEqual({ balance: "1.5", data: "1.5" });
	});

	test("refuse write methods and unauthenticated callers with an error status", async () => {
		const write = await call("/evm/rpc", { method: "POST", body: JSON.stringify({ networkId: "eip155:8453", method: "eth_sendRawTransaction", params: ["0x00"] }) });
		expect(write.status).toBe(400);
		const anonymous = await app.fetch(new Request(`http://gateway.test/api/v1/evm/lookup/eip155:8453/${TXID}`));
		expect(anonymous.status).toBe(401);
	});
});


describe("RPC quantity compatibility", () => {
	test("normalizes wallet byte quantities without touching calldata or addresses", async () => {
		const { client, calls } = fakeNode(() => ({ result: "0x5208" }));
		await client.readRpc("eip155:8453", "eth_estimateGas", [{ to: USDC, data: "0x0000ab", gas: "0x070d60", nonce: "0x02a0", value: "0000", gasPrice: null }, "pending"]);
		expect(calls[0].params).toEqual([{ to: USDC, data: "0x0000ab", gas: "0x70d60", nonce: "0x2a0", value: "0x0" }, "pending"]);
	});
	test("rejects invalid quantities and unbounded tracing before node work", async () => {
		const { client, requests } = fakeNode(() => ({ result: "0x" }));
		for (const gas of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "0xzz"])
			await expect(client.readRpc("eip155:8453", "eth_call", [{ gas }])).rejects.toMatchObject({ status: 400 });
		for (const options of [{}, { tracer: "prestateTracer" }, { tracer: "callTracer", timeout: "60s" }, { tracer: "callTracer", reexec: 1000 }, { tracer: "callTracer", tracerConfig: { arbitrary: true } }, { tracer: "callTracer", tracerConfig: { withLog: "yes" } }])
			await expect(client.readRpc("eip155:8453", "debug_traceCall", [{}, "latest", options])).rejects.toMatchObject({ status: 400 });
		expect(requests()).toBe(0);
	});
	test("bounds fee history and normalizes nested simulations", () => {
		expect(normalizeReadRpcParams("eth_feeHistory", [5, "latest", [25, 50]])).toEqual(["0x5", "latest", [25, 50]]);
		expect(() => normalizeReadRpcParams("eth_feeHistory", [101])).toThrow();
		expect(normalizeReadRpcParams("eth_simulateV1", [{ blockStateCalls: [{ calls: [{ value: "0x0001" }] }] }])[0]).toEqual({ blockStateCalls: [{ calls: [{ value: "0x1" }] }] });
		expect(normalizeReadRpcParams("debug_traceCall", [{}, "latest", { tracer: "callTracer" }])[2]).toEqual({ tracer: "callTracer", timeout: "5s" });
	});
	test("distinguishes unsupported simulation from an upstream outage", async () => {
		const client = new EvmClient({ apiKey: "test", cache: new TestCache(), fetch: (async () => new Response("unsupported", { status: 405 })) as unknown as typeof fetch, endpoints: { "eip155:8453": "https://rpc.test" } });
		await expect(client.readRpc("eip155:8453", "eth_simulateV1", [{ blockStateCalls: [] }, "latest"])).rejects.toMatchObject({ status: 422, message: "EVM node does not support eth_simulateV1 (HTTP 405)" });
	});
});
