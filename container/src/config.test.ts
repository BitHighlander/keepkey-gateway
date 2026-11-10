import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config";

describe("loadConfig", () => {
	test("loads the minimal operational environment", () => {
		expect(loadConfig({ DATABASE_URL: "postgres://pioneer:pioneer@localhost/pioneer" })).toEqual({
			port: 12000,
			databaseUrl: "postgres://pioneer:pioneer@localhost/pioneer",
			databaseMaxConnections: 5,
			zerionApiKey: undefined,
            zerionLimits: { minute:120, day:10000, month:250000 },
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
	test('forwards legacy fee configuration and accepts explicitly disabled fees',()=>{
		const config=loadConfig({DATABASE_URL:'postgres://pioneer:pioneer@localhost/pioneer',NEAR_AFFILIATE_BPS:'0',NEAR_API_SECRET:'fixture',RELAY_AFFILIATE_BPS:'31',THORCHAIN_AFFILIATE:'keep',THORCHAIN_AFFILIATE_BPS:'40'});
		expect(config.swapProviders).toMatchObject({near:{feeBps:0,apiKey:'fixture'},relay:{feeBps:31,feeRecipients:['0x87Ab2637bc4231604ad708c5e8aAC92A260c7704','0x21c9a94AF76B59b171b32fD125A4edF0e9A2Ad3e']},thorchain:{affiliate:'keep',affiliateBps:40}});
		expect(()=>loadConfig({DATABASE_URL:'postgres://p:p@localhost/p',NEAR_AFFILIATE_BPS:'bad'})).toThrow('NEAR_AFFILIATE_BPS');
	});

	test("rejects accidental non-PostgreSQL URLs", () => {
		expect(() => loadConfig({ DATABASE_URL: "redis://localhost" })).toThrow("must use postgres");
	});
});
