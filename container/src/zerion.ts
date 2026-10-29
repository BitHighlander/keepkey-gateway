import type { PersistentCache } from "./cache";
import chainData from "../data/chains.json";

const ZERION_API_BASE = "https://api.zerion.io/v1";
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const POSITION_FRESH_MS = 15 * 60_000;
const POSITION_STALE_MS = 24 * 60 * 60_000;
const CHAIN_FRESH_MS = 24 * 60 * 60_000;
const CHAIN_STALE_MS = 7 * 24 * 60 * 60_000;
const MAX_MEMORY_POSITION_ENTRIES = 500;
const WALLET_FRESH_MS = 30_000;
const WALLET_STALE_MS = 5 * 60_000;
const VAULT_EVM_NETWORKS = new Set(["eip155:1", "eip155:10", "eip155:56", "eip155:100", "eip155:137", "eip155:143", "eip155:999", "eip155:4663", "eip155:8453", "eip155:42161", "eip155:43114"]);
const NATIVE_CAIP_BY_NETWORK = new Map(Object.entries(chainData as Record<string, any>).map(([networkId, chain]) => [networkId, String(chain.nativeAssetCaip || "")]));

interface ZerionClientOptions {
	apiKey: string;
	baseUrl?: string;
	fetch?: typeof fetch;
	cacheTtlMs?: number;
	cache?: PersistentCache;
}

interface CacheEntry<T> {
	value: T;
	expiresAt: number;
}

export interface DefiPositionToken {
	networkId: string;
	address: string;
	symbol?: string;
	balance?: string;
	balanceUsd?: number;
}

export interface DefiPosition {
	pubkey: string;
	type: "contract-position";
	positionType: string;
	protocol: string;
	displayName: string;
	label: string;
	network: string;
	networkId: string;
	balanceUsd: number;
	icon?: string;
	tokens: DefiPositionToken[];
	groupId?: string;
}

export interface ZerionWalletPosition {
	caip: string;
	networkId: string;
	contract?: string;
	type: "native" | "token";
	symbol: string;
	name: string;
	balance: string;
	balanceUsd: number;
	priceUsd: number;
	decimals: number;
	icon?: string;
}

export interface ZerionTransaction {
	txid: string;
	networkId: string;
	direction: "sent" | "received" | "self";
	type: "transfer" | "token_transfer" | "swap" | "stake" | "unstake" | "reward" | "contract";
	status: "confirmed" | "pending" | "failed";
	blockHeight?: number;
	timestamp: number;
	from: string[];
	to: string[];
	value: string;
	fee?: string;
}

export class ZerionError extends Error {
	constructor(message: string, public readonly status: number) {
		super(message);
	}
}

function asObject(value: unknown): Record<string, any> {
	return value && typeof value === "object" ? value as Record<string, any> : {};
}

function externalIdToNetworkId(externalId: unknown): string | null {
	if (typeof externalId !== "string" || !/^0x[0-9a-f]+$/i.test(externalId)) return null;
	try {
		return `eip155:${BigInt(externalId).toString(10)}`;
	} catch {
		return null;
	}
}

export function normalizeZerionPositions(
	address: string,
	rawPositions: unknown,
	chainNetworkIds: ReadonlyMap<string, string>,
): DefiPosition[] {
	if (!Array.isArray(rawPositions)) return [];
	const normalizedAddress = address.toLowerCase();
	const result: DefiPosition[] = [];

	for (const raw of rawPositions) {
		const item = asObject(raw);
		const attributes = asObject(item.attributes);
		const relationships = asObject(item.relationships);
		const chainId = String(asObject(asObject(relationships.chain).data).id || "");
		const networkId = chainNetworkIds.get(chainId);
		if (!chainId || !networkId) continue;

		const fungible = asObject(attributes.fungible_info);
		const implementations = Array.isArray(fungible.implementations) ? fungible.implementations : [];
		const implementation = implementations.find((candidate: unknown) => asObject(candidate).chain_id === chainId);
		const token = asObject(implementation);
		const quantity = asObject(attributes.quantity);
		const application = asObject(attributes.application_metadata);
		const dappId = String(asObject(asObject(relationships.dapp).data).id || "");
		const protocol = String(attributes.protocol || dappId || application.name || "unknown");
		const displayName = String(application.name || attributes.protocol || dappId || "DeFi Position");
		const symbol = typeof fungible.symbol === "string" ? fungible.symbol : undefined;
		const balanceUsd = Number(attributes.value);
		const positionType = String(attributes.position_type || attributes.protocol_module || "unknown");
		const tokens: DefiPositionToken[] = [];

		if (typeof token.address === "string" && EVM_ADDRESS.test(token.address)) {
			tokens.push({
				networkId,
				address: token.address.toLowerCase(),
				symbol,
				balance: quantity.numeric == null ? undefined : String(quantity.numeric),
				balanceUsd: Number.isFinite(balanceUsd) ? balanceUsd : 0,
			});
		}

		result.push({
			pubkey: normalizedAddress,
			type: "contract-position",
			positionType,
			protocol,
			displayName,
			label: String(attributes.name || fungible.name || symbol || displayName),
			network: chainId,
			networkId,
			balanceUsd: Number.isFinite(balanceUsd) ? balanceUsd : 0,
			icon: typeof application.icon?.url === "string"
				? application.icon.url
				: typeof fungible.icon?.url === "string" ? fungible.icon.url : undefined,
			tokens,
			groupId: typeof attributes.group_id === "string" ? attributes.group_id : undefined,
		});
	}

	return result.sort((a, b) => b.balanceUsd - a.balanceUsd);
}

