import { describe, expect, test } from "bun:test";
import { HistoryClient, HistoryError } from "./history";

const ADDRESS = "0x42b9df65b219b3dd36ff330a4dd8f327a6ada990";
const HASH = `0x${"a".repeat(64)}`;
const BTC_CAIP = "bip122:000000000019d6689c085ae165831e93/slip44:0";

describe("HistoryClient", () => {
	test("does no history work until requested", () => {
		let calls = 0;
		new HistoryClient({
			utxo: { getTransactionHistory: async () => { calls++; return []; } },
			zerion: { getTransactions: async () => { calls++; return []; } },
		});
		expect(calls).toBe(0);
	});

	test("serves multiple EVM networks from one address-index request", async () => {
		let calls = 0;
		const client = new HistoryClient({
			zerion: { getTransactions: async () => {
				calls++;
				return [
					{ txid: HASH, networkId: "eip155:1", direction: "sent", type: "transfer", status: "confirmed", timestamp: 1_700_000_000, from: [ADDRESS], to: [], value: "1" },
					{ txid: HASH, networkId: "eip155:8453", direction: "received", type: "transfer", status: "confirmed", timestamp: 1_700_000_001, from: [], to: [ADDRESS], value: "2" },
				];
			} },
		});
		const response: any = await client.getTransactionHistory({ queries: [
			{ caip: "eip155:1/slip44:60", pubkey: ADDRESS },
			{ caip: "eip155:8453/slip44:60", pubkey: ADDRESS },
		] });
		expect(calls).toBe(1);
		expect(response.success).toBe(true);
		expect(response.histories.map((history: any) => history.transactions.length)).toEqual([1, 1]);
		expect(response.histories[0].transactions[0].caip).toBe("eip155:1/slip44:60");
	});

	test("preserves one synchronous UTXO result per requested xpub", async () => {
		const client = new HistoryClient({
			utxo: { getTransactionHistory: async () => [{ txid: "a".repeat(64), networkId: "bip122:test", direction: "received", type: "transfer", status: "confirmed", timestamp: 1_700_000_000, from: [], to: ["bc1q"], value: "5" }] },
		});
		const response: any = await client.getTransactionHistory({ queries: [{ caip: BTC_CAIP, pubkey: "xpub-fixture" }] });
		expect(response.histories[0]).toMatchObject({ caip: BTC_CAIP, pubkey: "xpub-fixture", cached: false, fresh: true, loading: false });
		expect(response.histories[0].transactions[0]).toMatchObject({ caip: BTC_CAIP, networkId: BTC_CAIP.split("/")[0] });
	});

	test("resolves Hive public keys and normalizes account transfer history", async () => {
		const client = new HistoryClient({ hive: {
			account: async () => ({ success: true, account: { name: "keepkey" } }),
			history: async () => ({ success: true, transfers: [{ txid: "HIVE-TX", blockNum: 10, timestamp: "2026-08-24T12:00:00", type: "transfer", from: "keepkey", to: "receiver", amount: "1.234 HIVE" }] }),
		} });
		const response: any = await client.getTransactionHistory({ queries: [{ caip: "hive:beeab0de/slip44:1275", pubkey: "STM5jZtLoV8YbxCxr4imnbWn61zMB24wwonpnVhfXRmv7j6fk3dTH" }] });
		expect(response.histories[0].transactions).toEqual([expect.objectContaining({ txid: "HIVE-TX", direction: "sent", value: "1.234", blockHeight: 10 })]);
	});

	test("isolates one failing chain instead of failing the whole batch", async () => {
		const client = new HistoryClient({
			utxo: { getTransactionHistory: async () => [] },
			multichain: { getTransactionHistory: async () => { throw Object.assign(new Error("All history endpoints failed: timeout"), { status: 502 }); } },
		});
		const response: any = await client.getTransactionHistory({ queries: [
			{ caip: BTC_CAIP, pubkey: "xpub-fixture" },
			{ caip: "cosmos:thorchain-mainnet-v1/slip44:931", pubkey: "thor1fixture" },
		] });
		expect(response.histories[0]).toMatchObject({ transactions: [], fresh: true });
		expect(response.histories[1]).toMatchObject({ error: { status: 502, message: "All history endpoints failed: timeout" }, fresh: false });
		expect(response.histories[1].transactions).toBeUndefined();
	});

	test("isolates a failing Zerion lookup to its EVM queries", async () => {
		const client = new HistoryClient({
			utxo: { getTransactionHistory: async () => [] },
			zerion: { getTransactions: async () => { throw Object.assign(new Error("zerion down"), { status: 502 }); } },
		});
		const response: any = await client.getTransactionHistory({ queries: [{ caip: BTC_CAIP, pubkey: "xpub-fixture" }, { caip: "eip155:1/slip44:60", pubkey: ADDRESS }] });
		expect(response.histories[0].transactions).toEqual([]);
		expect(response.histories[1].error).toEqual({ status: 502, message: "zerion down" });
	});

	test("hides unexpected error details and still fails when every query fails", async () => {
		const failure = new HistoryError("upstream down", 502);
		const client = new HistoryClient({ multichain: { getTransactionHistory: async () => { throw failure; } } });
		expect(client.getTransactionHistory({ queries: [{ caip: "ton:-239/slip44:607", pubkey: "EQfixture" }] })).rejects.toBe(failure);
		const mixed = new HistoryClient({ utxo: { getTransactionHistory: async () => [] }, multichain: { getTransactionHistory: async () => { throw new TypeError("secret detail"); } } });
		const response: any = await mixed.getTransactionHistory({ queries: [{ caip: BTC_CAIP, pubkey: "xpub-fixture" }, { caip: "ton:-239/slip44:607", pubkey: "EQfixture" }] });
		expect(response.histories[1].error).toEqual({ status: 500, message: "Internal server error" });
	});

	test("rejects a non-STM Hive pubkey as a client error", async () => {
		const client = new HistoryClient({ hive: { account: async () => ({ success: true }), history: async () => ({}) } });
		const attempt = client.getTransactionHistory({ queries: [{ caip: "hive:beeab0de/slip44:825", pubkey: "hiveio" }] });
		expect(attempt).rejects.toBeInstanceOf(HistoryError);
		expect(attempt).rejects.toMatchObject({ status: 400 });
	});

	test("rejects unsupported families instead of presenting a false empty history", async () => {
		const client = new HistoryClient({});
		expect(client.getTransactionHistory({ queries: [{ caip: "cosmos:cosmoshub-4/slip44:118", pubkey: "cosmos1fixture" }] })).rejects.toBeInstanceOf(HistoryError);
	});
});
