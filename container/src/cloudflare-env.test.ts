import { describe, expect, test } from "bun:test";
import { containerEnv } from "../../src/container-env";

describe("Cloudflare container environment", () => {
	test("forwards only the explicit runtime allowlist", () => {
		const env = containerEnv({
			DATABASE_URL: "postgresql://example",
			ZERION_API_KEY: "zerion",
			NOWNODES_API_KEY: "nodes",
			COINGECKO_API_KEY: "market",
			SWAPKIT_API_KEY: "swapkit",
			ZEROX_API_KEY: "zeroex",
			PORT: "12000",
			DATABASE_MAX_CONNECTIONS: "5",
			HIVE_ONBOARDING_ENABLED: "false",
			UNEXPECTED_SECRET: "must-not-cross-the-container-boundary",
		} as any);

		expect(env).toEqual({
			DATABASE_URL: "postgresql://example",
			ZERION_API_KEY: "zerion",
			NOWNODES_API_KEY: "nodes",
			COINGECKO_API_KEY: "market",
			SWAPKIT_API_KEY: "swapkit",
			ZEROX_API_KEY: "zeroex",
			PORT: "12000",
			DATABASE_MAX_CONNECTIONS: "5",
			HIVE_ONBOARDING_ENABLED: "false",
		});
	});

	test("does not forward empty optional Hive credentials", () => {
		const env = containerEnv({
			DATABASE_URL: "postgresql://example",
			ZERION_API_KEY: "zerion",
			NOWNODES_API_KEY: "nodes",
			COINGECKO_API_KEY: "market",
			SWAPKIT_API_KEY: "swapkit",
			ZEROX_API_KEY: "zeroex",
			HIVE_SPONSOR_ACCOUNT: "",
			HIVE_SPONSOR_ACTIVE_WIF: "",
		});

		expect(env.HIVE_SPONSOR_ACCOUNT).toBeUndefined();
		expect(env.HIVE_SPONSOR_ACTIVE_WIF).toBeUndefined();
	});
});
