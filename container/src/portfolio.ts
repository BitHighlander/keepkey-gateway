import chainData from "../data/chains.json";
import { formatUnits, type EvmClient } from "./evm";
import type { MarketClient } from "./market";
import type { UtxoClient } from "./utxo";
import type { DefiPosition, ZerionClient, ZerionWalletPosition } from "./zerion";
import type { MultichainClient } from "./multichain";
import type { HiveClient } from "./hive";

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const MAX_PUBKEYS = 100;
const MAX_EXTRA_CONTRACTS = 20;

interface PortfolioPubkey {
	caip: string;
	pubkey: string;
}

interface ExtraContract {
	networkId: string;
	contractAddress: string;
	decimals: number;
	symbol?: string;
	name?: string;
	icon?: string;
}

export interface PortfolioRequest {
	pubkeys: PortfolioPubkey[];
	includeDefi?: boolean;
	extraContracts?: ExtraContract[];
}

export interface PortfolioBalance {
	caip: string;
	pubkey: string;
	address?: string;
	balance: string;
	priceUsd: string;
	valueUsd: string;
	symbol: string;
	name: string;
	networkId: string;
	contract?: string;
	type: "native" | "token";
	isNative: boolean;
	decimals: number;
	precision: number;
	fetchedAt: number;
	fetchedAtISO: string;
	isStale: boolean;
	degraded: boolean;
	dataSource: string;
	verified: boolean;
	isScam: boolean;
	icon?: string;
}

export interface PortfolioFailure {
	caip: string;
	reason: string;
}

export interface PortfolioResponse {
	balances: PortfolioBalance[];
	pendingSwaps: unknown[];
	snapshot: { at: string; heights: Record<string, number> };
	meta: {
		traceId: string;
		serverMs: number;
		degraded: boolean;
		degradedCount: number;
		failures: PortfolioFailure[];
		staleChains: string[];
	};
	defiPositions?: DefiPosition[];
}

interface PortfolioDependencies {
	evm?: Pick<EvmClient, "getBalance" | "getTokenBalance">;
	utxo?: Pick<UtxoClient, "getPubkeyInfo">;
	market?: Pick<MarketClient, "getPrices">;
	zerion?: Pick<ZerionClient, "getWalletPositions" | "getDefiPositions">;
	multichain?: Pick<MultichainClient, "getBalances">;
	hive?: Pick<HiveClient, "account">;
}

interface NativeMetadata {
	caip: string;
	networkId: string;
	symbol: string;
	name: string;
	decimals: number;
}

export class PortfolioError extends Error {
	constructor(message: string, public readonly status = 400) {
		super(message);
	}
}

function objectValue(value: unknown): Record<string, any> {
	return value && typeof value === "object" ? value as Record<string, any> : {};
}

function networkIdFromCaip(caip: string): string {
	return caip.split("/")[0];
}

function nativeMetadata(caip: string): NativeMetadata {
	const networkId = networkIdFromCaip(caip);
	const overrides: Record<string, { symbol: string; name: string; decimals: number }> = {
		"eip155:100": { symbol: "xDAI", name: "Gnosis", decimals: 18 },
		"eip155:143": { symbol: "MON", name: "Monad", decimals: 18 },
		"eip155:999": { symbol: "HYPE", name: "Hyperliquid", decimals: 18 },
		"eip155:4663": { symbol: "ETH", name: "Robinhood Chain", decimals: 18 },
	};
	const chain = objectValue((chainData as Record<string, unknown>)[networkId]);
	const currency = objectValue(chain.nativeCurrency);
	const override = overrides[networkId];
	return {
		caip: String(chain.nativeAssetCaip || caip),
		networkId,
		symbol: override?.symbol || String(currency.symbol || "UNKNOWN"),
		name: override?.name || String(currency.name || chain.name || currency.symbol || "Unknown asset"),
		decimals: override?.decimals ?? (Number.isInteger(Number(currency.decimals)) ? Number(currency.decimals) : networkId.startsWith("bip122:") ? 8 : 18),
	};
}

function safeDecimal(value: unknown): string {
	const text = String(value ?? "0");
	return /^\d+(\.\d+)?$/.test(text) ? text : "0";
}

function usd(value: number): string {
	return Number.isFinite(value) && value >= 0 ? String(value) : "0";
}

