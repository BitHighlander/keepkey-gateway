import { constants as zlibConstants } from "node:zlib";
import type { AppConfig } from "./config";
import { DisabledClientError, type Database } from "./database";
import { openApiDocument } from "./openapi";
import { ZerionClient, ZerionError } from "./zerion";
import { EvmClient, EvmError } from "./evm";
import { MarketClient, MarketError } from "./market";
import { UtxoClient, UtxoError } from "./utxo";
import { PortfolioClient, PortfolioError, type PortfolioRequest } from "./portfolio";
import { HistoryClient, HistoryError, type HistoryRequest } from "./history";
import { ChainHistoryError } from "./chain-history";
import { AccountClient, AccountError } from "./account";
import { SolanaClient, SolanaError } from "./solana";
import { Catalog } from "./catalog";
import { QuoteRouter, SwapError, type QuoteRequest } from "./swap";
import { PendingSwapError, PendingSwapService } from "./pending-swaps";
import { CosmosFeatureError, CosmosFeatures } from "./cosmos-features";
import { HiveClient, HiveError } from "./hive";
import { VaultTelemetry } from "./telemetry";
import { MultichainBroadcastClient, MultichainBroadcastError } from "./multichain-broadcast";
import { RealtimeError, RealtimeHub } from "./realtime";

interface AppDependencies {
	config: AppConfig;
	database: Database;
	zerion?: ZerionClient;
	evm?: EvmClient;
	market?: MarketClient;
	utxo?: UtxoClient;
	portfolio?: PortfolioClient;
	history?: HistoryClient;
	account?: AccountClient;
	solana?: SolanaClient;
	catalog?: Catalog;
	quoteRouter?: QuoteRouter;
	pendingSwaps?: PendingSwapService;
	cosmosFeatures?: CosmosFeatures;
	hive?: HiveClient;
	telemetry?: VaultTelemetry;
	multichainBroadcast?: MultichainBroadcastClient;
	realtime?: RealtimeHub;
}

class HttpError extends Error {
	constructor(public readonly status: number, public readonly code: string, message: string) {
		super(message);
	}
}

function json(body: unknown, status = 200, requestId?: string, extraHeaders?: HeadersInit): Response {
	return Response.json(body, {
		status,
		headers: { ...(requestId ? { "x-request-id": requestId } : {}), ...(extraHeaders || {}) },
	});
}

async function bodyObject(request: Request): Promise<Record<string, unknown>> {
	try {
		const body = await request.json();
		if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
		return body as Record<string, unknown>;
	} catch {
		throw new HttpError(400, "invalid_json", "Request body must be a JSON object");
	}
}

async function bodyStringArray(request: Request): Promise<string[]> {
	try {
		const body = await request.json();
		if (!Array.isArray(body) || body.some((value) => typeof value !== "string" || !value.trim())) throw new Error();
		return body;
	} catch {
		throw new HttpError(400, "invalid_json", "Request body must be an array of CAIP strings");
	}
}

function queryKey(request: Request): string | null {
	return request.headers.get("authorization")?.trim()
		|| request.headers.get("x-api-key")?.trim()
		|| null;
}

