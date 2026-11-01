import { describe, expect, test } from "bun:test";
import { Catalog } from "./catalog";

describe("pinned zero-upstream catalog", () => {
	const catalog = new Catalog();

	test("searches the discovery snapshot without an upstream dependency", () => {
		const results = catalog.search("bitcoin", 30);
		expect(results.length).toBeGreaterThan(0);
		expect(results[0]).toMatchObject({
			assetId: "bip122:000000000019d6689c085ae165831e93/slip44:0",
			chainId: "bip122:000000000019d6689c085ae165831e93",
			symbol: "BTC",
			precision: 8,
		});
	});

	test("is case insensitive and caps broad searches", () => {
		expect(catalog.search("EtHeReUm", 30).some((asset) => asset.assetId === "eip155:1/slip44:60")).toBe(true);
		expect(catalog.search("", 50_000)).toHaveLength(2_000);
	});

	test("returns the pinned 23-asset swap contract", () => {
		const response = catalog.availableSwapAssets();
		expect(response.success).toBe(true);
		expect(response.data.total).toBe(23);
		expect(response.data.assets).toHaveLength(23);
		expect(response.data.assets).toContainEqual(expect.objectContaining({ asset: "BTC.BTC", decimals: 8 }));
		expect(response.data.assets).toContainEqual(expect.objectContaining({ asset: "THOR.RUNE", decimals: 8 }));
		expect(response.data.assets).toContainEqual(expect.objectContaining({ asset: "SOL.USDC", decimals: 6 }));
	});

	test("returns provider chain coverage from a local snapshot", () => {
		const response = catalog.supportedChains();
		expect(response.thorchain).toContain("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
		expect(response.mayachain).toContain("bip122:00040fe8ec8471911baa1db1266ea15d");
		expect(response.shapeshift).toContain("eip155:42161");
		expect(response.relay).toContain("eip155:999");
		expect(response.shapeshift).toContain("eip155:4663");
		expect(response.chainflip).toContain("bip122:000000000019d6689c085ae165831e93");
	});

	test("reports honest demand-tested health without provider polling", () => {
		const response = catalog.swapHealth(1234);
		expect(response.fetchedAt).toBe(1234);
		expect(response.integrations).toHaveLength(7);
		expect(response.integrations.find((integration) => integration.key === "zeroex")?.status).toBe("disabled");
		expect(response.integrations.find((integration) => integration.key === "swapkit")?.status).toBe("disabled");
		const configured = new Catalog({ zeroxEnabled: true, swapkitEnabled: true }).swapHealth(1234);
		expect(configured.integrations.find((integration) => integration.key === "zeroex")?.status).toBe("unknown");
		expect(configured.integrations.find((integration) => integration.key === "swapkit")?.status).toBe("gated");
	});
});


test("quote observations expire without polling and never enable unconfigured providers", () => {
	const catalog = new Catalog();
	const now = 1000000;
	const observations = [{ key: "relay", status: "ok" as const, detail: "Quote succeeded", checkedAt: now }, { key: "zeroex", status: "ok" as const, detail: "Quote succeeded", checkedAt: now }];
	expect(catalog.swapHealth(now, observations).integrations.find(row => row.key === "relay")).toMatchObject({ status: "ok", checkedAt: now, checkScope: "quote" });
	expect(catalog.swapHealth(now + 300001, observations).integrations.find(row => row.key === "relay")?.status).toBe("unknown");
	expect(catalog.swapHealth(now, observations).integrations.find(row => row.key === "zeroex")?.status).toBe("disabled");
});
