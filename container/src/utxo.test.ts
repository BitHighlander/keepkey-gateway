import { describe, expect, test } from "bun:test";
import type { PersistentCache } from "./cache";
import { normalizeExtendedKeyVersion, UtxoClient } from "./utxo";
import { LTC_SCRIPT_FIXTURES } from "../live/ltc-script-discovery";

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

	test("preserves Litecoin wrapped and native SegWit identities across account, UTXO and history reads", async () => {
		const ltc = { networkId: "bip122:12a765e31ffd4059bada1e25190f6e98", symbol: "LTC", host: "blockbook.test" };
		// Litecoin Blockbook maps Mtub -> BIP49/M-addresses and zpub -> BIP84/
		// ltc1q. Bitcoin ypub on that node falls back to BIP44/L-addresses.
		for (const { purpose, publicKey: fixture } of LTC_SCRIPT_FIXTURES.filter(fixture => fixture.purpose !== 44)) {
			const routes: string[] = [];
			expect(normalizeExtendedKeyVersion(fixture)).toBe(fixture);
			const client = new UtxoClient({ apiKey: "test", cache: new TestCache(), networks: [ltc], fetch: (async input => {
				const url = new URL(String(input)); routes.push(url.pathname);
				if (url.pathname.includes("/tx/")) return Response.json({ txid: TXID, hex: "0102", vin: [], vout: [] });
				const requestedKey = decodeURIComponent(url.pathname.split("/").pop() || "");
				if (requestedKey !== fixture) return Response.json({ balance: "0", tokens: [], transactions: [] });
				if (url.pathname.includes("/utxo/")) return Response.json([{ txid: TXID, vout: 0, value: "3039975", path: `m/${purpose}'/2'/0'/0/0` }]);
				return Response.json({ balance: "3039975", tokens: [{ path: `m/${purpose}'/2'/0'/0/0` }], transactions: [{ txid: TXID, value: "3039975", confirmations: 1, vin: [], vout: [{ isOwn: true, addresses: ["ltc-own"], value: "3039975" }] }] });
			}) as typeof fetch });
			expect((await client.getPubkeyInfo("LTC", fixture)).balance).toBe("3039975");
			expect((await client.listUnspent("LTC", fixture))[0]).toMatchObject({ value: "3039975", path: `m/${purpose}'/2'/0'/0/0` });
			expect((await client.getTransactionHistory("LTC", fixture))[0]).toMatchObject({ txid: TXID, value: "3039975" });
			expect(routes.filter(route => !route.includes("/tx/"))).toHaveLength(3);
		}
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
				vin: [{ isOwn: true, addresses: ["bc1qfrom"], value: "50120" }],
				vout: [{ isOwn: false, addresses: ["bc1qto"], value: "50000" }],
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
			value: "50120",
			fee: "120",
		}]);
	});

	// Regression: the sender's change must not count as the recipient's deposit.
	// Addresses below are synthetic and no customer identifiers are retained.
	const history = async (key: string, transactions: any[]) => {
		const fakeFetch = async () => Response.json({ transactions });
		return new UtxoClient({ apiKey: "test", cache: new TestCache(), networks: [NETWORK], fetch: fakeFetch as unknown as typeof fetch }).getTransactionHistory(NETWORK.networkId, key);
	};

	test("received with sender change counts only the wallet's own output", async () => {
		const [tx] = await history(XPUB, [{ txid: TXID, confirmations: 1, value: "158503803", fees: "80781",
			vin: [{ addresses: ["external-sender"], value: "158584584" }],
			vout: [{ addresses: ["sender-change"], value: "157696599" }, { isOwn: true, addresses: ["wallet-receive"], value: "807204" }] }]);
		expect([tx.direction, tx.value, tx.from, tx.to]).toEqual(["received", "807204", ["external-sender"], ["wallet-receive"]]);
	});

	test("a send with change is sent (not self) and excludes the change address", async () => {
		const [tx] = await history(XPUB, [{ txid: TXID, confirmations: 1, value: "1351716", fees: "97610",
			vin: [{ isOwn: true, addresses: ["wallet-spend"], value: "1449326" }],
			vout: [{ addresses: ["external-recipient"], value: "1289946" }, { isOwn: true, addresses: ["wallet-change"], value: "61770" }] }]);
		expect([tx.direction, tx.value, tx.to]).toEqual(["sent", String(1449326 - 61770), ["external-recipient"]]);
	});

	test("a true self-transfer is self with the fee as value", async () => {
		const [tx] = await history(XPUB, [{ txid: TXID, confirmations: 1, value: "711864", fees: "95340",
			vin: [{ isOwn: true, addresses: ["wallet-receive"], value: "807204" }],
			vout: [{ isOwn: true, addresses: ["wallet-self-one"], value: "1000" }, { isOwn: true, addresses: ["wallet-self-two"], value: "710864" }] }]);
		expect([tx.direction, tx.value]).toEqual(["self", "95340"]);
	});

	test("single-address history owns rows by the queried address when isOwn is absent", async () => {
		const [tx] = await history("wallet-receive", [{ txid: TXID, confirmations: 1, value: "158503803", fees: "80781",
			vin: [{ addresses: ["external-sender"], value: "158584584" }],
			vout: [{ addresses: ["sender-change"], value: "157696599" }, { addresses: ["wallet-receive"], value: "807204" }] }]);
		expect([tx.direction, tx.value]).toEqual(["received", "807204"]);
	});

	test("returns empty history when Blockbook omits transactions for an unused xpub", async () => {
		const fakeFetch = async () => Response.json({ page: 1, totalPages: 1, itemsOnPage: 50, balance: "0", txs: 0 });
		const client = new UtxoClient({ apiKey: "test", cache: new TestCache(), networks: [NETWORK], fetch: fakeFetch as unknown as typeof fetch });
		expect(await client.getTransactionHistory(NETWORK.networkId, XPUB)).toEqual([]);
	});
});

