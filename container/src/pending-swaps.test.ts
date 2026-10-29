import { describe, expect, test } from "bun:test";
import type { Database, StoredPendingSwap } from "./database";
import { PendingSwapError, PendingSwapService } from "./pending-swaps";

const valid = {
	txHash: "0xABCDEF0123456789",
	addresses: [],
	sellAsset: { caip: "eip155:1/slip44:60", symbol: "ETH", amount: "0.01", amountBaseUnits: "10000000000000000", address: "0x1111111111111111111111111111111111111111", networkId: "eip155:1" },
	buyAsset: { caip: "eip155:8453/erc20:0x2222222222222222222222222222222222222222", symbol: "USDC", amount: "25", amountBaseUnits: "25000000", address: "0x3333333333333333333333333333333333333333", networkId: "eip155:8453" },
	quote: { id: "quote-id", integration: "relay", expectedAmountOut: "25", minimumAmountOut: "24" },
	integration: "relay",
	swapper: "Relay",
	relayData: { requestId: "relay-request" },
};

function fakeDatabase(): Database & { rows: Map<string, StoredPendingSwap> } {
	const rows = new Map<string, StoredPendingSwap>();
	return {
		rows,
		async upsertPendingSwap(clientId, txHash, payload) {
			const key = `${clientId}:${txHash}`;
			const prior = rows.get(key);
			const stored = {
				payload: { ...(prior?.payload || {}), ...payload }, status: prior?.status || "pending",
				createdAt: prior?.createdAt || "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-23T00:00:01.000Z",
			};
			rows.set(key, stored);
			return stored;
		},
		async getPendingSwap(clientId, txHash) { return rows.get(`${clientId}:${txHash}`) || null; },
		async updatePendingSwap(clientId, txHash, status, patch) {
			const key = `${clientId}:${txHash}`;
			const prior = rows.get(key);
			if (!prior) return null;
			const stored = { ...prior, status, payload: { ...prior.payload, ...patch }, updatedAt: "2026-08-23T00:00:02.000Z", lastCheckedAt: "2026-08-23T00:00:02.000Z" };
			rows.set(key, stored);
			return stored;
		},
		async migrate() {}, async ping() {}, async close() {},
		async registerClient() { throw new Error("unused"); }, async authenticate() { return null; },
		async recordVaultTelemetry() { return 0; },
		async reserveHiveClaim() { return false; }, async completeHiveClaim() {}, async releaseHiveClaim() {},
		async getFresh() { return null; }, async getStale() { return null; }, async set() {}, async runExclusive(_key, task) { return task(); },
	};
}

