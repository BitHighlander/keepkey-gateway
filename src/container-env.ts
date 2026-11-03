export interface ContainerRuntimeEnv {
	NEAR_API_SECRET?: string;
	NEAR_AFFILIATE_RECIPIENT?: string;
	NEAR_AFFILIATE_BPS?: string;
	RELAY_AFFILIATE_ADDRESS?: string;
	RELAY_AFFILIATE_ADDRESS_2?: string;
	RELAY_AFFILIATE_BPS?: string;
	THORCHAIN_AFFILIATE?: string;
	THORCHAIN_AFFILIATE_BPS?: string;
	MAYACHAIN_AFFILIATE?: string;
	MAYACHAIN_AFFILIATE_BPS?: string;
	DATABASE_URL: string;
	ZERION_API_KEY: string;
	NOWNODES_API_KEY: string;
	COINGECKO_API_KEY: string;
	SWAPKIT_API_KEY: string;
	ZEROX_API_KEY: string;
	PORT?: string;
	DATABASE_MAX_CONNECTIONS?: string;
	HIVE_ONBOARDING_ENABLED?: string;
	HIVE_SPONSOR_ACCOUNT?: string;
	HIVE_SPONSOR_ACTIVE_WIF?: string;
}

const CONTAINER_ENV_NAMES = [
	"NEAR_API_SECRET", "NEAR_AFFILIATE_RECIPIENT", "NEAR_AFFILIATE_BPS",
	"RELAY_AFFILIATE_ADDRESS", "RELAY_AFFILIATE_ADDRESS_2", "RELAY_AFFILIATE_BPS",
	"THORCHAIN_AFFILIATE", "THORCHAIN_AFFILIATE_BPS", "MAYACHAIN_AFFILIATE", "MAYACHAIN_AFFILIATE_BPS",
	"DATABASE_URL",
	"ZERION_API_KEY",
	"NOWNODES_API_KEY",
	"COINGECKO_API_KEY",
	"SWAPKIT_API_KEY",
	"ZEROX_API_KEY",
	"PORT",
	"DATABASE_MAX_CONNECTIONS",
	"HIVE_ONBOARDING_ENABLED",
	"HIVE_SPONSOR_ACCOUNT",
	"HIVE_SPONSOR_ACTIVE_WIF",
] as const;

export function containerEnv(env: ContainerRuntimeEnv): Record<string, string> {
	const result: Record<string, string> = {};
	for (const name of CONTAINER_ENV_NAMES) {
		const value = env[name];
		if (typeof value === "string" && value.length > 0) result[name] = value;
	}
	return result;
}
