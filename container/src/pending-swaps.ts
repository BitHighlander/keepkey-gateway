import type { Database, StoredPendingSwap } from "./database";

export class PendingSwapError extends Error {
	constructor(public readonly status: number, message: string) {
		super(message);
	}
}

export interface PendingSwapAsset {
	caip: string;
	symbol: string;
	amount: string;
	amountBaseUnits: string;
	address: string;
	networkId: string;
}

export interface CreatePendingSwapRequest {
	txHash: string;
	addresses: string[];
	sellAsset: PendingSwapAsset;
	buyAsset: PendingSwapAsset;
	quote: Record<string, unknown>;
	integration: string;
	swapper?: string;
	invocationId?: string;
	relayData?: Record<string, unknown>;
	nearIntentsData?: Record<string, unknown>;
}

export class PendingSwapService {
	private readonly fetcher: typeof fetch;
	private readonly refreshIntervalMs: number;
	private readonly initialGraceMs: number;

	constructor(private readonly database: Database, options: { fetch?: typeof fetch; refreshIntervalMs?: number; initialGraceMs?: number } = {}) {
		this.fetcher = options.fetch || fetch;
		this.refreshIntervalMs = options.refreshIntervalMs ?? 8_000;
		this.initialGraceMs = options.initialGraceMs ?? 5_000;
	}

	async create(clientId: string, raw: Record<string, unknown>): Promise<Record<string, unknown>> {
		const input = validateCreate(raw);
		const txHash = normalizeTxHash(input.txHash);
		let stored = await this.database.upsertPendingSwap(clientId, txHash, input as unknown as Record<string, unknown>);
		if (isShapeShift(stored.payload)) stored = await this.trackShapeShift(clientId, txHash, stored) || stored;
		return response(stored);
	}

	async get(clientId: string, rawTxHash: string, forceRefresh = false): Promise<Record<string, unknown> | null> {
		const txHash = validateTxHash(rawTxHash);
		const normalized = normalizeTxHash(txHash);
		const stored = await this.database.getPendingSwap(clientId, normalized);
		if (!stored) return null;
		if (isTerminal(stored.status) || (!forceRefresh && !refreshDue(stored, this.initialGraceMs, this.refreshIntervalMs))) return response(stored);
		let refreshed = stored;
		if (isShapeShift(refreshed.payload)) refreshed = await this.trackShapeShift(clientId, normalized, refreshed) || refreshed;
		refreshed = await this.refreshMidgard(clientId, normalized, refreshed) || refreshed;
		refreshed = await this.refreshRelay(clientId, normalized, refreshed) || refreshed;
		refreshed = await this.refreshChainflip(clientId, normalized, refreshed) || refreshed;
		return response(refreshed || stored);
	}

