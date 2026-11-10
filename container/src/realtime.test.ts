import { describe, expect, test } from "bun:test";
import { RealtimeHub, RealtimeError } from "./realtime";
import { HistoryClient } from "./history";
import { ZerionClient } from "./zerion";

const NETWORK = "bip122:12a765e31ffd4059bada1e25190f6e98";
const ADDRESS = "0x1111111111111111111111111111111111111111";

test("EVM SSE/socket subscriptions and upstream hints never poll Zerion", async () => {
 let fetches=0;
 const zerion=new ZerionClient({apiKey:'fixture',fetch:(async(_input:string|URL|Request)=>{fetches++;return Response.json({data:[]})}) as typeof fetch});
 const hub=new RealtimeHub(new HistoryClient({zerion}),5);
 const watch={address:ADDRESS,networkId:'eip155:1'};
 const response=hub.createSse('owner',[watch],undefined,{since:Date.now()-1000});
 hub.addSocket('owner','socket',()=>{});
 hub.subscribeSocket('owner','socket',[watch],undefined);
 hub.upstreamChange(watch,'fixture-tx');hub.upstreamSync(watch.networkId,'new_block');
 await Bun.sleep(40);
 expect(fetches).toBe(0);
 hub.close();
 await response.body!.cancel();
});

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
		const one = hub.createSse("one", [{ address: ADDRESS, networkId: "eip155:1" }], undefined);
		const two = hub.createSse("two", [{ address: ADDRESS.toUpperCase(), networkId: "eip155:1" }], undefined);
		expect(hub.activeAddressCount()).toBe(1);
		await one.body!.cancel();
		await two.body!.cancel();
	});

	test("keeps non-Zerion fallback polling on a bounded cadence", async () => {
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
		expect(largestBatch).toBe(1);
		expect(calls).toBeGreaterThanOrEqual(10);
		expect(calls).toBeLessThanOrEqual(20);
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

test("initial subscribe sends another coalesced refresh hint after the first baseline is actually ready", async () => {
 let release!: (value: any) => void;
 const pending = new Promise(resolve => { release = resolve; });
 const hub = new RealtimeHub({ getTransactionHistory: async () => pending } as any, 60_000);
 const response = hub.createSse("client", [{ address: ADDRESS, networkId: NETWORK }], undefined);
 const reader = response.body!.getReader(); const decode = (value: any) => new TextDecoder().decode(value);
 expect(decode((await reader.read()).value)).toContain("connected");
 expect(decode((await reader.read()).value)).toContain('"reason":"subscribe"');
 // This transaction arrives after the caller's balance read but before the
 // gateway establishes its first history snapshot; legacy callers have no since.
 release({ histories: [{ transactions: [{ txid: "new-mempool-transaction", status: "pending", timestamp: Date.now() }] }] });
 const ready = decode((await reader.read()).value);
 expect(ready).toContain("sync:required"); expect(ready).toContain('"reason":"baseline_ready"');
 expect(ready).toContain('"refreshHint":true'); await reader.cancel();
});