export function createApp({ database, zerion, evm, market, utxo, portfolio, history, account, solana, catalog, quoteRouter, pendingSwaps, cosmosFeatures, hive, telemetry, multichainBroadcast, realtime }: AppDependencies): { fetch(request: Request): Promise<Response> } {
	return {
		async fetch(request) {
			const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
			const url = new URL(request.url);
			const startedAt = performance.now();

			try {
				if (request.method === "HEAD" && url.pathname === "/") return new Response(null, { status: 204 });
				if (request.method === "GET" && url.pathname === "/spec/swagger.json") {
					return json(openApiDocument(request.url), 200, requestId);
				}
				if (request.method === "GET" && (url.pathname === "/api/v1/health" || url.pathname === "/api/v1/ready")) {
					await database.ping();
					return json({
						status: "ok",
						service: "keepkey-gateway",
						runtime: {
							bun: Bun.version,
							brotliBlockSwitch: (zlibConstants as Record<string, number | undefined>).BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH ?? null,
						},
						database: "ok",
						evm: evm ? "enabled" : "disabled",
						market: market ? "enabled" : "disabled",
						utxo: utxo ? "enabled" : "disabled",
						zerion: zerion ? "enabled" : "disabled",
						portfolio: portfolio ? "enabled" : "disabled",
						history: history ? "enabled" : "disabled",
						account: account ? "enabled" : "disabled",
						solana: solana ? "enabled" : "disabled",
						catalog: catalog ? "enabled" : "disabled",
						quotes: quoteRouter ? "enabled" : "disabled",
						pendingSwaps: pendingSwaps ? "enabled" : "disabled",
						hive: hive ? "enabled" : "disabled",
					}, 200, requestId, { "Cache-Control": "no-store" });
				}

				const hiveAccountMatch = url.pathname.match(/^\/api\/v1\/hive\/account\/([^/]+)$/);
				if (request.method === "GET" && hiveAccountMatch) {
					if (!hive) throw new HttpError(503, "feature_unavailable", "Hive is unavailable");
					return json(await hive.account(decodeURIComponent(hiveAccountMatch[1])), 200, requestId, { "Cache-Control": "no-store" });
				}

				const hiveUsernameMatch = url.pathname.match(/^\/api\/v1\/hive\/username-available\/([^/]+)$/);
				if (request.method === "GET" && hiveUsernameMatch) {
					if (!hive) throw new HttpError(503, "feature_unavailable", "Hive is unavailable");
					return json(await hive.usernameAvailable(decodeURIComponent(hiveUsernameMatch[1])), 200, requestId, { "Cache-Control": "no-store" });
				}

				if (request.method === "GET" && url.pathname === "/api/v1/hive/tx-params") {
					if (!hive) throw new HttpError(503, "feature_unavailable", "Hive is unavailable");
					return json(await hive.txParams(), 200, requestId, { "Cache-Control": "no-store" });
				}

				const hiveHistoryMatch = url.pathname.match(/^\/api\/v1\/hive\/history\/([^/]+)$/);
				if (request.method === "GET" && hiveHistoryMatch) {
					if (!hive) throw new HttpError(503, "feature_unavailable", "Hive is unavailable");
					return json(await hive.history(decodeURIComponent(hiveHistoryMatch[1])), 200, requestId, { "Cache-Control": "no-store" });
				}

				if (request.method === "POST" && url.pathname === "/api/v1/hive/broadcast") {
					if (!hive) throw new HttpError(503, "feature_unavailable", "Hive is unavailable");
					return json(await hive.broadcast(await bodyObject(request)), 200, requestId, { "Cache-Control": "no-store" });
				}

				if (request.method === "POST" && url.pathname === "/api/v1/hive/broadcast-ops") {
					if (!hive) throw new HttpError(503, "feature_unavailable", "Hive is unavailable");
					return json(await hive.broadcastOps(await bodyObject(request)), 200, requestId, { "Cache-Control": "no-store" });
				}

				if (request.method === "POST" && url.pathname === "/api/v1/user/register") {
					const body = await bodyObject(request);
					const username = typeof body.username === "string" ? body.username.trim() : "";
					const key = typeof body.queryKey === "string" ? body.queryKey.trim() : "";
					if (!username || username.length > 200) throw new HttpError(400, "invalid_username", "username is required and must be at most 200 characters");
					if (key.length < 32 || key.length > 512) throw new HttpError(400, "invalid_query_key", "queryKey must be between 32 and 512 characters");
					const client = await database.registerClient({ username, queryKey: key });
					return json({ success: true, client }, 200, requestId);
				}

				const key = queryKey(request);
				const authenticated = async (): Promise<{ id: string; username: string }> => {
					const client = key ? await database.authenticate(key) : null;
					if (!client) throw new HttpError(401, "unauthorized", "A registered Pioneer query key is required");
					return client;
				};

				if (request.method === "POST" && url.pathname === "/api/v1/events/subscribe") {
					if (!realtime) throw new HttpError(503, "feature_unavailable", "Realtime events are unavailable");
					const client = await authenticated();
					const body = await bodyObject(request);
					return realtime.createSse(client.id, body.addresses, body.events);
				}

				if (request.method === "POST" && url.pathname === "/api/v1/hive/create-account") {
					if (!hive) throw new HttpError(503, "feature_unavailable", "Hive is unavailable");
					const client = await authenticated();
					return json(await hive.createAccount(client.id, await bodyObject(request)), 200, requestId, { "Cache-Control": "no-store" });
				}

				if (request.method === "POST" && url.pathname === "/api/v1/telemetry/vault") {
					if (!telemetry) throw new HttpError(503, "feature_unavailable", "Telemetry storage is unavailable");
					const client = await authenticated();
					const body = await bodyObject(request);
					return json(await telemetry.recordBatch(client.id, body.records), 200, requestId, { "Cache-Control": "no-store" });
				}

				if (request.method === "GET" && url.pathname === "/api/v1/swappers/supported-chains") {
					if (!catalog) throw new HttpError(503, "feature_unavailable", "Asset catalog is unavailable");
					return json(catalog.supportedChains(), 200, requestId, { "Cache-Control": "public, max-age=86400" });
				}

				if (request.method === "GET" && url.pathname === "/api/v1/swap/health") {
					if (!catalog) throw new HttpError(503, "feature_unavailable", "Asset catalog is unavailable");
					return json(catalog.swapHealth(Date.now(), quoteRouter?.providerHealth()), 200, requestId, { "Cache-Control": "no-store" });
				}

				if (request.method === "GET" && url.pathname === "/api/v1/discovery/search") {
					if (!catalog) throw new HttpError(503, "feature_unavailable", "Asset catalog is unavailable");
					await authenticated();
					const q = url.searchParams.get("q")?.trim() || "";
					const rawLimit = Number(url.searchParams.get("limit") || 50);
					if (!q) throw new HttpError(400, "invalid_search", "q is required");
					if (!Number.isFinite(rawLimit) || rawLimit < 1) throw new HttpError(400, "invalid_search", "limit must be a positive number");
					return json(catalog.search(q, rawLimit), 200, requestId, { "Cache-Control": "public, max-age=86400" });
				}

				if (request.method === "GET" && url.pathname === "/api/v1/swap/available-assets") {
					if (!catalog) throw new HttpError(503, "feature_unavailable", "Asset catalog is unavailable");
					await authenticated();
					return json(catalog.availableSwapAssets(), 200, requestId, { "Cache-Control": "public, max-age=86400" });
				}

				if (request.method === "POST" && (url.pathname === "/api/v1/quote" || url.pathname === "/api/v1/quote/")) {
					if (!quoteRouter) throw new HttpError(503, "feature_unavailable", "Swap quoting is unavailable");
					await authenticated();
					return json(await quoteRouter.quote(await bodyObject(request) as unknown as QuoteRequest), 200, requestId, { "Cache-Control": "no-store" });
				}

				if (request.method === "POST" && url.pathname === "/api/v1/swaps/pending") {
					if (!pendingSwaps) throw new HttpError(503, "feature_unavailable", "Pending swap storage is unavailable");
					const client = await authenticated();
					return json(await pendingSwaps.create(client.id, await bodyObject(request)), 201, requestId, { "Cache-Control": "no-store" });
				}

				const pendingSwapMatch = url.pathname.match(/^\/api\/v1\/swaps\/pending\/([^/]+)$/);
				if (request.method === "GET" && pendingSwapMatch) {
					if (!pendingSwaps) throw new HttpError(503, "feature_unavailable", "Pending swap storage is unavailable");
					const client = await authenticated();
					const forceRefresh = url.searchParams.get("rescan") === "true";
					const swap = await pendingSwaps.get(client.id, decodeURIComponent(pendingSwapMatch[1]), forceRefresh);
					if (!swap) throw new HttpError(404, "pending_swap_not_found", "Pending swap not found");
					return json(swap, 200, requestId, { "Cache-Control": "no-store" });
				}

				if (request.method === "PUT" && pendingSwapMatch) {
					if (!pendingSwaps) throw new HttpError(503, "feature_unavailable", "Pending swap storage is unavailable");
					const client = await authenticated();
					const swap = await pendingSwaps.update(client.id, decodeURIComponent(pendingSwapMatch[1]), await bodyObject(request));
					if (!swap) throw new HttpError(404, "pending_swap_not_found", "Pending swap not found");
					return json(swap, 200, requestId, { "Cache-Control": "no-store" });
				}

				if (request.method === "POST" && url.pathname === "/api/v1/market/info") {
					if (!market) throw new HttpError(503, "feature_unavailable", "Market pricing is not configured");
					await authenticated();
					return json(await market.getPrices(await bodyStringArray(request)), 200, requestId);
				}

				if (request.method === "POST" && url.pathname === "/api/v1/staking/positions") {
					if (!cosmosFeatures) throw new HttpError(503, "feature_unavailable", "Staking is unavailable");
					await authenticated();
					const body = await bodyObject(request);
					return json(await cosmosFeatures.staking(String(body.network || ""), String(body.address || "")), 200, requestId, { "Cache-Control": "no-store" });
				}

				if (request.method === "POST" && url.pathname === "/api/v1/names/lookup") {
					if (!cosmosFeatures) throw new HttpError(503, "feature_unavailable", "Name lookup is unavailable");
					await authenticated();
					const body = await bodyObject(request);
					return json(await cosmosFeatures.nameLookup(String(body.network || ""), String(body.name || "")), 200, requestId);
				}

				if (request.method === "POST" && url.pathname === "/api/v1/names/registration-quote") {
					if (!cosmosFeatures) throw new HttpError(503, "feature_unavailable", "Name pricing is unavailable");
					await authenticated();
					const body = await bodyObject(request);
					return json(await cosmosFeatures.nameQuote(String(body.network || "")), 200, requestId, { "Cache-Control": "no-store" });
				}

				if (request.method === "POST" && url.pathname === "/api/v1/portfolio/balances") {
					if (!portfolio) throw new HttpError(503, "feature_unavailable", "Portfolio aggregation is not configured");
					await authenticated();
					const body = await bodyObject(request) as unknown as PortfolioRequest;
					return json(await portfolio.getBalances(body), 200, requestId, { "Cache-Control": "no-store" });
				}

				if (request.method === "POST" && url.pathname === "/api/v1/tx/history") {
					if (!history) throw new HttpError(503, "feature_unavailable", "Transaction history is not configured");
					await authenticated();
					const body = await bodyObject(request) as unknown as HistoryRequest;
					return json(await history.getTransactionHistory(body), 200, requestId, { "Cache-Control": "no-store" });
				}

				const accountMatch = url.pathname.match(/^\/api\/v1\/getAccountInfo\/([^/]+)\/([^/]+)$/);
				if (request.method === "GET" && accountMatch) {
					if (!account) throw new HttpError(503, "feature_unavailable", "Account information is not configured");
					await authenticated();
					return json(await account.getAccountInfo(decodeURIComponent(accountMatch[1]), decodeURIComponent(accountMatch[2])), 200, requestId, { "Cache-Control": "no-store" });
				}

				if (request.method === "POST" && url.pathname === "/api/v1/solana/build-transfer") {
					if (!solana) throw new HttpError(503, "feature_unavailable", "Solana RPC is not configured");
					await authenticated();
					return json(await solana.buildTransfer(await bodyObject(request) as any), 200, requestId, { "Cache-Control": "no-store" });
				}

				if (request.method === "POST" && url.pathname === "/api/v1/solana/build-transfer-token") {
					if (!solana) throw new HttpError(503, "feature_unavailable", "Solana RPC is not configured");
					await authenticated();
					return json(await solana.buildTokenTransfer(await bodyObject(request) as any), 200, requestId, { "Cache-Control": "no-store" });
				}

				const gasMatch = url.pathname.match(/^\/api\/v1\/evm\/gas-price\/([^/]+)$/);
				if (request.method === "GET" && gasMatch) {
					if (!evm) throw new HttpError(503, "feature_unavailable", "EVM RPC is not configured");
					await authenticated();
					return json(await evm.getGasPrice(decodeURIComponent(gasMatch[1])), 200, requestId);
				}

				const nonceMatch = url.pathname.match(/^\/api\/v1\/evm\/nonce\/([^/]+)\/(0x[a-fA-F0-9]{40})$/);
				if (request.method === "GET" && nonceMatch) {
					if (!evm) throw new HttpError(503, "feature_unavailable", "EVM RPC is not configured");
					await authenticated();
					return json(await evm.getNonce(decodeURIComponent(nonceMatch[1]), nonceMatch[2]), 200, requestId);
				}

				const balanceMatch = url.pathname.match(/^\/api\/v1\/evm\/balance\/([^/]+)\/(0x[a-fA-F0-9]{40})$/);
				if (request.method === "GET" && balanceMatch) {
					if (!evm) throw new HttpError(503, "feature_unavailable", "EVM RPC is not configured");
					await authenticated();
					return json(await evm.getBalance(decodeURIComponent(balanceMatch[1]), balanceMatch[2]), 200, requestId);
				}

				const decimalsMatch = url.pathname.match(/^\/api\/v1\/evm\/token\/decimals\/([^/]+)\/(0x[a-fA-F0-9]{40})$/);
				if (request.method === "GET" && decimalsMatch) {
					if (!evm) throw new HttpError(503, "feature_unavailable", "EVM RPC is not configured");
					await authenticated();
					return json(await evm.getTokenDecimals(decodeURIComponent(decimalsMatch[1]), decimalsMatch[2]), 200, requestId);
				}

				const tokenBalanceMatch = url.pathname.match(/^\/api\/v1\/evm\/token\/balance\/([^/]+)\/(0x[a-fA-F0-9]{40})\/(0x[a-fA-F0-9]{40})$/);
				if (request.method === "GET" && tokenBalanceMatch) {
					if (!evm) throw new HttpError(503, "feature_unavailable", "EVM RPC is not configured");
					await authenticated();
					const result = await evm.getTokenBalance(decodeURIComponent(tokenBalanceMatch[1]), tokenBalanceMatch[2], tokenBalanceMatch[3]);
					// Desktop reads `balance` (txbuilder) and v3's `data` (pioneer-evm eth_call path).
					return json({ ...result, data: result.balance }, 200, requestId);
				}

				if (request.method === "POST" && url.pathname === "/api/v1/evm/rpc") {
					if (!evm) throw new HttpError(503, "feature_unavailable", "EVM RPC is not configured");
					await authenticated();
					const body = await bodyObject(request);
					return json(await evm.readRpc(body.networkId, body.method, body.params), 200, requestId, { "Cache-Control": "no-store" });
				}

				const evmLookupMatch = url.pathname.match(/^\/api\/v1\/evm\/lookup\/([^/]+)\/([^/]+)$/);
				if (request.method === "GET" && evmLookupMatch) {
					if (!evm) throw new HttpError(503, "feature_unavailable", "EVM RPC is not configured");
					await authenticated();
					return json(await evm.lookupTransaction(decodeURIComponent(evmLookupMatch[1]), decodeURIComponent(evmLookupMatch[2])), 200, requestId, { "Cache-Control": "no-store" });
				}

				if (request.method === "POST" && url.pathname === "/api/v1/evm/token/lookup") {
					if (!evm) throw new HttpError(503, "feature_unavailable", "EVM RPC is not configured");
					await authenticated();
					const body = await bodyObject(request);
					return json(await evm.getTokenMetadata(String(body.networkId ?? ""), String(body.contractAddress ?? "")), 200, requestId);
				}

				const allowanceMatch = url.pathname.match(/^\/api\/v1\/evm\/token\/allowance\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/);
				if (request.method === "GET" && allowanceMatch) {
					if (!evm) throw new HttpError(503, "feature_unavailable", "EVM RPC is not configured");
					await authenticated();
					const [networkId, contract, owner, spender] = allowanceMatch.slice(1).map(decodeURIComponent);
					return json(await evm.getTokenAllowance(networkId, contract, owner, spender), 200, requestId, { "Cache-Control": "no-store" });
				}

				const pubkeyMatch = url.pathname.match(/^\/api\/v1\/utxo\/pubkey-info\/([^/]+)\/(.+)$/);
				if (request.method === "GET" && pubkeyMatch) {
					if (!utxo) throw new HttpError(503, "feature_unavailable", "UTXO provider is not configured");
					await authenticated();
					return json(await utxo.getPubkeyInfo(decodeURIComponent(pubkeyMatch[1]), decodeURIComponent(pubkeyMatch[2])), 200, requestId);
				}

				const unspentMatch = url.pathname.match(/^\/api\/v1\/utxo\/unspent\/([^/]+)\/(.+)$/);
				if (request.method === "GET" && unspentMatch) {
					if (!utxo) throw new HttpError(503, "feature_unavailable", "UTXO provider is not configured");
					await authenticated();
					return json(await utxo.listUnspent(decodeURIComponent(unspentMatch[1]), decodeURIComponent(unspentMatch[2])), 200, requestId, { "Cache-Control": "no-store" });
				}

				const feeMatch = url.pathname.match(/^\/api\/v1\/utxo\/(?:fee-rate|fee-rate-by-network)\/([^/]+)$/);
				if (request.method === "GET" && feeMatch) {
					if (!utxo) throw new HttpError(503, "feature_unavailable", "UTXO provider is not configured");
					await authenticated();
					return json(await utxo.getFeeRate(decodeURIComponent(feeMatch[1])), 200, requestId);
				}

				const lookupMatch = url.pathname.match(/^\/api\/v1\/utxo\/(?:lookup|lookup-alias)\/([^/]+)\/([a-fA-F0-9]{64})$/);
				if (request.method === "GET" && lookupMatch) {
					if (!utxo) throw new HttpError(503, "feature_unavailable", "UTXO provider is not configured");
					await authenticated();
					return json(await utxo.lookupTransaction(decodeURIComponent(lookupMatch[1]), lookupMatch[2]), 200, requestId);
				}

				if (request.method === "POST" && url.pathname === "/api/v1/broadcast") {
					await authenticated();
					const body = await bodyObject(request);
					const networkId = typeof body.networkId === "string" ? body.networkId : "";
					const serialized = typeof body.serialized === "string" ? body.serialized : "";
					if (!networkId || !serialized) throw new HttpError(400, "invalid_broadcast", "networkId and serialized transaction hex are required");
					if (networkId.startsWith("eip155:")) {
						if (!evm) throw new HttpError(503, "feature_unavailable", "EVM RPC is not configured");
						return json(await evm.broadcast(networkId, serialized), 200, requestId);
					}
					if (networkId.startsWith("bip122:")) {
						if (!utxo) throw new HttpError(503, "feature_unavailable", "UTXO provider is not configured");
						return json(await utxo.broadcast(networkId, serialized), 200, requestId);
					}
					if (networkId.startsWith("solana:")) {
						if (!solana) throw new HttpError(503, "feature_unavailable", "Solana RPC is not configured");
						return json(await solana.broadcast(serialized), 200, requestId);
					}
					if (networkId.startsWith("cosmos:") || networkId.startsWith("ripple:")) {
						if (!multichainBroadcast) throw new HttpError(503, "feature_unavailable", "Multichain broadcast is not configured");
						return json(await multichainBroadcast.broadcast(networkId, serialized), 200, requestId);
					}
					throw new HttpError(422, "unsupported_network", `Broadcast is not yet implemented for ${networkId}`);
				}

				const zerionMatch = url.pathname.match(/^\/api\/v1\/zerion\/positions\/(0x[a-fA-F0-9]{40})$/);
				if (request.method === "GET" && zerionMatch) {
					if (!zerion) throw new HttpError(503, "feature_unavailable", "Zerion is not configured");
					await authenticated();
					const positions = await zerion.getDefiPositions(zerionMatch[1]);
					return json({ address: zerionMatch[1].toLowerCase(), positions, source: "zerion" }, 200, requestId);
				}

				throw new HttpError(404, "not_found", "Route not found");
			} catch (error) {
				if (error instanceof HttpError) return json({ error: { code: error.code, message: error.message } }, error.status, requestId);
				if (error instanceof DisabledClientError) return json({ error: { code: "credential_disabled", message: error.message } }, 403, requestId);
				if (error instanceof ZerionError) return json({ error: { code: "zerion_error", message: error.message } }, error.status >= 400 && error.status < 500 ? error.status : 502, requestId);
				if (error instanceof EvmError) return json({ error: { code: "evm_error", message: error.message } }, error.status, requestId);
				if (error instanceof MarketError) return json({ error: { code: "market_error", message: error.message } }, error.status, requestId);
				if (error instanceof UtxoError) return json({ error: { code: "utxo_error", message: error.message } }, error.status, requestId);
				if (error instanceof PortfolioError) return json({ error: { code: "portfolio_error", message: error.message } }, error.status, requestId);
				if (error instanceof HistoryError) return json({ error: { code: "history_error", message: error.message } }, error.status, requestId);
				if (error instanceof ChainHistoryError) return json({ error: { code: "history_error", message: error.message } }, error.status, requestId);
				if (error instanceof AccountError) return json({ error: { code: "account_error", message: error.message } }, error.status, requestId);
				if (error instanceof SolanaError) return json({ error: { code: "solana_error", message: error.message } }, error.status, requestId);
				if (error instanceof SwapError) return json({ error: { code: "swap_error", message: error.message } }, error.status, requestId);
				if (error instanceof PendingSwapError) return json({ error: { code: "pending_swap_error", message: error.message } }, error.status, requestId);
				if (error instanceof CosmosFeatureError) return json({ error: { code: "cosmos_feature_error", message: error.message } }, error.status, requestId);
				if (error instanceof HiveError) return json({ error: { code: "hive_error", message: error.message } }, error.status, requestId);
				if (error instanceof MultichainBroadcastError) return json({ error: { code: "broadcast_error", message: error.message } }, error.status, requestId);
				if (error instanceof RealtimeError) return json({ error: { code: "realtime_error", message: error.message } }, error.status, requestId);
				console.error(JSON.stringify({ event: "request_failed", requestId, method: request.method, path: url.pathname, error: error instanceof Error ? error.message : String(error) }));
				return json({ error: { code: "internal_error", message: "Internal server error" } }, 500, requestId);
			} finally {
				console.log(JSON.stringify({ event: "request_complete", requestId, method: request.method, path: url.pathname, durationMs: Math.round((performance.now() - startedAt) * 100) / 100 }));
			}
		},
	};
}
