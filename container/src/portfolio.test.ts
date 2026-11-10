import { describe, expect, test } from "bun:test";
import { PortfolioClient, PortfolioError } from "./portfolio";
import { UtxoClient } from "./utxo";
import { createApp } from "./http";
import type { Database } from "./database";
import type { AppConfig } from "./config";
import type { PersistentCache } from "./cache";
import {ZerionClient} from './zerion';

const BTC_CAIP = "bip122:000000000019d6689c085ae165831e93/slip44:0";
const LTC_CAIP = "bip122:12a765e31ffd4059bada1e25190f6e98/slip44:2";
const ETH_CAIP = "eip155:1/slip44:60";
const BASE_CAIP = "eip155:8453/slip44:60";
const HIVE_CAIP = "hive:beeab0de/slip44:1275";
const ADDRESS = "0x42b9df65b219b3dd36ff330a4dd8f327a6ada990";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

test('automatic HTTP refreshes use cached discovery and fresh native RPC without paid requests',async()=>{
 let paid=0,rpc=0;
 const zerion=new ZerionClient({apiKey:'fixture',fetch:(async(input:string|URL|Request)=>{
  paid++;return Response.json(String(input).endsWith('/chains/')?{data:[{id:'ethereum',attributes:{external_id:'0x1'}}]}:{data:[]});
 }) as typeof fetch});
 const portfolio=new PortfolioClient({zerion,evm:{getBalance:async()=>{rpc++;return {balance:'2',balanceHex:'0x0'} as any;},getTokenBalance:async()=>({balance:'0'} as any)}});
 const app=createApp({config:{} as AppConfig,database:{authenticate:async()=>({id:'fixture',username:'fixture'})} as any,portfolio});
 const read=(policy:string)=>app.fetch(new Request('http://fixture/api/v1/portfolio/balances?forceRefresh=true',{method:'POST',headers:{Authorization:'fixture','Content-Type':'application/json'},body:JSON.stringify({pubkeys:[{caip:ETH_CAIP,pubkey:ADDRESS}],providerRefreshPolicy:policy,refreshReason:policy==='on-demand'?'wallet-open':'swap-reconcile'})}));
 expect((await read('on-demand')).status).toBe(200);expect(paid).toBe(2);
 for(let i=0;i<3;i++){
  const response:any=await(await read('cache-only')).json();
  expect(response.balances[0].balance).toBe('2');expect(response.balances[0].dataSource).toBe('nownodes');
  expect(response.meta.staleChains).toContain('eip155:1');
 }
 expect(paid).toBe(2);expect(rpc).toBe(3);
 expect((await read('unknown')).status).toBe(400);expect(paid).toBe(2);
});