export function normalizeZerionWalletPositions(
	rawPositions: unknown,
	chainNetworkIds: ReadonlyMap<string, string>,
): ZerionWalletPosition[] {
	if (!Array.isArray(rawPositions)) return [];
	const result: ZerionWalletPosition[] = [];
	for (const raw of rawPositions) {
		const item = asObject(raw);
		const attributes = asObject(item.attributes);
		const relationships = asObject(item.relationships);
		const chainId = String(asObject(asObject(relationships.chain).data).id || "");
		const networkId = chainNetworkIds.get(chainId);
		if (!networkId || !VAULT_EVM_NETWORKS.has(networkId)) continue;
		const fungible = asObject(attributes.fungible_info);
		const quantity = asObject(attributes.quantity);
		const balance = String(quantity.numeric ?? "0");
		if (!(Number(balance) > 0)) continue;
		const implementation = (Array.isArray(fungible.implementations) ? fungible.implementations : [])
			.map(asObject)
			.find((candidate) => candidate.chain_id === chainId);
		if (!implementation) continue;
		const contract = typeof implementation.address === "string" && EVM_ADDRESS.test(implementation.address)
			? implementation.address.toLowerCase()
			: undefined;
		const isNative = !contract;
		// Zerion receives enormous quantities of unsolicited, unverified ERC-20s.
		// Native assets always pass; indexed tokens must be verified. Explicit
		// custom contracts are read directly by PortfolioClient instead.
		if (!isNative && asObject(fungible.flags).verified !== true) continue;
		const caip = isNative ? NATIVE_CAIP_BY_NETWORK.get(networkId) : `${networkId}/erc20:${contract}`;
		if (!caip) continue;
		const balanceUsd = Number(attributes.value);
		const safeBalanceUsd = Number.isFinite(balanceUsd) ? balanceUsd : 0;
		const numericBalance = Number(balance);
		result.push({
			caip,
			networkId,
			contract,
			type: isNative ? "native" : "token",
			symbol: String(fungible.symbol || "UNKNOWN"),
			name: String(fungible.name || attributes.name || fungible.symbol || "Unknown asset"),
			balance,
			balanceUsd: safeBalanceUsd,
			priceUsd: numericBalance > 0 ? safeBalanceUsd / numericBalance : 0,
			decimals: Number.isInteger(Number(implementation.decimals)) ? Number(implementation.decimals) : Number(quantity.decimals) || 18,
			icon: typeof fungible.icon?.url === "string" ? fungible.icon.url : undefined,
		});
	}
	return result.sort((a, b) => b.balanceUsd - a.balanceUsd).slice(0, 500);
}

