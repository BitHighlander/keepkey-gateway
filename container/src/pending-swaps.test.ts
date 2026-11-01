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

	test("UpdatePendingSwap sets Desktop's Relay request id without an upstream call", async () => {
		const database = fakeDatabase();
		const service = new PendingSwapService(database, { fetch: (async () => { throw new Error("no upstream on update"); }) as unknown as typeof fetch });
		const { relayData: _omit, ...withoutRelay } = valid;
		await service.create("client-a", withoutRelay);
		await database.updatePendingSwap("client-a", "0xabcdef0123456789", "confirming", { relayData: { requestId: "other", relayStatus: "pending" } });
		const updated = await service.update("client-a", "0xABCDEF0123456789", { relayData: { requestId: "relay-request" } });
		expect(updated?.relayData).toEqual({ requestId: "relay-request" });
		expect(updated?.status).toBe("confirming");
		const again = await service.update("client-a", "0xabcdef0123456789", { relayData: { requestId: "relay-request" } });
		expect(again?.relayData).toEqual({ requestId: "relay-request" });
	});

	test("UpdatePendingSwap is 404 for an unknown or another client's swap", async () => {
		const database = fakeDatabase();
		const service = new PendingSwapService(database);
		await service.create("client-a", valid);
		expect(await service.update("client-b", valid.txHash, { relayData: { requestId: "x-request" } })).toBeNull();
		expect(await service.update("client-a", "0x9999999999999999", { relayData: { requestId: "x-request" } })).toBeNull();
	});

	test("UpdatePendingSwap accepts only relayData.requestId", async () => {
		const service = new PendingSwapService(fakeDatabase());
		for (const body of [{ status: "completed" }, { relayData: { requestId: "ok" }, status: "completed" }, { relayData: { requestId: "ok", relayStatus: "success" } }, { relayData: { requestId: "has space" } }, { relayData: {} }, {}]) {
			await expect(service.update("client-a", valid.txHash, body)).rejects.toBeInstanceOf(PendingSwapError);
		}
	});
});


describe("Chainflip demand-driven tracking", () => {
	const record = { ...valid, integration: "shapeshift", swapper: "Chainflip", sellAsset: { ...valid.sellAsset, symbol: "BTC", networkId: "bip122:000000000019d6689c085ae165831e93", caip: "bip122:000000000019d6689c085ae165831e93/slip44:0" }, buyAsset: { ...valid.buyAsset, symbol: "ETH", networkId: "eip155:1", caip: "eip155:1/slip44:60" } };
	const payout = { state: "COMPLETED", srcChain: "Bitcoin", srcAsset: "BTC", destChain: "Ethereum", destAsset: "ETH", destAddress: record.buyAsset.address, deposit: { txRef: valid.txHash, witnessedAt: 1787528001000 }, srcChainRequiredBlockConfirmations: 2, swapId: "fixture-swap", swapEgress: { txRef: "0xoutbound", amount: "1234567890123456789", witnessedAt: 1787528101000 }, brokers: [{ commissionBps: 5 }, { commissionBps: 40 }], fees: [{ type: "NETWORK", amount: "100" }] };
	async function setup(body: unknown, httpStatus = 200) {
		let calls = 0;
		const service = new PendingSwapService(fakeDatabase(), { initialGraceMs: 0, refreshIntervalMs: 0, fetch: (async (url: string | URL | Request) => { calls++; expect(String(url)).toContain("chainflip-swap.chainflip.io/v2/swaps/"); return Response.json(body, { status: httpStatus }); }) as typeof fetch });
		await service.create("fixture-client", record);
		expect(calls).toBe(0);
		return { service, calls: () => calls };
	}
	test("requires a confirmed matching payout, preserves fee ledger, and stops terminal checks", async () => {
		const { service, calls } = await setup(payout);
		const result = await service.get("fixture-client", valid.txHash, true);
		expect(result).toMatchObject({ status: "completed", confirmations: 2, requiredConfirmations: 2, outboundTxid: "0xoutbound", receivedOutput: "1.234567890123456789", chainflipData: { brokers: payout.brokers, fees: payout.fees } });
		await service.get("fixture-client", valid.txHash, true);
		expect(calls()).toBe(1);
	});
	test("rejects mismatched deposits, destinations, assets, networks and unconfirmed completion", async () => {
		for (const patch of [{ deposit: { txRef: "0xwrong" } }, { destAddress: valid.sellAsset.address }, { destAsset: "USDT" }, { destChain: "Arbitrum" }, { swapEgress: { ...payout.swapEgress, witnessedAt: undefined } }, { swapEgress: { ...payout.swapEgress, failure: { reason: "transfer failed" } } }, { fallbackEgress: { txRef: "fallback" } }]) {
			const { service } = await setup({ ...payout, ...patch });
			expect(await service.get("fixture-client", valid.txHash, true)).toMatchObject({ status: "pending", providerCheck: { result: "unavailable" } });
		}
	});
	test("keeps unknown deposits pending and follows receiving/swapping/refunds", async () => {
		const missing = await setup({}, 404);
		expect(await missing.service.get("fixture-client", valid.txHash, true)).toMatchObject({ status: "pending", providerCheck: { result: "unavailable" } });
		for (const [state, status] of [["RECEIVING", "confirming"], ["SWAPPING", "swapping"], ["SENDING", "output_confirming"]]) {
			const { service } = await setup({ ...payout, state });
			expect((await service.get("fixture-client", valid.txHash, true))?.status).toBe(status);
		}
		const refunded = await setup({ ...payout, state: "FAILED", refundEgress: { txRef: "refund-tx", amount: "10000", witnessedAt: 1787528101000 } });
		expect(await refunded.service.get("fixture-client", valid.txHash, true)).toMatchObject({ status: "refunded", refundTxid: "refund-tx" });
	});
});
test("BSC USDT output uses 18 decimals", async () => {
	const database = fakeDatabase();
	const service = new PendingSwapService(database, { fetch: (async () => Response.json({ state: "COMPLETED", srcChain: "Ethereum", srcAsset: "ETH", destChain: "Bsc", destAsset: "USDT", destAddress: valid.buyAsset.address, deposit: { txRef: valid.txHash }, swapEgress: { txRef: "outbound", amount: "1230000000000000000", witnessedAt: 1787528101000 } })) as unknown as typeof fetch });
	await service.create("fixture", { ...valid, integration: "chainflip", swapper: "Chainflip", buyAsset: { ...valid.buyAsset, symbol: "USDT", networkId: "eip155:56" } });
	expect(await service.get("fixture", valid.txHash, true)).toMatchObject({ status: "completed", receivedOutput: "1.23" });
});
