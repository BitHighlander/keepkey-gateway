import coingeckoMapping from "../data/coingecko-mapping.json";
import type { PersistentCache } from "./cache";

const COINGECKO_API_BASE = "https://pro-api.coingecko.com/api/v3";
const PRICE_FRESH_MS = 60_000;
const PRICE_STALE_MS = 10 * 60_000;
const MAX_MEMORY_PRICES = 10_000;

interface MarketClientOptions {
	apiKey: string;
	cache: PersistentCache;
	fetch?: typeof fetch;
	baseUrl?: string;
	mapping?: Readonly<Record<string, string>>;
}

interface MemoryPrice {
	price: number;
	expiresAt: number;
}

export class MarketError extends Error {
	constructor(message: string, public readonly status = 502) {
		super(message);
	}
}

export class MarketClient {
	private readonly fetcher: typeof fetch;
	private readonly baseUrl: string;
	private readonly mapping: Readonly<Record<string, string>>;
	private readonly memory = new Map<string, MemoryPrice>();
	private readonly inFlight = new Map<string, Promise<Map<string, number>>>();

	constructor(private readonly options: MarketClientOptions) {
		this.fetcher = options.fetch || fetch;
		this.baseUrl = (options.baseUrl || COINGECKO_API_BASE).replace(/\/$/, "");
		this.mapping = options.mapping || coingeckoMapping;
	}

	async getPrices(caips: readonly string[]): Promise<number[]> {
		if (caips.length > 500) throw new MarketError("At most 500 assets may be priced per request", 400);
		const ids = caips.map((caip) => this.mapping[caip.toLowerCase()] || this.mapping[caip] || null);
		const uniqueIds = [...new Set(ids.filter((id): id is string => id !== null))];
		const prices = new Map<string, number>();

		await Promise.all(uniqueIds.map(async (id) => {
			const local = this.memory.get(id);
			if (local && local.expiresAt > Date.now()) {
				prices.set(id, local.price);
				return;
			}
			const persisted = await this.options.cache.getFresh<number>("market_usd", id);
			if (persisted !== null) {
				prices.set(id, persisted);
				this.remember(id, persisted);
			}
		}));

		const missing = uniqueIds.filter((id) => !prices.has(id));
		if (missing.length > 0) {
			const fetched = await this.fetchMissing(missing);
			for (const [id, price] of fetched) prices.set(id, price);
		}

		return ids.map((id) => id === null ? 0 : prices.get(id) ?? 0);
	}

	private async fetchMissing(ids: string[]): Promise<Map<string, number>> {
		const batchKey = [...ids].sort().join(",");
		const running = this.inFlight.get(batchKey);
		if (running) return running;
		const request = this.loadMissing(ids, batchKey).finally(() => this.inFlight.delete(batchKey));
		this.inFlight.set(batchKey, request);
		return request;
	}

	private async loadMissing(ids: string[], batchKey: string): Promise<Map<string, number>> {
		try {
			return await this.options.cache.runExclusive(`market:${batchKey}`, async () => {
				const result = new Map<string, number>();
				await Promise.all(ids.map(async (id) => {
					const cached = await this.options.cache.getFresh<number>("market_usd", id);
					if (cached !== null) result.set(id, cached);
				}));
				const stillMissing = ids.filter((id) => !result.has(id));
				if (stillMissing.length === 0) return result;

				const params = new URLSearchParams({ ids: stillMissing.join(","), vs_currencies: "usd" });
				const response = await this.fetcher(`${this.baseUrl}/simple/price?${params}`, {
					headers: { Accept: "application/json", "x-cg-pro-api-key": this.options.apiKey },
					signal: AbortSignal.timeout(12_000),
				});
				if (!response.ok) throw new MarketError(`CoinGecko request failed (${response.status})`);
				const body = await response.json() as Record<string, { usd?: unknown }>;
				for (const id of stillMissing) {
					const price = Number(body[id]?.usd);
					if (!Number.isFinite(price) || price < 0) throw new MarketError(`CoinGecko returned no USD price for ${id}`);
					result.set(id, price);
					this.remember(id, price);
					await this.options.cache.set("market_usd", id, price, PRICE_FRESH_MS, PRICE_STALE_MS, "coingecko");
				}
				return result;
			});
		} catch (error) {
			const stale = new Map<string, number>();
			await Promise.all(ids.map(async (id) => {
				const value = await this.options.cache.getStale<number>("market_usd", id);
				if (value !== null) stale.set(id, value);
			}));
			if (stale.size === ids.length) return stale;
			throw error;
		}
	}

	private remember(id: string, price: number): void {
		this.memory.delete(id);
		this.memory.set(id, { price, expiresAt: Date.now() + PRICE_FRESH_MS });
		while (this.memory.size > MAX_MEMORY_PRICES) {
			const oldest = this.memory.keys().next().value;
			if (typeof oldest !== "string") break;
			this.memory.delete(oldest);
		}
	}
}