describe("PostgreSQL pending swap contract", () => {
	test("registers idempotently and returns Vault-compatible defaults", async () => {
		const database = fakeDatabase();
		const service = new PendingSwapService(database);
		const first = await service.create("client-a", valid);
		const second = await service.create("client-a", { ...valid, invocationId: "retry" });
		expect(database.rows.size).toBe(1);
		expect(second.txHash).toBe(valid.txHash);
		expect(second.status).toBe("pending");
		expect(second.confirmations).toBe(0);
		expect(second.outboundConfirmations).toBe(0);
		expect(second.invocationId).toBe("retry");
		expect(first.relayData).toEqual({ requestId: "relay-request" });
	});

	test("isolates the same transaction by authenticated client", async () => {
		const database = fakeDatabase();
		const service = new PendingSwapService(database);
		await service.create("client-a", valid);
		expect(await service.get("client-b", valid.txHash)).toBeNull();
		expect(await service.get("client-a", valid.txHash.toLowerCase())).not.toBeNull();
	});

	test("rejects malformed records before persistence", async () => {
		const service = new PendingSwapService(fakeDatabase());
		expect(service.create("client-a", { ...valid, txHash: "bad hash" })).rejects.toBeInstanceOf(PendingSwapError);
		expect(service.create("client-a", { ...valid, buyAsset: {} })).rejects.toBeInstanceOf(PendingSwapError);
	});

	test("refreshes Relay only on read demand and stops forever at terminal state", async () => {
		const database = fakeDatabase();
		let calls = 0;
		const service = new PendingSwapService(database, {
			initialGraceMs: 0,
			refreshIntervalMs: 0,
			fetch: (async (url: string | URL | Request) => {
				calls += 1;
				expect(String(url)).toContain("/intents/status/v3?requestId=relay-request");
				return Response.json({ status: "success", inTxHashes: [valid.txHash], txHashes: ["0xoutbound"], originChainId: 1, destinationChainId: 8453 });
			}) as typeof fetch,
		});
		await service.create("client-a", valid);
		const completed = await service.get("client-a", valid.txHash, true);
		expect(completed?.status).toBe("completed");
		expect(completed?.outboundTxid).toBe("0xoutbound");
		expect((completed?.relayData as any)?.relayStatus).toBe("success");
		await service.get("client-a", valid.txHash, true);
		expect(calls).toBe(1);
	});

	test("registers ShapeShift affiliate tracking once with its provider quote id", async () => {
		const database = fakeDatabase();
		let calls = 0;
		const service = new PendingSwapService(database, {
			refreshIntervalMs: 0,
			initialGraceMs: 0,
			fetch: (async (url: string | URL | Request, init?: RequestInit) => {
				calls++;
				expect(String(url)).toContain("api.shapeshift.com/v1/swap/status?quoteId=ss-quote-123");
				expect(String(url)).toContain(`txHash=${encodeURIComponent(valid.txHash)}`);
				expect(new Headers(init?.headers).get("X-Partner-Code")).toBe("keepkey");
				return Response.json({ status: "pending" });
			}) as typeof fetch,
		});
		const created = await service.create("client-a", { ...valid, integration: "shapeshift", swapper: "0x", quote: { ...valid.quote, quoteId: "ss-quote-123" } });
		expect(created.shapeshiftTracking).toEqual({ quoteId: "ss-quote-123", status: "tracked", attempts: 1, providerStatus: "pending" });
		await service.get("client-a", valid.txHash, true);
		expect(calls).toBe(1);
	});

	test("makes a missing ShapeShift quote id explicit without an upstream call", async () => {
		const database = fakeDatabase();
		let calls = 0;
		const service = new PendingSwapService(database, { fetch: (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch });
		const created = await service.create("client-a", { ...valid, integration: "shapeshift", swapper: "0x" });
		expect(created.shapeshiftTracking).toEqual({ status: "missing_quote_id", attempts: 0 });
		expect(calls).toBe(0);
	});

	test("classifies a Maya refund from Midgard only on active read", async () => {
		const database = fakeDatabase();
		let calls = 0;
		const service = new PendingSwapService(database, { initialGraceMs: 0, refreshIntervalMs: 0, fetch: (async (url: string | URL | Request) => {
			calls++;
			expect(String(url)).toContain("midgard.mayachain.info/v2/actions?txid=ABCDEF0123456789");
			return Response.json({ actions: [{ type: "refund", status: "success", out: [{ txID: "REFUND-TX", coins: [{ asset: "ETH.ETH", amount: "4218210" }] }], metadata: { refund: { reason: "invalid tx type" } } }] });
		}) as typeof fetch });
		await service.create("client-a", { ...valid, txHash: "0xABCDEF0123456789", integration: "mayachain", swapper: "MayaChain" });
		expect(calls).toBe(0);
		const result = await service.get("client-a", "0xABCDEF0123456789", true);
		expect(result).toMatchObject({ status: "refunded", outboundTxid: "REFUND-TX", outboundAsset: "ETH.ETH", receivedOutput: "0.0421821", refundReason: "invalid tx type" });
		expect(calls).toBe(1);
		await service.get("client-a", "0xABCDEF0123456789", true);
		expect(calls).toBe(1);
	});

	test("classifies a THORChain delivery and retains endpoint failover", async () => {
		const database = fakeDatabase();
		const urls: string[] = [];
		const service = new PendingSwapService(database, { initialGraceMs: 0, refreshIntervalMs: 0, fetch: (async (url: string | URL | Request) => {
			urls.push(String(url));
			if (urls.length === 1) return Response.json({ message: "down" }, { status: 503 });
			return Response.json({ actions: [{ type: "swap", status: "success", out: [{ txID: "OUT-TX", coins: [{ asset: "BTC.BTC", amount: "123456789" }] }] }] });
		}) as typeof fetch });
		await service.create("client-a", { ...valid, integration: "thorchain", swapper: "THORChain" });
		const result = await service.get("client-a", valid.txHash, true);
		expect(result).toMatchObject({ status: "completed", outboundTxid: "OUT-TX", receivedOutput: "1.23456789" });
		expect(urls).toHaveLength(2);
		expect(urls[0]).toContain("midgard.thorchain.network");
		expect(urls[1]).toContain("gateway.liquify.com/chain/thorchain_midgard");
	});
});
