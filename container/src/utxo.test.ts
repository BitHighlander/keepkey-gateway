import { describe, expect, test } from "bun:test";
import type { PersistentCache } from "./cache";
import { normalizeExtendedKeyVersion, UtxoClient } from "./utxo";

class TestCache implements PersistentCache {
	private values = new Map<string, unknown>();
	async getFresh<T>(namespace: string, key: string): Promise<T | null> { return (this.values.get(`${namespace}:${key}`) as T) ?? null; }
	async getStale<T>(): Promise<T | null> { return null; }
	async set(namespace: string, key: string, value: unknown): Promise<void> { this.values.set(`${namespace}:${key}`, value); }
	async runExclusive<T>(_key: string, task: () => Promise<T>): Promise<T> { return task(); }
}

const NETWORK = { networkId: "bip122:test", symbol: "BTC", host: "blockbook.test" };
const XPUB = "xpub-test-fixture";
const TXID = "a".repeat(64);

describe("UtxoClient", () => {
	test("does not call Blockbook until requested", async () => {
		let calls = 0;
		new UtxoClient({ apiKey: "test", cache: new TestCache(), networks: [NETWORK], fetch: (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch });
		await Promise.resolve();
		expect(calls).toBe(0);
	});

	test("remaps chain-specific extended key versions without changing key data", () => {
		const ltub = "Ltub2YDQmP391UYeDYvLye9P1SuNJFkcRGN7SYHM8JMxaDnegcPTXHJ2BnYmvHnFnGPGKu2WMuCga6iZV3SDxDMGrRyMcrYEfSPhrpS1EPkC43E";
		expect(normalizeExtendedKeyVersion(ltub).startsWith("xpub")).toBe(true);
	});

	test("returns signing-ready UTXOs and reuses transaction details", async () => {
		let transactionCalls = 0;
		const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			if (url.includes("/utxo/")) return Response.json([{ txid: TXID, vout: 1, value: "12345", path: "m/44'/0'/0'/0/1" }]);
			if (url.includes(`/tx/${TXID}`)) {
				transactionCalls++;
				return Response.json({ txid: TXID, version: 2, lockTime: 0, hex: "0102", vin: [], vout: [{ value: "12345", hex: "76a9" }] });
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const client = new UtxoClient({ apiKey: "test", cache: new TestCache(), networks: [NETWORK], fetch: fakeFetch as typeof fetch });
		const first = await client.listUnspent(NETWORK.networkId, XPUB);
		expect(first[0]).toMatchObject({ txid: TXID, vout: 1, value: "12345", hex: "0102", coin: "BTC" });
		expect(first[0].tx.vout[0].scriptPubKey.hex).toBe("76a9");
		await client.lookupTransaction(NETWORK.networkId, TXID);
		expect(transactionCalls).toBe(1);
	});

	test("converts Blockbook coin-per-kB fees to sat/vByte", async () => {
		const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
			const blocks = Number(String(input).match(/estimatefee\/(\d+)/)?.[1]);
			return Response.json({ result: blocks === 1 ? "0.00003" : blocks === 3 ? "0.00002" : "0.00001" });
		};
		const client = new UtxoClient({ apiKey: "test", cache: new TestCache(), networks: [NETWORK], fetch: fakeFetch as typeof fetch });
		expect(await client.getFeeRate("BTC")).toEqual({ slow: 1, average: 2, fast: 3, fastest: 3 });
	});

	test("normalizes synchronous xpub history without a polling worker", async () => {
		const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
			expect(String(input)).toContain("details=txs");
			return Response.json({ transactions: [{
				txid: TXID,
				blockHeight: 900_000,
				blockTime: 1_700_000_000,
				confirmations: 7,
				value: "50000",
				fees: "120",
				vin: [{ isOwn: true, addresses: ["bc1qfrom"] }],
				vout: [{ isOwn: false, addresses: ["bc1qto"] }],
			}] });
		};
		const client = new UtxoClient({ apiKey: "test", cache: new TestCache(), networks: [NETWORK], fetch: fakeFetch as typeof fetch });
		const history = await client.getTransactionHistory(NETWORK.networkId, XPUB);
		expect(history).toEqual([{
			txid: TXID,
			caip: "bip122:test/slip44:0",
			networkId: NETWORK.networkId,
			direction: "sent",
			type: "transfer",
			status: "confirmed",
			blockHeight: 900_000,
			timestamp: 1_700_000_000,
			confirmations: 7,
			from: ["bc1qfrom"],
			to: ["bc1qto"],
			value: "50000",
			fee: "120",
		}]);
	});

	test("returns empty history when Blockbook omits transactions for an unused xpub", async () => {
		const fakeFetch = async () => Response.json({ page: 1, totalPages: 1, itemsOnPage: 50, balance: "0", txs: 0 });
		const client = new UtxoClient({ apiKey: "test", cache: new TestCache(), networks: [NETWORK], fetch: fakeFetch as typeof fetch });
		expect(await client.getTransactionHistory(NETWORK.networkId, XPUB)).toEqual([]);
	});
});