function balanceKey(balance: Pick<PortfolioBalance, "caip" | "pubkey">): string {
	return `${balance.caip.toLowerCase()}|${balance.pubkey.toLowerCase()}`;
}

export class PortfolioClient {
	constructor(private readonly dependencies: PortfolioDependencies) {}

	async getBalances(body: PortfolioRequest): Promise<PortfolioResponse> {
		this.validate(body);
		const startedAt = performance.now();
		const fetchedAt = Date.now();
		const fetchedAtISO = new Date(fetchedAt).toISOString();
		const traceId = crypto.randomUUID();
		const balances = new Map<string, PortfolioBalance>();
		const failures: PortfolioFailure[] = [];
		const entries = body.pubkeys.map((entry) => ({ ...entry, caip: entry.caip.trim(), pubkey: entry.pubkey.trim(), networkId: networkIdFromCaip(entry.caip.trim()) }));
		const utxoEntries = entries.filter((entry) => entry.networkId.startsWith("bip122:"));
		const evmEntries = entries.filter((entry) => entry.networkId.startsWith("eip155:"));
		const hiveEntries = entries.filter((entry) => entry.networkId.startsWith("hive:"));
		const multichainEntries = entries.filter((entry) => !entry.networkId.startsWith("bip122:") && !entry.networkId.startsWith("eip155:") && !entry.networkId.startsWith("hive:"));

		await Promise.all(hiveEntries.map(async (entry) => {
			if (!this.dependencies.hive) {
				failures.push({ caip: entry.caip, reason: "Hive provider is not configured" });
				return;
			}
			try {
				const result = await this.dependencies.hive.account(entry.pubkey) as any;
				if (result?.success !== true) throw new Error(String(result?.error || "Hive account lookup failed"));
				const account = objectValue(result.account);
				const accountName = typeof account.name === "string" ? account.name : entry.pubkey;
				const metadata = nativeMetadata(entry.caip);
				const native = this.makeBalance({
					...metadata,
					caip: entry.caip,
					pubkey: entry.pubkey,
					address: accountName,
					balance: result.noAccount ? "0" : safeDecimal(account.hive),
					dataSource: "hive-rpc",
					fetchedAt,
					fetchedAtISO,
				});
				balances.set(balanceKey(native), native);

				const hbd = safeDecimal(account.hbd);
				if (Number(hbd) > 0) {
					const token = this.makeBalance({
						caip: `${entry.networkId}/token:HBD`,
						networkId: entry.networkId,
						pubkey: entry.pubkey,
						address: accountName,
						contract: "HBD",
						type: "token",
						symbol: "HBD",
						name: "Hive Backed Dollar",
						decimals: 3,
						balance: hbd,
						dataSource: "hive-rpc",
						fetchedAt,
						fetchedAtISO,
					});
					balances.set(balanceKey(token), token);
				}
			} catch (error) {
				failures.push({ caip: entry.caip, reason: this.reason(error) });
			}
		}));

		await Promise.all(multichainEntries.map(async (entry) => {
			if (!this.dependencies.multichain) {
				failures.push({ caip: entry.caip, reason: `Unsupported portfolio network: ${entry.networkId}` });
				return;
			}
			try {
				for (const raw of await this.dependencies.multichain.getBalances(entry.caip, entry.pubkey)) {
					const item = this.makeBalance({ ...raw, fetchedAt, fetchedAtISO });
					balances.set(balanceKey(item), item);
				}
			} catch (error) {
				failures.push({ caip: entry.caip, reason: this.reason(error) });
			}
		}));

		await Promise.all(utxoEntries.map(async (entry) => {
			if (!this.dependencies.utxo) {
				failures.push({ caip: entry.caip, reason: "UTXO provider is not configured" });
				return;
			}
			try {
				const info = await this.dependencies.utxo.getPubkeyInfo(entry.networkId, entry.pubkey);
				const metadata = nativeMetadata(entry.caip);
				const amount = formatUnits(BigInt(String(info?.balance ?? "0")), metadata.decimals);
				const tokens = Array.isArray(info?.tokens) ? info.tokens : [];
				const discoveredAddress = tokens.find((token: any) => Number(token?.transfers) > 0)?.name || tokens[0]?.name;
				const balance = this.makeBalance({
					...metadata,
					caip: entry.caip,
					pubkey: entry.pubkey,
					address: typeof discoveredAddress === "string" ? discoveredAddress : undefined,
					balance: amount,
					dataSource: "nownodes-blockbook",
					fetchedAt,
					fetchedAtISO,
				});
				balances.set(balanceKey(balance), balance);
			} catch (error) {
				failures.push({ caip: entry.caip, reason: this.reason(error) });
			}
		}));

		const positionsByAddress = new Map<string, ZerionWalletPosition[]>();
		const evmAddresses = [...new Set(evmEntries.map((entry) => entry.pubkey.toLowerCase()))];
		if (this.dependencies.zerion) {
			await Promise.all(evmAddresses.map(async (address) => {
				try {
					positionsByAddress.set(address, await this.dependencies.zerion!.getWalletPositions(address));
				} catch {
					// A direct native RPC fallback below preserves verified balances on
					// supported networks without pretending token discovery succeeded.
				}
			}));
		}

		await Promise.all(evmEntries.map(async (entry) => {
			const metadata = nativeMetadata(entry.caip);
			const address = entry.pubkey.toLowerCase();
			const positions = positionsByAddress.get(address);
			if (positions) {
				const native = positions.find((position) => position.networkId === entry.networkId && position.type === "native");
				const nativeBalance = this.makeBalance({
					...metadata,
					caip: entry.caip,
					pubkey: entry.pubkey,
					address,
					balance: native?.balance || "0",
					priceUsd: native?.priceUsd || 0,
					valueUsd: native?.balanceUsd || 0,
					icon: native?.icon,
					dataSource: "zerion",
					fetchedAt,
					fetchedAtISO,
				});
				balances.set(balanceKey(nativeBalance), nativeBalance);

				for (const token of positions.filter((position) => position.networkId === entry.networkId && position.type === "token")) {
					const tokenBalance = this.makeBalance({
						caip: token.caip,
						networkId: token.networkId,
						pubkey: entry.pubkey,
						address,
						contract: token.contract,
						type: "token",
						symbol: token.symbol,
						name: token.name,
						decimals: token.decimals,
						balance: token.balance,
						priceUsd: token.priceUsd,
						valueUsd: token.balanceUsd,
						icon: token.icon,
						dataSource: "zerion",
						fetchedAt,
						fetchedAtISO,
					});
					balances.set(balanceKey(tokenBalance), tokenBalance);
				}
				return;
			}

			if (!this.dependencies.evm) {
				failures.push({ caip: entry.caip, reason: "EVM balance providers are not configured" });
				return;
			}
			try {
				const direct = await this.dependencies.evm.getBalance(entry.networkId, address);
				const balance = this.makeBalance({
					...metadata,
					caip: entry.caip,
					pubkey: entry.pubkey,
					address,
					balance: direct.balance,
					dataSource: "nownodes",
					fetchedAt,
					fetchedAtISO,
				});
				balances.set(balanceKey(balance), balance);
			} catch (error) {
				failures.push({ caip: entry.caip, reason: this.reason(error) });
			}
		}));

		await Promise.all((body.extraContracts || []).flatMap((contract) => {
			const owners = [...new Set(evmEntries.filter((entry) => entry.networkId.toLowerCase() === contract.networkId.toLowerCase()).map((entry) => entry.pubkey.toLowerCase()))];
			return owners.map(async (owner) => {
				const caip = `${contract.networkId.toLowerCase()}/erc20:${contract.contractAddress.toLowerCase()}`;
				if (!this.dependencies.evm) {
					failures.push({ caip, reason: "Direct EVM provider is not configured for extraContracts" });
					return;
				}
				try {
					const direct = await this.dependencies.evm.getTokenBalance(contract.networkId, owner, contract.contractAddress);
					const existing = balances.get(`${caip}|${owner}`);
					const amount = safeDecimal(direct.balance);
					const price = existing ? Number(existing.priceUsd) : 0;
					const balance = this.makeBalance({
						caip,
						networkId: contract.networkId,
						pubkey: owner,
						address: owner,
						contract: contract.contractAddress.toLowerCase(),
						type: "token",
						symbol: contract.symbol || existing?.symbol || "TOKEN",
						name: contract.name || existing?.name || contract.symbol || "Custom token",
						decimals: contract.decimals,
						balance: amount,
						priceUsd: price,
						valueUsd: Number(amount) * price,
						icon: contract.icon || existing?.icon,
						dataSource: "nownodes-direct",
						fetchedAt,
						fetchedAtISO,
					});
					balances.set(balanceKey(balance), balance);
				} catch (error) {
					failures.push({ caip, reason: this.reason(error) });
				}
			});
		}));

		const unpricedNative = [...balances.values()].filter((balance) => balance.type === "native" && Number(balance.priceUsd) === 0);
		if (unpricedNative.length > 0 && this.dependencies.market) {
			try {
				const prices = await this.dependencies.market.getPrices(unpricedNative.map((balance) => balance.caip));
				unpricedNative.forEach((balance, index) => {
					const price = prices[index] || 0;
					balance.priceUsd = usd(price);
					balance.valueUsd = usd(Number(balance.balance) * price);
				});
			} catch (error) {
				for (const balance of unpricedNative) failures.push({ caip: balance.caip, reason: `Price unavailable: ${this.reason(error)}` });
			}
		}

		let defiPositions: DefiPosition[] | undefined;
		if (body.includeDefi) {
			defiPositions = [];
			if (this.dependencies.zerion) {
				const results = await Promise.allSettled(evmAddresses.map((address) => this.dependencies.zerion!.getDefiPositions(address)));
				const seen = new Set<string>();
				for (const result of results) {
					if (result.status === "rejected") continue;
					for (const position of result.value) {
						const key = `${position.pubkey}|${position.protocol}|${position.networkId}|${position.groupId || position.label}`.toLowerCase();
						if (!seen.has(key)) {
							seen.add(key);
							defiPositions.push(position);
						}
					}
				}
			}
		}

		const response: PortfolioResponse = {
			balances: [...balances.values()],
			pendingSwaps: [],
			snapshot: { at: fetchedAtISO, heights: {} },
			meta: {
				traceId,
				serverMs: Math.round((performance.now() - startedAt) * 100) / 100,
				degraded: failures.length > 0,
				degradedCount: failures.length,
				failures,
				staleChains: [],
			},
		};
		if (body.includeDefi) response.defiPositions = defiPositions;
		return response;
	}