	private async refreshChainflip(clientId: string, txHash: string, stored: StoredPendingSwap): Promise<StoredPendingSwap | null> {
		const route = `${stored.payload.integration || ""} ${stored.payload.swapper || ""}`.toLowerCase();
		if (!route.includes("chainflip")) return stored;
		try {
			const body = await fetchJson(this.fetcher, `https://chainflip-swap.chainflip.io/v2/swaps/${encodeURIComponent(String(stored.payload.txHash || txHash))}`, {}, "Chainflip");
			const sell = objectOrEmpty(stored.payload.sellAsset);
			const buy = objectOrEmpty(stored.payload.buyAsset);
			if (typeof body?.deposit?.txRef !== "string" || !chainflipTxMatches(body.deposit.txRef, txHash)) {
				throw new Error("Chainflip has not identified this deposit transaction");
			}
			if (!chainflipNetworkMatches(body.srcChain, sell.networkId) || !chainflipNetworkMatches(body.destChain, buy.networkId)) throw new Error("Chainflip networks do not match this swap");
			const expectedAddress = String(buy.address);
			if (typeof body.destAddress !== "string" || (String(buy.networkId).startsWith("eip155:") ? body.destAddress.toLowerCase() !== expectedAddress.toLowerCase() : body.destAddress !== expectedAddress)) throw new Error("Chainflip destination does not match this swap");
			if (String(body.srcAsset).toUpperCase() !== String(sell.symbol).toUpperCase() || String(body.destAsset).toUpperCase() !== String(buy.symbol).toUpperCase()) throw new Error("Chainflip assets do not match this swap");
			const state = String(body.state || "").toUpperCase();
			const output = body.swapEgress;
			const refund = body.refundEgress;
			let status = stored.status;
			if (state === "RECEIVING") status = "confirming";
			else if (state === "SWAPPING") status = "swapping";
			else if (["SENDING", "SENT"].includes(state)) status = "output_confirming";
			else if (state === "FAILED") status = confirmedChainflipEgress(refund) ? "refunded" : "failed";
			else if (state === "COMPLETED") {
				if (confirmedChainflipEgress(refund) && !confirmedChainflipEgress(output)) status = "refunded";
				else if (confirmedChainflipEgress(output) && !body.fallbackEgress) status = "completed";
				else throw new Error("Chainflip completion has no confirmed payout");
			}
			const destinationDecimals = chainflipDecimals(String(body.destAsset), String(body.destChain));
			return await this.database.updatePendingSwap(clientId, txHash, status, {
				requiredConfirmations: numberOr(body.srcChainRequiredBlockConfirmations, 0),
				confirmations: numberOr(body.deposit.txConfirmations, body.deposit.witnessedAt ? Math.max(1, numberOr(body.srcChainRequiredBlockConfirmations, 1)) : 0),
				...(output?.txRef ? { outboundTxHash: output.txRef, outboundTxid: output.txRef } : {}),
				...(status === "completed" ? {
					receivedOutputBaseUnits: output.amount, receivedOutput: destinationDecimals === undefined ? undefined : unitsToDecimal(output.amount, destinationDecimals),
					completedAt: new Date(output.witnessedAt).toISOString(), outboundConfirmations: 1, outboundRequiredConfirmations: 1,
				} : {}),
				...(confirmedChainflipEgress(refund) ? { refundTxid: refund.txRef, refundReason: status === "completed" ? "Chainflip refunded part of the deposit" : "Chainflip refunded the deposit" } : {}),
				...(status === "failed" ? { error: { provider: "chainflip", message: "Chainflip reports the swap failed" } } : {}),
				chainflipData: { state, swapId: body.swapId, estimatedDurationSeconds: body.estimatedDurationSeconds, brokers: body.brokers, fees: body.fees, swapEgress: body.swapEgress, refundEgress: body.refundEgress, fallbackEgress: body.fallbackEgress },
				providerCheck: { provider: "chainflip", result: state },
			});
		} catch (error) {
			return await this.database.updatePendingSwap(clientId, txHash, stored.status, {
				providerCheck: { provider: "chainflip", result: "unavailable", message: error instanceof Error ? error.message : String(error) },
			});
		}
	}

	/** UpdatePendingSwap. Desktop's only update is the Relay request id it
	 * resolves after broadcast, so that is the only field accepted. */
	async update(clientId: string, rawTxHash: string, raw: Record<string, unknown>): Promise<Record<string, unknown> | null> {
		const txHash = normalizeTxHash(validateTxHash(rawTxHash));
		const relay = Object.keys(raw).length === 1 ? object(raw.relayData, "relayData") : null;
		if (!relay || Object.keys(relay).length !== 1) throw new PendingSwapError(400, "Only relayData.requestId can be updated");
		const requestId = requiredString(relay.requestId, "relayData.requestId", 256);
		if (/\s/.test(requestId)) throw new PendingSwapError(400, "relayData.requestId must not contain whitespace");
		const stored = await this.database.getPendingSwap(clientId, txHash);
		if (!stored) return null;
		if (objectOrEmpty(stored.payload.relayData).requestId === requestId) return response(stored);
		// Status fields derived from a different request id would be wrong; the
		// next read re-derives them from Relay.
		const updated = await this.database.updatePendingSwap(clientId, txHash, stored.status, { relayData: { requestId } });
		return updated ? response(updated) : null;
	}