export function normalizeZerionTransactions(
	address: string,
	rawTransactions: unknown,
	chainNetworkIds: ReadonlyMap<string, string>,
): ZerionTransaction[] {
	if (!Array.isArray(rawTransactions)) return [];
	const wallet = address.toLowerCase();
	const result: ZerionTransaction[] = [];
	for (const raw of rawTransactions) {
		const item = asObject(raw);
		const attributes = asObject(item.attributes);
		const relationships = asObject(item.relationships);
		const chainId = String(asObject(asObject(relationships.chain).data).id || "");
		const networkId = chainNetworkIds.get(chainId);
		const hash = String(attributes.hash || "");
		if (!networkId || !/^0x[a-fA-F0-9]{64}$/.test(hash)) continue;
		const from = typeof attributes.sent_from === "string" ? attributes.sent_from.toLowerCase() : "";
		const to = typeof attributes.sent_to === "string" ? attributes.sent_to.toLowerCase() : "";
		const operation = String(attributes.operation_type || "").toLowerCase();
		const transfers = Array.isArray(attributes.transfers) ? attributes.transfers.map(asObject) : [];
		const primaryTransfer = transfers.find((transfer) => {
			const sender = String(transfer.sender || "").toLowerCase();
			const recipient = String(transfer.recipient || "").toLowerCase();
			return sender === wallet || recipient === wallet;
		}) || transfers[0];
		const implementation = (Array.isArray(asObject(primaryTransfer?.fungible_info).implementations)
			? asObject(primaryTransfer?.fungible_info).implementations : []).map(asObject).find((candidate: Record<string, any>) => candidate.chain_id === chainId);
		const tokenTransfer = typeof implementation?.address === "string" && EVM_ADDRESS.test(implementation.address);
		const minedAt = Date.parse(String(attributes.mined_at || ""));
		const status = String(attributes.status || "").toLowerCase();
		const direction = from === wallet && to === wallet ? "self" : from === wallet ? "sent" : "received";
		const mappedType = operation === "trade" ? "swap"
			: operation === "stake" || operation === "unstake" ? operation
				: operation === "claim" ? "reward"
					: operation === "send" || operation === "receive" ? (tokenTransfer ? "token_transfer" : "transfer")
						: "contract";
		result.push({
			txid: hash.toLowerCase(),
			networkId,
			direction,
			type: mappedType,
			status: status === "failed" ? "failed" : status === "confirmed" ? "confirmed" : "pending",
			blockHeight: Number.isInteger(Number(attributes.mined_at_block)) ? Number(attributes.mined_at_block) : undefined,
			timestamp: Number.isFinite(minedAt) ? Math.floor(minedAt / 1000) : Math.floor(Date.now() / 1000),
			from: from ? [from] : [],
			to: to ? [to] : [],
			value: String(asObject(primaryTransfer?.quantity).int || "0"),
			fee: asObject(asObject(attributes.fee).quantity).int == null ? undefined : String(asObject(asObject(attributes.fee).quantity).int),
		});
	}
	return result;
}

export class ZerionClient {
	private readonly baseUrl: string;
	private readonly fetcher: typeof fetch;
	private readonly authorization: string;
	private readonly cacheTtlMs: number;
	private readonly persistentCache?: PersistentCache;
	private readonly positionCache = new Map<string, CacheEntry<DefiPosition[]>>();
	private readonly inFlight = new Map<string, Promise<DefiPosition[]>>();
	private readonly walletCache = new Map<string, CacheEntry<ZerionWalletPosition[]>>();
	private readonly walletInFlight = new Map<string, Promise<ZerionWalletPosition[]>>();
	private readonly transactionCache = new Map<string, CacheEntry<ZerionTransaction[]>>();
	private readonly transactionInFlight = new Map<string, Promise<ZerionTransaction[]>>();
	private chainCache?: CacheEntry<Map<string, string>>;

	constructor(options: ZerionClientOptions) {
		this.baseUrl = (options.baseUrl || ZERION_API_BASE).replace(/\/$/, "");
		this.fetcher = options.fetch || fetch;
		this.authorization = `Basic ${btoa(`${options.apiKey}:`)}`;
		this.cacheTtlMs = options.cacheTtlMs ?? POSITION_FRESH_MS;
		this.persistentCache = options.cache;
	}

	async getDefiPositions(address: string): Promise<DefiPosition[]> {
		if (!EVM_ADDRESS.test(address)) throw new ZerionError("Invalid EVM address", 400);
		const key = address.toLowerCase();
		const cached = this.positionCache.get(key);
		if (cached && cached.expiresAt > Date.now()) return cached.value;
		const running = this.inFlight.get(key);
		if (running) return running;

		const request = this.loadPositions(key).finally(() => this.inFlight.delete(key));
		this.inFlight.set(key, request);
		return request;
	}

	async getWalletPositions(address: string): Promise<ZerionWalletPosition[]> {
		if (!EVM_ADDRESS.test(address)) throw new ZerionError("Invalid EVM address", 400);
		const key = address.toLowerCase();
		const cached = this.walletCache.get(key);
		if (cached && cached.expiresAt > Date.now()) return cached.value;
		const running = this.walletInFlight.get(key);
		if (running) return running;
		const request = this.loadWalletPositions(key).finally(() => this.walletInFlight.delete(key));
		this.walletInFlight.set(key, request);
		return request;
	}

