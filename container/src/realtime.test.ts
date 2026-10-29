import { describe, expect, test } from "bun:test";
import { RealtimeHub, RealtimeError } from "./realtime";

const NETWORK = "eip155:1";
const ADDRESS = "0x1111111111111111111111111111111111111111";

describe("connection-scoped realtime", () => {
	test("performs zero history work without a subscriber and stops after cancellation", async () => {
		let calls = 0;
		const history = { getTransactionHistory: async () => { calls++; return { histories: [{ transactions: [] }] }; } };
		const hub = new RealtimeHub(history as any, 15);
		await Bun.sleep(25);
		expect(calls).toBe(0);
		const response = hub.createSse("client", [{ address: ADDRESS, networkId: NETWORK }], ["tx:incoming"]);
		const reader = response.body!.getReader();
		const first = new TextDecoder().decode((await reader.read()).value);
		expect(first).toContain("event: connected");
		await Bun.sleep(25);
		expect(calls).toBeGreaterThan(0);
		await reader.cancel();
		await Bun.sleep(20);
		const stoppedAt = calls;
		await Bun.sleep(35);
		expect(calls).toBe(stoppedAt);
		expect(hub.activeSubscriptionCount()).toBe(0);
	});

	test("deduplicates the same watch across subscribers", async () => {
		const hub = new RealtimeHub({ getTransactionHistory: async () => ({ histories: [{ transactions: [] }] }) } as any, 60_000);
		const one = hub.createSse("one", [{ address: ADDRESS, networkId: NETWORK }], undefined);
		const two = hub.createSse("two", [{ address: ADDRESS.toUpperCase(), networkId: NETWORK }], undefined);
		expect(hub.activeAddressCount()).toBe(1);
		await one.body!.cancel();
		await two.body!.cancel();
	});

	test("batches watches and backs off after quiet snapshots", async () => {
		let calls = 0;
		let largestBatch = 0;
		const hub = new RealtimeHub({ getTransactionHistory: async (body: any) => {
			calls++;
			largestBatch = Math.max(largestBatch, body.queries.length);
			return { histories: body.queries.map(() => ({ transactions: [] })) };
		} } as any, 10);
		const response = hub.createSse("client", [
			{ address: ADDRESS, networkId: NETWORK },
			{ address: "0x2222222222222222222222222222222222222222", networkId: NETWORK },
		], undefined);
		const reader = response.body!.getReader();
		await reader.read();
		await Bun.sleep(75);
		expect(largestBatch).toBe(2);
		// Immediate + 10ms + 20ms + 40ms. A fixed 10ms loop would be >= 7.
		expect(calls).toBeLessThanOrEqual(4);
		await reader.cancel();
	});

	test("rejects unsupported watches before starting a loop", () => {
		const hub = new RealtimeHub({ getTransactionHistory: async () => ({}) } as any);
		expect(() => hub.createSse("client", [{ address: "x", networkId: "unknown:1" }], undefined)).toThrow(RealtimeError);
	});

	test("skips and reports unsupported networks instead of rejecting the whole stream", async () => {
		const hub = new RealtimeHub({ getTransactionHistory: async () => ({ histories: [{ transactions: [] }] }) } as any, 60_000);
		const response = hub.createSse("client", [{ address: ADDRESS, networkId: NETWORK }, { address: "x", networkId: "unknown:1" }], undefined);
		const reader = response.body!.getReader();
		const first = new TextDecoder().decode((await reader.read()).value);
		expect(first).toContain('"watching":1');
		expect(first).toContain('"unsupported":["unknown:1"]');
		await reader.cancel();
	});
});