	private async refreshMidgard(clientId: string, txHash: string, stored: StoredPendingSwap): Promise<StoredPendingSwap | null> {
		const protocol = midgardProtocol(stored.payload);
		if (!protocol) return stored;
		const normalized = String(stored.payload.txHash || txHash).replace(/^0x/i, "").toUpperCase();
		const bases = protocol === "mayachain"
			? ["https://midgard.mayachain.info"]
			: ["https://midgard.thorchain.network", "https://gateway.liquify.com/chain/thorchain_midgard"];
		try {
			const body = await fetchJsonFailover(this.fetcher, bases.map((base) => `${base}/v2/actions?txid=${encodeURIComponent(normalized)}`), { "x-client-id": "keepkey-gateway" }, protocol);
			const classified = classifyMidgard(body, stored.status);
			if (!classified) return await this.database.updatePendingSwap(clientId, txHash, stored.status, { providerCheck: { provider: `${protocol}-midgard`, result: "not_indexed" } });
			return await this.database.updatePendingSwap(clientId, txHash, classified.status, {
				confirmations: Math.max(1, numberOr(stored.payload.confirmations, 0)),
				...(classified.outboundTxid ? { outboundTxHash: classified.outboundTxid, outboundTxid: classified.outboundTxid } : {}),
				...(classified.outboundAmount ? { receivedOutput: unitsToDecimal(classified.outboundAmount, 8), receivedOutputBaseUnits: classified.outboundAmount } : {}),
				...(classified.outboundAsset ? { outboundAsset: classified.outboundAsset } : {}),
				...(isTerminal(classified.status) ? { completedAt: new Date().toISOString(), outboundConfirmations: classified.outboundTxid ? 1 : 0, outboundRequiredConfirmations: 1 } : {}),
				...(classified.status === "refunded" ? { refundReason: classified.refundReason || "Protocol refund", error: { message: classified.refundReason || "Protocol refund", provider: protocol } } : {}),
				...(classified.status === "failed" ? { error: { message: "Protocol swap failed", provider: protocol } } : {}),
				midgard: { protocol, actionType: classified.actionType, actionStatus: classified.actionStatus },
				providerCheck: { provider: `${protocol}-midgard`, result: classified.actionStatus || classified.status },
			});
		} catch (error) {
			return await this.database.updatePendingSwap(clientId, txHash, stored.status, {
				providerCheck: { provider: `${protocol}-midgard`, result: "unavailable", message: error instanceof Error ? error.message : String(error) },
			});
		}
	}

	private async trackShapeShift(clientId: string, txHash: string, stored: StoredPendingSwap): Promise<StoredPendingSwap | null> {
		const prior = objectOrEmpty(stored.payload.shapeshiftTracking);
		if (prior.status === "tracked" || numberOr(prior.attempts, 0) >= 20) return stored;
		const quoteId = shapeShiftQuoteId(stored.payload);
		if (!quoteId) {
			if (prior.status === "missing_quote_id") return stored;
			return await this.database.updatePendingSwap(clientId, txHash, stored.status, {
				shapeshiftTracking: { ...prior, status: "missing_quote_id", attempts: numberOr(prior.attempts, 0) },
			});
		}
		const attempts = numberOr(prior.attempts, 0) + 1;
		try {
			const params = new URLSearchParams({ quoteId, txHash: String(stored.payload.txHash || txHash) });
			const body = await fetchJson(this.fetcher, `https://api.shapeshift.com/v1/swap/status?${params}`, { "X-Partner-Code": "keepkey" }, "ShapeShift");
			return await this.database.updatePendingSwap(clientId, txHash, stored.status, {
				shapeshiftTracking: { quoteId, status: "tracked", attempts, providerStatus: typeof body?.status === "string" ? body.status : undefined },
				providerCheck: { provider: "shapeshift", result: "tracked" },
			});
		} catch (error) {
			return await this.database.updatePendingSwap(clientId, txHash, stored.status, {
				shapeshiftTracking: { quoteId, status: "pending", attempts, lastError: error instanceof Error ? error.message : String(error) },
				providerCheck: { provider: "shapeshift", result: "unavailable" },
			});
		}
	}