	async getTransactions(address: string): Promise<ZerionTransaction[]> {
		if (!EVM_ADDRESS.test(address)) throw new ZerionError("Invalid EVM address", 400);
		const key = address.toLowerCase();
		const cached = this.transactionCache.get(key);
		if (cached && cached.expiresAt > Date.now()) return cached.value;
		const running = this.transactionInFlight.get(key);
		if (running) return running;
		const request = this.loadTransactions(key).finally(() => this.transactionInFlight.delete(key));
		this.transactionInFlight.set(key, request);
		return request;
	}

	private async loadTransactions(address: string): Promise<ZerionTransaction[]> {
		const persisted = await this.persistentCache?.getFresh<ZerionTransaction[]>("zerion_transactions", address);
		if (persisted) return this.rememberTransactions(address, persisted);
		const chainNetworkIds = await this.getChainNetworkIds();
		const chainIds = [...chainNetworkIds.entries()]
			.filter(([, networkId]) => VAULT_EVM_NETWORKS.has(networkId))
			.map(([chainId]) => chainId)
			.sort();
		const fetchAndStore = async (): Promise<ZerionTransaction[]> => {
			const afterLock = await this.persistentCache?.getFresh<ZerionTransaction[]>("zerion_transactions", address);
			if (afterLock) return this.rememberTransactions(address, afterLock);
			const params = new URLSearchParams({ currency: "usd", "page[size]": "50", "filter[trash]": "only_non_trash", "filter[chain_ids]": chainIds.join(",") });
			const body = asObject(await this.request(`${this.baseUrl}/wallets/${address}/transactions/?${params}`));
			const transactions = normalizeZerionTransactions(address, body.data, chainNetworkIds);
			await this.persistentCache?.set("zerion_transactions", address, transactions, 15_000, 5 * 60_000, "zerion");
			return this.rememberTransactions(address, transactions);
		};
		try {
			return this.persistentCache
				? await this.persistentCache.runExclusive(`zerion:transactions:${address}`, fetchAndStore)
				: await fetchAndStore();
		} catch (error) {
			const stale = await this.persistentCache?.getStale<ZerionTransaction[]>("zerion_transactions", address);
			if (stale) return this.rememberTransactions(address, stale);
			throw error;
		}
	}

	private rememberTransactions(address: string, transactions: ZerionTransaction[]): ZerionTransaction[] {
		this.transactionCache.delete(address);
		this.transactionCache.set(address, { value: transactions, expiresAt: Date.now() + 15_000 });
		while (this.transactionCache.size > 200) {
			const oldest = this.transactionCache.keys().next().value;
			if (typeof oldest !== "string") break;
			this.transactionCache.delete(oldest);
		}
		return transactions;
	}

	private async loadWalletPositions(address: string): Promise<ZerionWalletPosition[]> {
		const persisted = await this.persistentCache?.getFresh<ZerionWalletPosition[]>("zerion_wallet_positions", address);
		if (persisted) {
			this.rememberWallet(address, persisted);
			return persisted;
		}
		const chainNetworkIds = await this.getChainNetworkIds();
		const chainIds = [...chainNetworkIds.entries()]
			.filter(([, networkId]) => VAULT_EVM_NETWORKS.has(networkId))
			.map(([chainId]) => chainId)
			.sort();
		const fetchAndStore = async (): Promise<ZerionWalletPosition[]> => {
			const afterLock = await this.persistentCache?.getFresh<ZerionWalletPosition[]>("zerion_wallet_positions", address);
			if (afterLock) {
				this.rememberWallet(address, afterLock);
				return afterLock;
			}
			const params = new URLSearchParams({ currency: "usd", "filter[positions]": "only_simple", "filter[chain_ids]": chainIds.join(","), sort: "-value" });
			const body = asObject(await this.request(`${this.baseUrl}/wallets/${address}/positions/?${params}`));
			const positions = normalizeZerionWalletPositions(body.data, chainNetworkIds);
			await this.persistentCache?.set("zerion_wallet_positions", address, positions, WALLET_FRESH_MS, WALLET_STALE_MS, "zerion");
			this.rememberWallet(address, positions);
			return positions;
		};
		try {
			return this.persistentCache
				? await this.persistentCache.runExclusive(`zerion:wallet:${address}`, fetchAndStore)
				: await fetchAndStore();
		} catch (error) {
			const stale = await this.persistentCache?.getStale<ZerionWalletPosition[]>("zerion_wallet_positions", address);
			if (stale) return stale;
			throw error;
		}
	}

