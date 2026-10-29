export interface AppConfig {
	port: number;
	databaseUrl: string;
	databaseMaxConnections: number;
	zerionApiKey?: string;
	nownodesApiKey?: string;
	coingeckoApiKey?: string;
	swapkitApiKey?: string;
	zeroxApiKey?: string;
	hiveOnboardingEnabled: boolean;
	hiveSponsorAccount?: string;
	hiveSponsorActiveWif?: string;
}

type Environment = Record<string, string | undefined>;

function integer(env: Environment, name: string, fallback: number, min: number, max: number): number {
	const raw = env[name]?.trim();
	if (!raw) return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new Error(`${name} must be an integer between ${min} and ${max}`);
	}
	return value;
}

export function loadConfig(env: Environment = process.env): AppConfig {
	const databaseUrl = env.DATABASE_URL?.trim();
	if (!databaseUrl) throw new Error("DATABASE_URL is required");

	let parsed: URL;
	try {
		parsed = new URL(databaseUrl);
	} catch {
		throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
	}
	if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
		throw new Error("DATABASE_URL must use postgres:// or postgresql://");
	}

	return {
		port: integer(env, "PORT", 12000, 1, 65535),
		databaseUrl,
		databaseMaxConnections: integer(env, "DATABASE_MAX_CONNECTIONS", 5, 1, 20),
		zerionApiKey: env.ZERION_API_KEY?.trim() || undefined,
		nownodesApiKey: env.NOWNODES_API_KEY?.trim() || undefined,
		coingeckoApiKey: env.COINGECKO_API_KEY?.trim() || undefined,
		swapkitApiKey: env.SWAPKIT_API_KEY?.trim() || undefined,
		zeroxApiKey: env.ZEROX_API_KEY?.trim() || undefined,
		hiveOnboardingEnabled: env.HIVE_ONBOARDING_ENABLED?.trim().toLowerCase() === "true",
		hiveSponsorAccount: env.HIVE_SPONSOR_ACCOUNT?.trim() || undefined,
		hiveSponsorActiveWif: env.HIVE_SPONSOR_ACTIVE_WIF?.trim() || undefined,
	};
}