	private async refreshRelay(clientId: string, txHash: string, stored: StoredPendingSwap): Promise<StoredPendingSwap | null> {
		const integration = String(stored.payload.integration || "").toLowerCase();
		const swapper = String(stored.payload.swapper || "").toLowerCase().replace(/[\s_.-]/g, "");
		if (integration !== "relay" && !(integration.startsWith("shapeshift") && swapper.includes("relay"))) return stored;
		const existingRelay = objectOrEmpty(stored.payload.relayData);
		let requestId = typeof existingRelay.requestId === "string" ? existingRelay.requestId : "";
		let directStatus: Record<string, unknown> | null = null;
		try {
			if (!requestId) {
				const lookup = await fetchJson(this.fetcher, `https://api.relay.link/requests/v2?hash=${encodeURIComponent(String(stored.payload.txHash || txHash))}`);
				const requests = Array.isArray(lookup?.requests) ? lookup.requests : [];
				const target = String(stored.payload.txHash || txHash).toLowerCase();
				const match = requests.find((candidate: any) => (candidate?.data?.inTxs || []).some((item: any) => String(item?.hash || "").toLowerCase() === target)) || requests[0];
				requestId = typeof match?.id === "string" ? match.id : "";
				if (match && typeof match === "object") directStatus = match;
			}
			if (!requestId) return await this.database.updatePendingSwap(clientId, txHash, stored.status, { providerCheck: { provider: "relay", result: "not_indexed" } });
			const statusBody = await fetchJson(this.fetcher, `https://api.relay.link/intents/status/v3?requestId=${encodeURIComponent(requestId)}`);
			if (statusBody && typeof statusBody === "object") directStatus = statusBody;
			const relayStatus = String(directStatus?.status || "unknown").toLowerCase();
			const nextStatus = relayTrackingStatus(relayStatus, stored.status);
			const inTxHashes = stringArray(directStatus?.inTxHashes || (directStatus as any)?.data?.inTxs?.map((item: any) => item?.hash));
			const outTxHashes = stringArray(directStatus?.txHashes || (directStatus as any)?.data?.outTxs?.map((item: any) => item?.hash));
			const sameChain = directStatus?.originChainId != null && directStatus?.originChainId === directStatus?.destinationChainId;
			const outboundTxHash = outTxHashes[0] || (nextStatus === "completed" && sameChain ? inTxHashes[0] || String(stored.payload.txHash || txHash) : undefined);
			const terminal = isTerminal(nextStatus);
			return await this.database.updatePendingSwap(clientId, txHash, nextStatus, {
				relayData: { ...existingRelay, requestId, relayStatus, inTxHashes, outTxHashes },
				confirmations: nextStatus === "pending" ? numberOr(stored.payload.confirmations, 0) : Math.max(1, numberOr(stored.payload.confirmations, 0)),
				...(outboundTxHash ? { outboundTxHash, outboundTxid: outboundTxHash } : {}),
				...(terminal && nextStatus === "completed" && outboundTxHash ? { outboundConfirmations: 1, outboundRequiredConfirmations: 1 } : {}),
				...(terminal ? { completedAt: new Date().toISOString() } : {}),
				...(nextStatus === "failed" || nextStatus === "refunded" ? { error: { message: String(directStatus?.details || relayStatus), provider: "relay" } } : {}),
				providerCheck: { provider: "relay", result: relayStatus },
			});
		} catch (error) {
			return await this.database.updatePendingSwap(clientId, txHash, stored.status, {
				providerCheck: { provider: "relay", result: "unavailable", message: error instanceof Error ? error.message : String(error) },
				...(requestId ? { relayData: { ...existingRelay, requestId } } : {}),
			});
		}
	}
}

function response(stored: StoredPendingSwap): Record<string, unknown> {
	return {
		...stored.payload,
		status: stored.status,
		confirmations: numberOr(stored.payload.confirmations, 0),
		outboundConfirmations: numberOr(stored.payload.outboundConfirmations, 0),
		createdAt: stored.createdAt,
		updatedAt: stored.updatedAt,
		...(stored.lastCheckedAt ? { lastCheckedAt: stored.lastCheckedAt } : {}),
	};
}

function validateCreate(raw: Record<string, unknown>): CreatePendingSwapRequest {
	const txHash = validateTxHash(raw.txHash);
	const integration = requiredString(raw.integration, "integration", 100);
	const addresses = raw.addresses;
	if (!Array.isArray(addresses) || addresses.length > 100 || addresses.some((address) => typeof address !== "string" || address.length > 256)) {
		throw new PendingSwapError(400, "addresses must be an array of at most 100 strings");
	}
	const quote = object(raw.quote, "quote");
	return {
		txHash,
		addresses: addresses as string[],
		sellAsset: asset(raw.sellAsset, "sellAsset"),
		buyAsset: asset(raw.buyAsset, "buyAsset"),
		quote,
		integration,
		...(optionalString(raw.swapper, "swapper", 100) ? { swapper: optionalString(raw.swapper, "swapper", 100) } : {}),
		...(optionalString(raw.invocationId, "invocationId", 256) ? { invocationId: optionalString(raw.invocationId, "invocationId", 256) } : {}),
		...(raw.relayData !== undefined ? { relayData: object(raw.relayData, "relayData") } : {}),
		...(raw.nearIntentsData !== undefined ? { nearIntentsData: object(raw.nearIntentsData, "nearIntentsData") } : {}),
	};
}

