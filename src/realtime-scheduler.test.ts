import { describe, expect, test } from "bun:test";
import { armPaymentMonitor, runPaymentMonitor, changesDurablePaymentWatches, isInternalRealtimePath } from "./realtime-scheduler";

function memoryStorage() {
	const values = new Map<string, unknown>();
	let alarm: number | null = null;
	const txn = {
		get: async (key: string) => values.get(key),
		put: async (key: string, value: unknown) => { values.set(key, value); },
		getAlarm: async () => alarm,
		setAlarm: async (value: number) => { alarm = value; },
		deleteAlarm: async () => { alarm = null; },
	};
	const storage = { ...txn, transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(txn) } as unknown as DurableObjectStorage;
	return { storage, alarm: () => alarm };
}

describe("durable background payment scheduler", () => {
	test("registration survives a scheduler instance restart and polls with no connected client", async () => {
		const { storage, alarm } = memoryStorage();
		await armPaymentMonitor(storage, 100);
		expect(alarm()).toBe(1_100);
		let calls = 0;
		await runPaymentMonitor(storage, async () => { calls++; return { watches: 2, queued: 1, failures: 0 }; }, 1_100);
		expect(calls).toBe(1);
		expect(alarm()).toBe(16_100);
	});
	test("no registered watches stops background polling", async () => {
		const { storage, alarm } = memoryStorage();
		await armPaymentMonitor(storage, 0);
		await runPaymentMonitor(storage, async () => ({ watches: 0, queued: 0, failures: 0 }), 1_000);
		expect(alarm()).toBeNull();
	});
	test("an unavailable upstream leaves a future alarm rather than exhausting platform retries", async () => {
		const { storage, alarm } = memoryStorage();
		await expect(runPaymentMonitor(storage, async () => { throw new Error("upstream down"); }, 1_000)).rejects.toThrow("upstream down");
		expect(alarm()).toBe(16_000);
	});
	test("registration during an empty tick cannot lose its alarm", async () => {
		const { storage, alarm } = memoryStorage();
		await armPaymentMonitor(storage, 0);
		await runPaymentMonitor(storage, async () => {
			await armPaymentMonitor(storage, 1_100);
			return { watches: 0, queued: 0, failures: 0 };
		}, 1_000);
		expect(alarm()).toBe(2_100);
	});
	test("only explicit registration changes arm monitoring and all internal paths stay private", () => {
		expect(changesDurablePaymentWatches(new Request("https://gateway/api/v1/events/watches", { method: "POST" }))).toBe(true);
		expect(changesDurablePaymentWatches(new Request("https://gateway/api/v1/events"))).toBe(false);
		expect(changesDurablePaymentWatches(new Request("https://gateway/api/v1/portfolio", { method: "POST" }))).toBe(false);
		expect(isInternalRealtimePath("/api/v1/internal/realtime/tick")).toBe(true);
		expect(isInternalRealtimePath("/api/v1/internal")).toBe(true);
		expect(isInternalRealtimePath("/api/v1/events/watches")).toBe(false);
	});
});