test('UTXO ownership preserves case-sensitive Base58 addresses', async () => {
 const address = '1CaseSensitiveFixture', other = '1casesensitivefixture';
 const client = new UtxoClient({ apiKey: 'fixture', cache: new TestCache(), networks: [NETWORK], fetch: (async () => Response.json({ transactions: [{ txid: TXID, vin: [], vout: [
  { addresses: [address], value: '100' }, { addresses: [other], value: '900' },
 ] }] })) as unknown as typeof fetch });
 expect((await client.getTransactionHistory(NETWORK.networkId, address))[0].value).toBe('100');
});

test('UTXO history preserves exact integers above Number.MAX_SAFE_INTEGER', async () => {
 const client = new UtxoClient({ apiKey: 'fixture', cache: new TestCache(), networks: [NETWORK], fetch: (async () => Response.json({ transactions: [{ txid: TXID, vin: [], vout: [
  { isOwn: true, addresses: ['fixture'], value: '9007199254740993' },
 ] }] })) as unknown as typeof fetch });
 expect((await client.getTransactionHistory(NETWORK.networkId, XPUB))[0].value).toBe('9007199254740993');
});

test('UTXO history without ownership or exact owned amounts fails instead of inventing a zero receive', async () => {
 for (const vout of [[{ addresses: ['unowned'], value: '100' }], [{ isOwn: true, addresses: ['owned'] }]]) {
  const client = new UtxoClient({ apiKey: 'fixture', cache: new TestCache(), networks: [NETWORK], fetch: (async () => Response.json({ transactions: [{ txid: TXID, vin: [], vout }] })) as unknown as typeof fetch });
  await expect(client.getTransactionHistory(NETWORK.networkId, XPUB)).rejects.toThrow('Blockbook history omitted');
 }
});

test('UTXO history recognizes derived XPUBAddress tokens without per-row ownership flags', async () => {
 const client = new UtxoClient({ apiKey: 'fixture', cache: new TestCache(), networks: [NETWORK], fetch: (async () => Response.json({
  tokens: [{ type: 'XPUBAddress', name: 'owned-fixture', path: "m/44'/0'/0'/0/0" }],
  transactions: [{ txid: TXID, vin: [], vout: [{ addresses: ['owned-fixture'], value: '123' }, { addresses: ['sender-change'], value: '456' }] }],
 })) as unknown as typeof fetch });
 expect((await client.getTransactionHistory(NETWORK.networkId, XPUB))[0].value).toBe('123');
});
