import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config";

describe("loadConfig", () => {
	test("loads the minimal operational environment", () => {
		expect(loadConfig({ DATABASE_URL: "postgres://pioneer:pioneer@localhost/pioneer" })).toEqual({
			port: 12000,
			databaseUrl: "postgres://pioneer:pioneer@localhost/pioneer",
			databaseMaxConnections: 5,
			zerionApiKey: undefined,
			nownodesApiKey: undefined,
			coingeckoApiKey: undefined,
			swapkitApiKey: undefined,
			zeroxApiKey: undefined,
			hiveOnboardingEnabled: false,
			hiveSponsorAccount: undefined,
			hiveSponsorActiveWif: undefined,
		});
	});

	test("loads only canonical provider credential names", () => {
		const config = loadConfig({
			DATABASE_URL: "postgres://pioneer:pioneer@localhost/pioneer",
			NOWNODES_API_KEY: "nodes",
			COINGECKO_API_KEY: "prices",
			SWAPKIT_API_KEY: "swapkit",
			ZEROX_API_KEY: "zerox",
			NOW_NODES_API: "legacy-name",
			"0X_API_SECRET": "legacy-zerox-name",
		});
		expect(config.nownodesApiKey).toBe("nodes");
		expect(config.coingeckoApiKey).toBe("prices");
		expect(config.swapkitApiKey).toBe("swapkit");
		expect(config.zeroxApiKey).toBe("zerox");
	});

	test("fails fast without PostgreSQL", () => {
		expect(() => loadConfig({})).toThrow("DATABASE_URL is required");
	});

	test("rejects accidental non-PostgreSQL URLs", () => {
		expect(() => loadConfig({ DATABASE_URL: "redis://localhost" })).toThrow("must use postgres");
	});
});