describe("PortfolioClient", () => {
	test("manual HTTP refresh bypasses cached zero balances and refuses stale fallback on provider failure", async () => {
		const values = new Map<string, unknown>();
		const cache: PersistentCache = {
			getFresh: async <T>(namespace: string, key: string) => (values.get(`${namespace}:${key}`) as T) ?? null,
			getStale: async <T>() => "0" as T,
			set: async (namespace, key, value) => { values.set(`${namespace}:${key}`, value); },
			runExclusive: async (_key, task) => task(),
		};
		let upstream = "0", calls = 0, offline = false;
		const utxo = new UtxoClient({ apiKey: "test", cache, fetch: (async () => {
			calls++;
			return offline ? Response.json({ error: "provider offline" }, { status: 503 }) : Response.json({ balance: "0", unconfirmedBalance: upstream });
		}) as unknown as typeof fetch });
		const database = { authenticate: async () => ({ id: "test-client", username: "fixture" }) } as unknown as Database;
		const app = createApp({ config: {} as AppConfig, database, portfolio: new PortfolioClient({ utxo }) });
		const read = (query = "") => app.fetch(new Request(`http://gateway.test/api/v1/portfolio/balances${query}`, {
			method: "POST", headers: { Authorization: "test", "Content-Type": "application/json" },
			body: JSON.stringify({ pubkeys: [{ caip: LTC_CAIP, pubkey: "zpub-public-fixture" }] }),
		}));
		expect(((await (await read()).json()) as any).balances[0].balance).toBe("0");
		upstream = "3039975";
		expect(((await (await read("?forceRefresh=false")).json()) as any).balances[0].balance).toBe("0");
		expect(calls).toBe(1);
		expect(((await (await read("?forceRefresh=true")).json()) as any).balances[0].balance).toBe("0.03039975");
		expect(calls).toBe(2);
		expect((await read("?forceRefresh=1")).status).toBe(400);
		expect(calls).toBe(2);
		offline = true;
		const failed: any = await (await read("?forceRefresh=true")).json();
		expect(failed.balances).toEqual([]);
		expect(failed.meta).toMatchObject({ degraded: true, failures: [{ caip: LTC_CAIP, reason: expect.stringContaining("503") }] });
		expect(calls).toBe(3);
	});

	test("includes incoming and outgoing mempool changes exactly once in the UTXO account total", async () => {
		for (const [confirmed, pending, expected] of [
			["0", "3039975", "0.03039975"], // freshly funded before mining
			["5000000", "1000000", "0.06"], // confirmed plus pending incoming
			["5000000", "-1250000", "0.0375"], // pending outgoing net of change
			["5000000", "-5000000", "0"], // pending spend of the full account
			["900719925474099100", "-101", "9007199254.74098999"], // no Number rounding
		]) {
			let reads = 0;
			const client = new PortfolioClient({ utxo: { getPubkeyInfo: async () => { reads++; return { balance: confirmed, unconfirmedBalance: pending }; } } });
			const result = await client.getBalances({ pubkeys: [{ caip: LTC_CAIP, pubkey: "zpub-public-fixture" }] });
			expect(result.balances[0]).toMatchObject({ caip: LTC_CAIP, balance: expected, decimals: 8 });
			expect(result.meta.degraded).toBe(false);
			expect(reads).toBe(1);
		}
	});

	test("reports malformed or inconsistent UTXO totals as provider failures instead of a zero", async () => {
		for (const [balance, unconfirmedBalance] of [["1", "-2"], ["0", "not-an-integer"], ["0", "0.1"], ["0x10", "0"]]) {
			const client = new PortfolioClient({ utxo: { getPubkeyInfo: async () => ({ balance, unconfirmedBalance }) } });
			const result = await client.getBalances({ pubkeys: [{ caip: LTC_CAIP, pubkey: "zpub-public-fixture" }] });
			expect(result.balances).toHaveLength(0);
			expect(result.meta.degraded).toBe(true);
		}
	});
	test("does no provider work until a portfolio is requested", () => {
		let calls = 0;
		new PortfolioClient({
			utxo: { getPubkeyInfo: async () => { calls++; return {}; } },
			market: { getPrices: async () => { calls++; return []; } },
			zerion: {
				getWalletPositions: async () => { calls++; return []; },
				getDefiPositions: async () => { calls++; return []; },
			},
		});
		expect(calls).toBe(0);
	});

	test("resolves a Hive public key into native HIVE and spendable HBD", async () => {
		let calls = 0;
		const client = new PortfolioClient({
			hive: {
				account: async () => {
					calls++;
					return { success: true, account: { name: "keepkey", hive: "12.345", hbd: "6.789" } };
				},
			},
		});
		const result = await client.getBalances({ pubkeys: [{ caip: HIVE_CAIP, pubkey: "STMfixture" }] });
		expect(calls).toBe(1);
		expect(result.meta.degraded).toBe(false);
		expect(result.balances).toMatchObject([
			{ caip: HIVE_CAIP, pubkey: "STMfixture", address: "keepkey", balance: "12.345", symbol: "HIVE", decimals: 3, type: "native", dataSource: "hive-rpc" },
			{ caip: "hive:beeab0de/token:HBD", pubkey: "STMfixture", address: "keepkey", balance: "6.789", symbol: "HBD", decimals: 3, type: "token", dataSource: "hive-rpc" },
		]);
	});

	test("returns a verified zero HIVE balance when the public key has no account", async () => {
		const client = new PortfolioClient({ hive: { account: async () => ({ success: true, noAccount: true }) } });
		const result = await client.getBalances({ pubkeys: [{ caip: HIVE_CAIP, pubkey: "STMfixture" }] });
		expect(result.meta.degraded).toBe(false);
		expect(result.balances).toMatchObject([{ caip: HIVE_CAIP, balance: "0", symbol: "HIVE", verified: true }]);
	});

	test("aggregates an xpub and several EVM networks with one wallet-index request", async () => {
		let walletCalls = 0;
		let priceCalls = 0;
		const client = new PortfolioClient({
			utxo: {
				getPubkeyInfo: async () => ({
					balance: "125000000",
					tokens: [{ name: "bc1qfixture", path: "m/84'/0'/0'/0/0", transfers: 2 }],
				}),
			},
			market: {
				getPrices: async (caips) => {
					priceCalls++;
					expect(caips).toEqual([BTC_CAIP, BASE_CAIP]);
					return [60_000, 3_000];
				},
			},
			zerion: {
				getWalletPositions: async () => {
					walletCalls++;
					return [
						{ caip: ETH_CAIP, networkId: "eip155:1", type: "native", symbol: "ETH", name: "Ethereum", balance: "2", balanceUsd: 6_000, priceUsd: 3_000, decimals: 18 },
						{ caip: `eip155:1/erc20:${USDC}`, networkId: "eip155:1", contract: USDC, type: "token", symbol: "USDC", name: "USD Coin", balance: "250", balanceUsd: 250, priceUsd: 1, decimals: 6 },
					];
				},
				getDefiPositions: async () => [],
			},
		});

		const result = await client.getBalances({
			pubkeys: [
				{ caip: BTC_CAIP, pubkey: "xpub-fixture" },
				{ caip: ETH_CAIP, pubkey: ADDRESS },
				{ caip: BASE_CAIP, pubkey: ADDRESS },
			],
		});

		expect(walletCalls).toBe(1);
		expect(priceCalls).toBe(1);
		expect(result.meta.degraded).toBe(false);
		expect(result.balances).toHaveLength(4);
		expect(result.balances.find((entry) => entry.caip === BTC_CAIP)).toMatchObject({ balance: "1.25", priceUsd: "60000", valueUsd: "75000", address: "bc1qfixture" });
		expect(result.balances.find((entry) => entry.caip === ETH_CAIP)).toMatchObject({ balance: "2", valueUsd: "6000", dataSource: "zerion" });
		expect(result.balances.find((entry) => entry.caip === BASE_CAIP)).toMatchObject({ balance: "0", priceUsd: "3000", valueUsd: "0", dataSource: "zerion" });
		expect(result.balances.find((entry) => entry.contract === USDC)).toMatchObject({ balance: "250", type: "token", pubkey: ADDRESS });
	});

	test("lets a direct extraContracts balance override indexed data", async () => {
		const client = new PortfolioClient({
			zerion: {
				getWalletPositions: async () => [{ caip: `eip155:1/erc20:${USDC}`, networkId: "eip155:1", contract: USDC, type: "token", symbol: "USDC", name: "USD Coin", balance: "10", balanceUsd: 10, priceUsd: 1, decimals: 6 }],
				getDefiPositions: async () => [],
			},
			evm: {
				getBalance: async () => ({ balance: "0" }),
				getTokenBalance: async () => ({ balance: "12.5" }),
			},
		});
		const result = await client.getBalances({
			pubkeys: [{ caip: ETH_CAIP, pubkey: ADDRESS }],
			extraContracts: [{ networkId: "eip155:1", contractAddress: USDC, decimals: 6, symbol: "USDC", name: "USD Coin" }],
		});
		expect(result.balances.find((entry) => entry.contract === USDC)).toMatchObject({ balance: "12.5", valueUsd: "12.5", dataSource: "nownodes-direct" });
	});

	test("reports provider failure without manufacturing a zero balance", async () => {
		const client = new PortfolioClient({
			utxo: { getPubkeyInfo: async () => { throw new Error("node unavailable"); } },
		});
		const result = await client.getBalances({ pubkeys: [{ caip: BTC_CAIP, pubkey: "xpub-fixture" }] });
		expect(result.balances).toEqual([]);
		expect(result.meta).toMatchObject({ degraded: true, degradedCount: 1, failures: [{ caip: BTC_CAIP, reason: "node unavailable" }] });
	});

	test("enforces Vault request caps before touching providers", async () => {
		const client = new PortfolioClient({});
		expect(client.getBalances({ pubkeys: [] })).rejects.toBeInstanceOf(PortfolioError);
		expect(client.getBalances({
			pubkeys: [{ caip: ETH_CAIP, pubkey: ADDRESS }],
			extraContracts: Array.from({ length: 21 }, () => ({ networkId: "eip155:1", contractAddress: USDC, decimals: 6 })),
		})).rejects.toBeInstanceOf(PortfolioError);
	});
});
