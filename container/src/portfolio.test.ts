import { describe, expect, test } from "bun:test";
import { PortfolioClient, PortfolioError } from "./portfolio";

const BTC_CAIP = "bip122:000000000019d6689c085ae165831e93/slip44:0";
const ETH_CAIP = "eip155:1/slip44:60";
const BASE_CAIP = "eip155:8453/slip44:60";
const HIVE_CAIP = "hive:beeab0de/slip44:1275";
const ADDRESS = "0x42b9df65b219b3dd36ff330a4dd8f327a6ada990";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

describe("PortfolioClient", () => {
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