function asset(raw: unknown, field: string): PendingSwapAsset {
	const value = object(raw, field);
	return {
		caip: requiredString(value.caip, `${field}.caip`, 512),
		symbol: requiredString(value.symbol, `${field}.symbol`, 100),
		amount: requiredString(value.amount, `${field}.amount`, 200),
		amountBaseUnits: requiredString(value.amountBaseUnits, `${field}.amountBaseUnits`, 200),
		address: optionalString(value.address, `${field}.address`, 512) || "",
		networkId: requiredString(value.networkId, `${field}.networkId`, 200),
	};
}

function validateTxHash(raw: unknown): string {
	const value = requiredString(raw, "txHash", 256);
	if (value.length < 8 || /\s/.test(value)) throw new PendingSwapError(400, "txHash must be between 8 and 256 non-whitespace characters");
	return value;
}

function normalizeTxHash(value: string): string {
	return value.startsWith("0x") ? value.toLowerCase() : value;
}

function object(raw: unknown, field: string): Record<string, unknown> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PendingSwapError(400, `${field} must be an object`);
	return raw as Record<string, unknown>;
}

function requiredString(raw: unknown, field: string, maxLength: number): string {
	if (typeof raw !== "string" || !raw.trim() || raw.length > maxLength) throw new PendingSwapError(400, `${field} is required and must be at most ${maxLength} characters`);
	return raw.trim();
}

function optionalString(raw: unknown, field: string, maxLength: number): string | undefined {
	if (raw === undefined || raw === null || raw === "") return undefined;
	if (typeof raw !== "string" || raw.length > maxLength) throw new PendingSwapError(400, `${field} must be at most ${maxLength} characters`);
	return raw.trim();
}

function numberOr(raw: unknown, fallback: number): number {
	return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}

function refreshDue(stored: StoredPendingSwap, initialGraceMs: number, intervalMs: number): boolean {
	const now = Date.now();
	if (now - Date.parse(stored.createdAt) < initialGraceMs) return false;
	return !stored.lastCheckedAt || now - Date.parse(stored.lastCheckedAt) >= intervalMs;
}

function isTerminal(status: string): boolean {
	return status === "completed" || status === "failed" || status === "refunded";
}

function confirmedChainflipEgress(egress: any): boolean {
	return typeof egress?.txRef === "string" && egress.txRef.length > 0 && /^\d+$/.test(String(egress.amount)) && BigInt(egress.amount) > 0n && typeof egress.witnessedAt === "number" && egress.witnessedAt > 0 && Number.isFinite(new Date(egress.witnessedAt).getTime()) && !egress.failure;
}

function chainflipTxMatches(left: string, right: string): boolean {
	const hex = /^(?:0x)?[0-9a-f]+$/i;
	return hex.test(left) && hex.test(right) ? left.toLowerCase().replace(/^0x/, "") === right.toLowerCase().replace(/^0x/, "") : left === right;
}

function chainflipDecimals(asset: string, chain: string): number | undefined {
	if (asset.toUpperCase() === "USDT" && chain === "Bsc") return 18;
	return ({ BTC: 8, WBTC: 8, CBBTC: 8, ETH: 18, USDC: 6, USDT: 6, SOL: 9, FLIP: 18, DOT: 10, TRX: 6, BNB: 18 } as Record<string, number>)[asset.toUpperCase()];
}

function chainflipNetworkMatches(chain: unknown, network: unknown): boolean {
	const networks: Record<string, string> = {
		Bitcoin: "bip122:000000000019d6689c085ae165831e93", Ethereum: "eip155:1", Arbitrum: "eip155:42161",
		Bsc: "eip155:56", Solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", Tron: "tron:0x2b6653dc",
	};
	return typeof chain === "string" && networks[chain] !== undefined && networks[chain] === network;
}

function relayTrackingStatus(raw: string, current: string): string {
	switch (raw) {
		case "success": return "completed";
		case "fallback": case "refund": case "refunded": return "refunded";
		case "failure": case "failed": return "failed";
		case "submitted": return "output_confirming";
		case "received": case "depositing": case "pending": case "delayed": return "confirming";
		case "waiting": return "pending";
		default: return current;
	}
}

