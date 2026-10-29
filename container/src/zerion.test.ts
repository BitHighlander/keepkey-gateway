import { describe, expect, test } from "bun:test";
import { normalizeZerionPositions, normalizeZerionTransactions, normalizeZerionWalletPositions, ZerionClient } from "./zerion";

const ADDRESS = "0x42b9df65b219b3dd36ff330a4dd8f327a6ada990";

const rawPosition = {
	type: "positions",
	id: "opaque-id",
	attributes: {
		name: "Supplied USDC",
		quantity: { numeric: "5000.25" },
		protocol: "Aave V3",
		protocol_module: "lending",
		position_type: "deposit",
		group_id: "group-1",
		value: 5000.25,
		fungible_info: {
			symbol: "USDC",
			icon: { url: "https://example.com/usdc.png" },
			implementations: [{ chain_id: "ethereum", decimals: 6, address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" }],
		},
		application_metadata: { name: "Aave", icon: { url: "https://example.com/aave.png" } },
	},
	relationships: { chain: { data: { type: "chains", id: "ethereum" } }, dapp: { data: { type: "dapps", id: "aave-v3" } } },
};

describe("normalizeZerionPositions", () => {
	test("maps Zerion JSON:API data into provider-neutral DeFi positions", () => {
		const result = normalizeZerionPositions(ADDRESS, [rawPosition], new Map([["ethereum", "eip155:1"]]));
		expect(result).toEqual([{
			pubkey: ADDRESS,
			type: "contract-position",
			positionType: "deposit",
			protocol: "Aave V3",
			displayName: "Aave",
			label: "Supplied USDC",
			network: "ethereum",
			networkId: "eip155:1",
			balanceUsd: 5000.25,
			icon: "https://example.com/aave.png",
			tokens: [{ networkId: "eip155:1", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", balance: "5000.25", balanceUsd: 5000.25 }],
			groupId: "group-1",
		}]);
	});

	test("deduplicates concurrent requests and caches the result", async () => {
		let calls = 0;
		const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
			calls++;
			const url = String(input);
			if (url.endsWith("/chains/")) return Response.json({ data: [{ id: "ethereum", attributes: { external_id: "0x1" } }] });
			return Response.json({ data: [rawPosition] });
		};
		const client = new ZerionClient({ apiKey: "test", fetch: fakeFetch as typeof fetch });
		const [first, second] = await Promise.all([client.getDefiPositions(ADDRESS), client.getDefiPositions(ADDRESS)]);
		expect(first).toEqual(second);
		expect(calls).toBe(2);
		await client.getDefiPositions(ADDRESS);
		expect(calls).toBe(2);
	});
});

describe("normalizeZerionWalletPositions", () => {
	test("keeps native and verified assets while dropping unsolicited tokens", () => {
		const native = {
			type: "positions",
			attributes: {
				value: 7_500,
				quantity: { numeric: "2.5", decimals: 18 },
				fungible_info: {
					symbol: "ETH",
					name: "Ethereum",
					implementations: [{ chain_id: "ethereum", decimals: 18 }],
				},
			},
			relationships: { chain: { data: { id: "ethereum" } } },
		};
		const verified = {
			type: "positions",
			attributes: {
				value: 100,
				quantity: { numeric: "100", decimals: 6 },
				fungible_info: {
					symbol: "USDC",
					name: "USD Coin",
					flags: { verified: true },
					implementations: [{ chain_id: "ethereum", decimals: 6, address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" }],
				},
			},
			relationships: { chain: { data: { id: "ethereum" } } },
		};
		const spam = {
			...verified,
			attributes: {
				...verified.attributes,
				fungible_info: {
					...verified.attributes.fungible_info,
					symbol: "CLAIM-NOW",
					flags: { verified: false },
					implementations: [{ chain_id: "ethereum", decimals: 18, address: "0x1111111111111111111111111111111111111111" }],
				},
			},
		};

		const result = normalizeZerionWalletPositions([native, verified, spam], new Map([["ethereum", "eip155:1"]]));
		expect(result).toHaveLength(2);
		expect(result[0]).toMatchObject({ caip: "eip155:1/slip44:60", type: "native", balance: "2.5", priceUsd: 3_000 });
		expect(result[1]).toMatchObject({
			caip: "eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
			type: "token",
			balance: "100",
		});
	});

	test("loads all supported chains in one demand-driven wallet request", async () => {
		const urls: string[] = [];
		const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			urls.push(url);
			if (url.endsWith("/chains/")) {
				return Response.json({ data: [
					{ id: "ethereum", attributes: { external_id: "0x1" } },
					{ id: "base", attributes: { external_id: "0x2105" } },
				] });
			}
			return Response.json({ data: [] });
		};
		const client = new ZerionClient({ apiKey: "test", fetch: fakeFetch as typeof fetch });
		expect(urls).toHaveLength(0);
		await client.getWalletPositions(ADDRESS);
		expect(urls).toHaveLength(2);
		expect(urls[1]).toContain("filter%5Bpositions%5D=only_simple");
		expect(urls[1]).toContain("filter%5Bchain_ids%5D=base%2Cethereum");
		await client.getWalletPositions(ADDRESS);
		expect(urls).toHaveLength(2);
	});
});

describe("normalizeZerionTransactions", () => {
	test("maps wallet transactions into the existing Pioneer history shape", () => {
		const hash = `0x${"a".repeat(64)}`;
		const result = normalizeZerionTransactions(ADDRESS, [{
			type: "transactions",
			attributes: {
				operation_type: "send",
				hash,
				mined_at_block: 22_000_000,
				mined_at: "2025-01-01T00:00:00Z",
				sent_from: ADDRESS,
				sent_to: "0x1111111111111111111111111111111111111111",
				status: "confirmed",
				fee: { quantity: { int: "21000000000000" } },
				transfers: [{
					sender: ADDRESS,
					recipient: "0x1111111111111111111111111111111111111111",
					quantity: { int: "2500000" },
					fungible_info: { implementations: [{ chain_id: "ethereum", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" }] },
				}],
			},
			relationships: { chain: { data: { id: "ethereum" } } },
		}], new Map([["ethereum", "eip155:1"]]));
		expect(result).toEqual([{
			txid: hash,
			networkId: "eip155:1",
			direction: "sent",
			type: "token_transfer",
			status: "confirmed",
			blockHeight: 22_000_000,
			timestamp: 1_735_689_600,
			from: [ADDRESS],
			to: ["0x1111111111111111111111111111111111111111"],
			value: "2500000",
			fee: "21000000000000",
		}]);
	});
});
