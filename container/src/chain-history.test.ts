import { describe, expect, test } from "bun:test";
import type { PersistentCache } from "./cache";
import { ChainHistoryClient } from "./chain-history";

class TestCache implements PersistentCache {
	private values = new Map<string, unknown>();
	async getFresh<T>(namespace: string, key: string): Promise<T | null> { return (this.values.get(`${namespace}:${key}`) as T) ?? null; }
	async getStale<T>(): Promise<T | null> { return null; }
	async set(namespace: string, key: string, value: unknown): Promise<void> { this.values.set(`${namespace}:${key}`, value); }
	async runExclusive<T>(_key: string, task: () => Promise<T>): Promise<T> { return task(); }
}

describe("demand-driven chain history", () => {
	test("does no work until requested and merges Cosmos sent/received searches", async () => {
		let calls = 0;
		const address = "cosmos1rs7fckgznkaxs4sq02pexwjgar43p5wn7akqnc";
		const client = new ChainHistoryClient({ apiKey: "test", cache: new TestCache(), fetch: (async (input: string | URL | Request) => {
			calls++;
			const received = decodeURIComponent(String(input)).includes("transfer.recipient");
			return Response.json({ txs: [{ body: { messages: [{ "@type": "/cosmos.bank.v1beta1.MsgSend", from_address: received ? "cosmos1sender" : address, to_address: received ? address : "cosmos1recipient", amount: [{ denom: "uatom", amount: received ? "2000000" : "1000000" }] }] }, auth_info: { fee: { amount: [{ denom: "uatom", amount: "5000" }] } } }], tx_responses: [{ txhash: received ? "RECEIVED" : "SENT", height: "10", timestamp: "2026-08-23T00:00:00Z", code: 0 }] });
		}) as unknown as typeof fetch });
		expect(calls).toBe(0);
		const result = await client.getTransactionHistory("cosmos:cosmoshub-4/slip44:118", address);
		expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ txid: "SENT", direction: "sent", value: "1", fee: "0.005" }), expect.objectContaining({ txid: "RECEIVED", direction: "received", value: "2" })]));
		expect(calls).toBe(2);
		await client.getTransactionHistory("cosmos:cosmoshub-4/slip44:118", address);
		expect(calls).toBe(2);
	});

	test("reads THORChain received sends from Midgard, never the hanging transfer.recipient query", async () => {
		const urls: string[] = [];
		const address = "thor1receiver";
		const client = new ChainHistoryClient({ apiKey: "test", cache: new TestCache(), fetch: (async (input: string | URL | Request) => {
			const url = decodeURIComponent(String(input));
			urls.push(url);
			if (url.includes("/v2/actions")) return Response.json({ actions: [{ date: "1779754673313286898", height: "26332585", status: "success", in: [{ address: "thor1sender", txID: "MIDGARD-TX", coins: [{ asset: "THOR.RUNE", amount: "2000000" }] }], out: [{ address, coins: [] }] }] });
			return Response.json({ txs: [], tx_responses: [] });
		}) as unknown as typeof fetch });
		const result = await client.getTransactionHistory("cosmos:thorchain-mainnet-v1/slip44:931", address);
		expect(result).toEqual([expect.objectContaining({ txid: "MIDGARD-TX", direction: "received", value: "0.02", blockHeight: 26332585, timestamp: 1779754673, from: ["thor1sender"] })]);
		expect(urls.some((url) => url.includes("transfer.recipient"))).toBe(false);
	});

	test("serves MayaChain history from Midgard alone", async () => {
		const urls: string[] = [];
		const address = "maya1sender";
		const client = new ChainHistoryClient({ apiKey: "test", cache: new TestCache(), fetch: (async (input: string | URL | Request) => {
			urls.push(String(input));
			return Response.json({ actions: [{ date: "1710639641550919642", height: "5343273", status: "success", in: [{ address, txID: "MAYA-TX", coins: [{ asset: "MAYA.CACAO", amount: "200000000000" }] }], out: [{ address: "maya1receiver", coins: [] }] }] });
		}) as unknown as typeof fetch });
		expect(await client.getTransactionHistory("cosmos:mayachain-mainnet-v1/slip44:931", address)).toEqual([expect.objectContaining({ txid: "MAYA-TX", direction: "sent", value: "20" })]);
		expect(urls).toEqual([expect.stringContaining("https://midgard.mayachain.info/v2/actions?")]);
	});

	test("falls back to toncenter when NOWNodes TON fails", async () => {
		const hosts: string[] = [];
		const address = "EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N";
		const client = new ChainHistoryClient({ apiKey: "test", cache: new TestCache(), fetch: (async (input: string | URL | Request) => {
			const host = new URL(String(input)).host;
			hosts.push(host);
			if (host === "ton.nownodes.io") return new Response("upstream", { status: 500 });
			return Response.json({ ok: true, result: [] });
		}) as unknown as typeof fetch });
		expect(await client.getTransactionHistory("ton:-239/slip44:607", address)).toEqual([]);
		expect(hosts).toEqual(["ton.nownodes.io", "toncenter.com"]);
	});

	test("falls back to the legacy Cosmos events query for older nodes", async () => {
		const urls: string[] = [];
		const address = "cosmos1legacy";
		const client = new ChainHistoryClient({ apiKey: "test", cache: new TestCache(), fetch: (async (input: string | URL | Request) => {
			const url = String(input);
			urls.push(url);
			if (url.includes("query=")) return new Response("unsupported", { status: 500 });
			return Response.json({ txs: [], tx_responses: [] });
		}) as unknown as typeof fetch });
		expect(await client.getTransactionHistory("cosmos:cosmoshub-4/slip44:118", address)).toEqual([]);
		expect(urls.some((url) => url.includes("query="))).toBe(true);
		expect(urls.some((url) => url.includes("events="))).toBe(true);
	});

	test("normalizes one XRP account_tx response", async () => {
		const address = "rLRYvj3RXU16THYgwhWR3ZN639XAE68RLB";
		const client = new ChainHistoryClient({ apiKey: "test", cache: new TestCache(), fetch: (async () => Response.json({ result: { transactions: [{ validated: true, tx: { hash: "XRP-TX", Account: address, Destination: "rDestination", Amount: "1250000", Fee: "12", date: 1, ledger_index: 2, TransactionType: "Payment" }, meta: { TransactionResult: "tesSUCCESS" } }] } })) as unknown as typeof fetch });
		expect(await client.getTransactionHistory("ripple:4109c6f2045fc7eff4cde8f9905d19c2/slip44:144", address)).toEqual([expect.objectContaining({ txid: "XRP-TX", direction: "sent", value: "1.25", fee: "0.000012", timestamp: 946684801 })]);
	});

	test("gets Solana signatures in one bounded RPC call", async () => {
		let calls = 0;
		const client = new ChainHistoryClient({ apiKey: "test", cache: new TestCache(), fetch: (async () => { calls++; return Response.json({ result: [{ signature: "SOL-TX", slot: 5, blockTime: 100, err: null }] }); }) as unknown as typeof fetch });
		expect(await client.getTransactionHistory("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501", "2hYvcUnojGD5JfBtb3hStqFtU8GzFh2mToyxboPVu9MQ")).toEqual([expect.objectContaining({ txid: "SOL-TX", status: "confirmed", blockHeight: 5 })]);
		expect(calls).toBe(1);
	});

	test("uses the official indexed TRON endpoint and normalizes hex addresses", async () => {
		let requested = "";
		const address = "TUoHaVjx81QkftegrHSihSRLfv9ukxoUZv";
		const client = new ChainHistoryClient({ apiKey: "test", cache: new TestCache(), fetch: (async (input: string | URL | Request) => {
			requested = String(input);
			return Response.json({ data: [{
				txID: "TRON-TX",
				blockNumber: 123,
				block_timestamp: 1_700_000_000_000,
				ret: [{ contractRet: "SUCCESS" }],
				raw_data: { contract: [{ type: "TransferContract", parameter: { value: { owner_address: "41ce8a0cf0c16e89f9712d396456af9357feef00a7", to_address: "41f16412b9a75e284ed52a63fa1a81a389830d3d3e", amount: 1_250_000 } } }] },
			}] });
		}) as unknown as typeof fetch });
		const result = await client.getTransactionHistory("tron:27Lqcw/slip44:195", address);
		expect(requested.startsWith("https://api.trongrid.io/v1/accounts/")).toBe(true);
		expect(result).toEqual([expect.objectContaining({ txid: "TRON-TX", from: [address], direction: "sent", value: "1.25", status: "confirmed" })]);
	});
});