	private rememberWallet(address: string, positions: ZerionWalletPosition[]): void {
		this.walletCache.delete(address);
		this.walletCache.set(address, { value: positions, expiresAt: Date.now() + WALLET_FRESH_MS });
		while (this.walletCache.size > 200) {
			const oldest = this.walletCache.keys().next().value;
			if (typeof oldest !== "string") break;
			this.walletCache.delete(oldest);
		}
	}

	private async loadPositions(address: string): Promise<DefiPosition[]> {
		const persisted = await this.persistentCache?.getFresh<DefiPosition[]>("zerion_positions", address);
		if (persisted) {
			this.rememberPositions(address, persisted);
			return persisted;
		}

		const chainNetworkIds = await this.getChainNetworkIds();
		const fetchAndStore = async (): Promise<DefiPosition[]> => {
			const afterLock = await this.persistentCache?.getFresh<DefiPosition[]>("zerion_positions", address);
			if (afterLock) {
				this.rememberPositions(address, afterLock);
				return afterLock;
			}
			const response = await this.request(`${this.baseUrl}/wallets/${address}/positions/?currency=usd&filter%5Bpositions%5D=only_complex&sort=-value`);
			const body = asObject(response);
			const positions = normalizeZerionPositions(address, body.data, chainNetworkIds);
			await this.persistentCache?.set("zerion_positions", address, positions, this.cacheTtlMs, POSITION_STALE_MS, "zerion");
			this.rememberPositions(address, positions);
			return positions;
		};

		return this.persistentCache
			? this.persistentCache.runExclusive(`zerion:positions:${address}`, fetchAndStore)
			: fetchAndStore();
	}

	private rememberPositions(address: string, positions: DefiPosition[]): void {
		this.positionCache.delete(address);
		this.positionCache.set(address, { value: positions, expiresAt: Date.now() + this.cacheTtlMs });
		while (this.positionCache.size > MAX_MEMORY_POSITION_ENTRIES) {
			const oldest = this.positionCache.keys().next().value;
			if (typeof oldest !== "string") break;
			this.positionCache.delete(oldest);
		}
	}

	private async fetchChainNetworkIds(): Promise<Map<string, string>> {
		const body = asObject(await this.request(`${this.baseUrl}/chains/`));
		const map = new Map<string, string>();
		for (const raw of Array.isArray(body.data) ? body.data : []) {
			const item = asObject(raw);
			const networkId = externalIdToNetworkId(asObject(item.attributes).external_id);
			if (typeof item.id === "string" && networkId) map.set(item.id, networkId);
		}
		const record = Object.fromEntries(map);
		await this.persistentCache?.set("zerion_metadata", "chains", record, CHAIN_FRESH_MS, CHAIN_STALE_MS, "zerion");
		this.chainCache = { value: map, expiresAt: Date.now() + CHAIN_FRESH_MS };
		return map;
	}

	private async getChainNetworkIds(): Promise<Map<string, string>> {
		if (this.chainCache && this.chainCache.expiresAt > Date.now()) return this.chainCache.value;
		const persisted = await this.persistentCache?.getFresh<Record<string, string>>("zerion_metadata", "chains");
		if (persisted) {
			const map = new Map(Object.entries(persisted));
			this.chainCache = { value: map, expiresAt: Date.now() + CHAIN_FRESH_MS };
			return map;
		}
		return this.persistentCache
			? this.persistentCache.runExclusive("zerion:metadata:chains", async () => {
				const afterLock = await this.persistentCache?.getFresh<Record<string, string>>("zerion_metadata", "chains");
				if (afterLock) {
					const map = new Map(Object.entries(afterLock));
					this.chainCache = { value: map, expiresAt: Date.now() + CHAIN_FRESH_MS };
					return map;
				}
				return this.fetchChainNetworkIds();
			})
			: this.fetchChainNetworkIds();
	}

	private async request(url: string): Promise<unknown> {
		const response = await this.fetcher(url, {
			headers: { Accept: "application/json", Authorization: this.authorization },
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) {
			const retryAfter = response.headers.get("retry-after");
			throw new ZerionError(`Zerion request failed (${response.status})${retryAfter ? `; retry after ${retryAfter}` : ""}`, response.status);
		}
		return response.json();
	}
}