function objectOrEmpty(raw: unknown): Record<string, unknown> {
	return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

function isShapeShift(payload: Record<string, unknown>): boolean {
	const integration = String(payload.integration || "").toLowerCase();
	const quote = objectOrEmpty(payload.quote);
	const raw = objectOrEmpty(quote.raw);
	return integration === "shapeshift" || integration === "shapeshiftswap" || String(raw.source || "").toLowerCase() === "shapeshift";
}

function shapeShiftQuoteId(payload: Record<string, unknown>): string | null {
	const quote = objectOrEmpty(payload.quote);
	const raw = objectOrEmpty(quote.raw);
	const meta = objectOrEmpty(quote.meta);
	for (const value of [quote.quoteId, raw.quoteId, meta.quoteId]) {
		if (typeof value === "string" && value.length >= 8 && value.length <= 256 && !/\s/.test(value)) return value;
	}
	return null;
}

function stringArray(raw: unknown): string[] {
	return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function midgardProtocol(payload: Record<string, unknown>): "thorchain" | "mayachain" | null {
	const integration = String(payload.integration || "").toLowerCase().replace(/[\s_.-]/g, "");
	const swapper = String(payload.swapper || "").toLowerCase().replace(/[\s_.-]/g, "");
	if (swapper.includes("maya") || integration.includes("maya")) return "mayachain";
	if (swapper.includes("thor") || integration.includes("thor")) return "thorchain";
	return null;
}

function classifyMidgard(raw: any, current: string): { status: string; outboundTxid?: string; outboundAsset?: string; outboundAmount?: string; refundReason?: string; actionType: string; actionStatus: string } | null {
	const action = Array.isArray(raw?.actions) ? raw.actions[0] : null;
	if (!action || typeof action !== "object") return null;
	const actionType = String(action.type || "").toLowerCase();
	const actionStatus = String(action.status || "").toLowerCase();
	const outbound = Array.isArray(action.out) ? action.out[0] : null;
	const coin = Array.isArray(outbound?.coins) ? outbound.coins[0] : null;
	const outboundTxid = typeof outbound?.txID === "string" && outbound.txID ? outbound.txID : undefined;
	const outboundAsset = typeof coin?.asset === "string" && coin.asset ? coin.asset : undefined;
	const outboundAmount = typeof coin?.amount === "string" && /^\d+$/.test(coin.amount) ? coin.amount : undefined;
	if (actionType === "refund") {
		const reason = typeof action.metadata?.refund?.reason === "string" ? action.metadata.refund.reason.replace(/^MidgardBadUTF8EncodedBase64:\s*/, "").trim() : undefined;
		return { status: actionStatus === "pending" || !outboundTxid ? "confirming" : "refunded", outboundTxid, outboundAsset, outboundAmount, refundReason: reason, actionType, actionStatus };
	}
	if (actionType === "swap") {
		if (["failed", "failure", "error"].includes(actionStatus)) return { status: "failed", actionType, actionStatus };
		if (actionStatus === "success" && outboundTxid) return { status: "completed", outboundTxid, outboundAsset, outboundAmount, actionType, actionStatus };
		return { status: current === "pending" ? "confirming" : current, actionType, actionStatus };
	}
	return { status: current, outboundTxid, outboundAsset, outboundAmount, actionType, actionStatus };
}

function unitsToDecimal(raw: string, decimals: number): string {
	const value = BigInt(raw);
	const padded = value.toString().padStart(decimals + 1, "0");
	const whole = padded.slice(0, -decimals);
	const fraction = padded.slice(-decimals).replace(/0+$/, "");
	return fraction ? `${whole}.${fraction}` : whole;
}

async function fetchJsonFailover(fetcher: typeof fetch, urls: string[], headers: Record<string, string>, provider: string): Promise<any> {
	let lastError: unknown;
	for (const url of urls) {
		try {
			return await fetchJson(fetcher, url, headers, provider);
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError instanceof Error ? lastError : new Error(`${provider} Midgard unavailable`);
}

async function fetchJson(fetcher: typeof fetch, url: string, headers: Record<string, string> = {}, provider = "Relay"): Promise<any> {
	const response = await fetcher(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(8_000) });
	const body = await response.json().catch(() => null) as any;
	if (!response.ok) throw new Error(`${provider} returned ${response.status}: ${body?.message || body?.error || "request failed"}`);
	return body;
}