	private validate(body: PortfolioRequest): void {
		if (!body || !Array.isArray(body.pubkeys) || body.pubkeys.length === 0 || body.pubkeys.length > MAX_PUBKEYS) {
			throw new PortfolioError(`pubkeys must contain between 1 and ${MAX_PUBKEYS} entries`);
		}
		for (const entry of body.pubkeys) {
			if (!entry || typeof entry.caip !== "string" || !entry.caip.includes("/") || typeof entry.pubkey !== "string" || !entry.pubkey.trim() || entry.pubkey.length > 512) {
				throw new PortfolioError("Each pubkey requires a valid caip and pubkey");
			}
			if (networkIdFromCaip(entry.caip).startsWith("eip155:") && !EVM_ADDRESS.test(entry.pubkey)) throw new PortfolioError(`Invalid EVM address for ${entry.caip}`);
		}
		if (body.extraContracts !== undefined && (!Array.isArray(body.extraContracts) || body.extraContracts.length > MAX_EXTRA_CONTRACTS)) {
			throw new PortfolioError(`extraContracts must contain at most ${MAX_EXTRA_CONTRACTS} entries`);
		}
		for (const contract of body.extraContracts || []) {
			if (!contract.networkId?.startsWith("eip155:") || !EVM_ADDRESS.test(contract.contractAddress) || !Number.isInteger(contract.decimals) || contract.decimals < 0 || contract.decimals > 255) {
				throw new PortfolioError("Each extra contract requires an EVM networkId, contractAddress, and decimals from 0 to 255");
			}
		}
	}

	private makeBalance(input: Omit<PortfolioBalance, "priceUsd" | "valueUsd" | "type" | "isNative" | "precision" | "isStale" | "degraded" | "verified" | "isScam"> & {
		priceUsd?: number;
		valueUsd?: number;
		type?: "native" | "token";
	}): PortfolioBalance {
		const type = input.type || "native";
		return {
			...input,
			balance: safeDecimal(input.balance),
			priceUsd: usd(input.priceUsd || 0),
			valueUsd: usd(input.valueUsd || 0),
			type,
			isNative: type === "native",
			precision: input.decimals,
			isStale: false,
			degraded: false,
			verified: true,
			isScam: false,
		};
	}

	private reason(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
