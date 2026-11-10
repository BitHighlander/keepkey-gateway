import { DEFAULT_ZERION_LIMITS, type ProviderBudgetLimits } from './provider-budget';
import type { SwapProviderOptions } from './swap';
export interface AppConfig {
	swapProviders?: SwapProviderOptions;
	port: number;
	databaseUrl: string;
	databaseMaxConnections: number;
	zerionApiKey?: string;
	zerionLimits?: ProviderBudgetLimits;
	nownodesApiKey?: string;
	realtimeSchedulerSecret?: string;
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
		...(Object.keys(swapProviders(env)).length?{swapProviders:swapProviders(env)}:{}),
		port: integer(env, "PORT", 12000, 1, 65535),
		databaseUrl,
		databaseMaxConnections: integer(env, "DATABASE_MAX_CONNECTIONS", 5, 1, 20),
		zerionApiKey: env.ZERION_API_KEY?.trim() || undefined,
        zerionLimits: {
          minute: integer(env, 'ZERION_REQUESTS_PER_MINUTE', DEFAULT_ZERION_LIMITS.minute, 1, 1000),
          day: integer(env, 'ZERION_REQUESTS_PER_DAY', DEFAULT_ZERION_LIMITS.day, 1, 10000),
          month: integer(env, 'ZERION_REQUESTS_PER_MONTH', DEFAULT_ZERION_LIMITS.month, 1, 250000),
        },
		nownodesApiKey: env.NOWNODES_API_KEY?.trim() || undefined,
		realtimeSchedulerSecret: env.REALTIME_SCHEDULER_SECRET?.trim() || undefined,
		coingeckoApiKey: env.COINGECKO_API_KEY?.trim() || undefined,
		swapkitApiKey: env.SWAPKIT_API_KEY?.trim() || undefined,
		zeroxApiKey: env.ZEROX_API_KEY?.trim() || undefined,
		hiveOnboardingEnabled: env.HIVE_ONBOARDING_ENABLED?.trim().toLowerCase() === "true",
		hiveSponsorAccount: env.HIVE_SPONSOR_ACCOUNT?.trim() || undefined,
		hiveSponsorActiveWif: env.HIVE_SPONSOR_ACTIVE_WIF?.trim() || undefined,
	};
}

function swapProviders(env:Environment):SwapProviderOptions {
	const out:SwapProviderOptions={};
	if(env.NEAR_API_SECRET || env.NEAR_AFFILIATE_RECIPIENT || env.NEAR_AFFILIATE_BPS!==undefined)out.near={
		...(env.NEAR_API_SECRET?{apiKey:env.NEAR_API_SECRET.trim()}:{}),...(env.NEAR_AFFILIATE_RECIPIENT?{feeRecipient:env.NEAR_AFFILIATE_RECIPIENT.trim()}:{}),...(env.NEAR_AFFILIATE_BPS!==undefined?{feeBps:integer(env,'NEAR_AFFILIATE_BPS',30,0,450)}:{})};
	if(env.RELAY_AFFILIATE_BPS!==undefined || env.RELAY_AFFILIATE_ADDRESS || env.RELAY_AFFILIATE_ADDRESS_2)out.relay={feeBps:integer(env,'RELAY_AFFILIATE_BPS',30,0,1000),feeRecipients:[env.RELAY_AFFILIATE_ADDRESS||'0x87Ab2637bc4231604ad708c5e8aAC92A260c7704',env.RELAY_AFFILIATE_ADDRESS_2||'0x21c9a94AF76B59b171b32fD125A4edF0e9A2Ad3e'].map(v=>v.trim()).filter(Boolean)};
	for(const [provider,prefix,max] of [['thorchain','THORCHAIN',1000],['mayachain','MAYACHAIN',500]] as const)if(env[`${prefix}_AFFILIATE`] || env[`${prefix}_AFFILIATE_BPS`]!==undefined)out[provider]={affiliate:env[`${prefix}_AFFILIATE`]||'keep',affiliateBps:integer(env,`${prefix}_AFFILIATE_BPS`,30,0,max)};
	return out;
}
