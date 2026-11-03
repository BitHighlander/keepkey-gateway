import type { Database, StoredPendingSwap } from "./database";
import type { EvmClient } from "./evm";
import { UNISWAP_EXECUTE, UNISWAP_ROUTER, UNISWAP_OUTPUTS } from "./uniswap";
import { NATIVE_NEAR_ASSETS, NEAR_INTENTS_ORIGIN, nearAddressMatches, nearUnitsToDecimal } from "./near-intents";
import { validateSwapAddress } from "./swap-addresses";

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
	private nearTokens: any[] = [];
	private nearTokensCheckedAt = 0;

	constructor(private readonly database: Database, private readonly options: { fetch?: typeof fetch; refreshIntervalMs?: number; initialGraceMs?: number; evm?: Pick<EvmClient, "lookupTransaction" | "readRpc"> } = {}) {
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
		refreshed = await this.refreshNearIntents(clientId, normalized, refreshed) || refreshed;
		refreshed = await this.refreshUniswap(clientId, normalized, refreshed) || refreshed;
		return response(refreshed || stored);
	}

	/** A source deposit is not a completed swap. Bind the registered intent to
	 * both customer addresses/assets, then require a distinct settled payout and
	 * the actual output amount before recording success. */
	private async refreshNearIntents(clientId: string, txHash: string, stored: StoredPendingSwap): Promise<StoredPendingSwap | null> {
		const route = `${stored.payload.integration || ""} ${stored.payload.swapper || ""}`.toLowerCase().replace(/[\s_-]/g, "");
		if (!route.includes("nearintent")) return stored;
		try {
			const sell = objectOrEmpty(stored.payload.sellAsset), buy = objectOrEmpty(stored.payload.buyAsset);
			const quote = objectOrEmpty(stored.payload.quote), raw = objectOrEmpty(quote.raw);
			const normalized = objectOrEmpty(raw.quote || raw), meta = { ...objectOrEmpty(normalized.meta), ...objectOrEmpty(quote.meta) };
			const near = objectOrEmpty(stored.payload.nearIntentsData);
			const depositAddress = String(near.depositAddress || meta.depositAddress || normalized.inbound_address || "");
			const refundTo = String(near.refundTo || meta.refundTo || sell.address || ""), recipient = String(buy.address || "");
			if (!depositAddress || !refundTo || !recipient || validateSwapAddress(String(sell.caip), depositAddress)
				|| validateSwapAddress(String(sell.caip), refundTo) || validateSwapAddress(String(buy.caip), recipient)) throw new Error("NEAR tracking is missing valid customer or deposit addresses");
			// Old clients sent the deposit address as sellAsset.address. That cannot
			// establish the customer's refund address; never infer one from it.
			if (nearAddressMatches(String(sell.caip), depositAddress, refundTo)) throw new Error("NEAR tracking is missing the source wallet refund address");
			const body = await fetchJson(this.fetcher, `${NEAR_INTENTS_ORIGIN}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`, {}, "NEAR Intents");
			const registered = body?.quoteResponse, echo = registered?.quoteRequest, terms = registered?.quote;
			const resolve = async (caip: string) => {
				const network = caip.split("/")[0], asset = caip.split("/")[1];
				const native = NATIVE_NEAR_ASSETS.find(a => a.caip.toLowerCase() === caip.toLowerCase()
					|| (a.networkId === network && asset === "slip44:60" && ["eip155:56", "eip155:137", "eip155:43114"].includes(network)));
				if (native) return native;
				if (!this.nearTokensCheckedAt || Date.now() - this.nearTokensCheckedAt > 5 * 60_000) {
					const registry = await fetchJson(this.fetcher, `${NEAR_INTENTS_ORIGIN}/v0/tokens`, {}, "NEAR Intents");
					if (!Array.isArray(registry)) throw new Error("NEAR token registry is invalid");
					this.nearTokens = registry;
					this.nearTokensCheckedAt = Date.now();
				}
				const blockchain = NATIVE_NEAR_ASSETS.find(a => a.networkId === network)?.blockchain;
				const contract = asset?.replace(/^(?:erc20|token):/, "");
				const token = this.nearTokens.find(t => t.blockchain === blockchain && typeof t.contractAddress === "string"
					&& (network.startsWith("eip155:") ? t.contractAddress.toLowerCase() === contract?.toLowerCase() : t.contractAddress === contract));
				if (!token || typeof token.assetId !== "string" || !Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 255) throw new Error("NEAR tracking asset is absent from the token registry");
				return token as { assetId: string; decimals: number };
			};
			const source = await resolve(String(sell.caip)), destination = await resolve(String(buy.caip));
			const amount = nearDecimalUnits(String(sell.amount), source.decimals);
			const minimum = nearDecimalUnits(String(near.minimumAmountOut || quote.minimumAmountOut || normalized.amountOutMin || ""), destination.decimals);
			if (!echo || !terms || echo.dry !== false || echo.swapType !== "EXACT_INPUT" || echo.depositType !== "ORIGIN_CHAIN" || echo.depositMode !== "SIMPLE"
				|| echo.refundType !== "ORIGIN_CHAIN" || echo.recipientType !== "DESTINATION_CHAIN"
				|| echo.originAsset !== source.assetId || echo.destinationAsset !== destination.assetId || echo.amount !== amount.toString()
				|| !nearAddressMatches(String(sell.caip), String(echo.refundTo), refundTo) || !nearAddressMatches(String(buy.caip), String(echo.recipient), recipient)
				|| !nearAddressMatches(String(sell.caip), String(terms.depositAddress), depositAddress) || terms.amountIn !== amount.toString()
				|| (terms.depositMemo != null && terms.depositMemo !== "") || nearPositiveUnits(terms.minAmountOut) < minimum) throw new Error("NEAR status does not match this swap's assets, deposit, minimum or customer addresses");
			const state = String(body.status || "").toUpperCase(), details = body.swapDetails || {};
			const origins = nearHashList(details.originChainTxHashes), outputs = nearHashList(details.destinationChainTxHashes);
			const sourceKnown = origins.some(hash => nearHashMatches(String(sell.networkId), hash, txHash));
			const outbound = outputs.find(hash => !nearHashMatches(String(sell.networkId), hash, txHash));
			const refund = origins.find(hash => !nearHashMatches(String(sell.networkId), hash, txHash));
			let status = stored.status;
			if (state === "SUCCESS") {
				if (!sourceKnown || !outbound || nearPositiveUnits(details.depositedAmount) < amount
					|| nearPositiveUnits(details.amountOut) < minimum || nearPositiveUnits(details.amountOut) < nearPositiveUnits(terms.minAmountOut)) throw new Error("NEAR completion has no bound deposit and confirmed minimum payout");
				status = "completed";
			} else if (state === "REFUNDED") {
				if (!sourceKnown || !refund || nearPositiveUnits(details.refundedAmount) <= 0n) throw new Error("NEAR refund has no bound deposit and refund payout");
				status = "refunded";
			} else if (state === "FAILED") {
				// A provider error before recognizing our transaction cannot prove
				// that the broadcast deposit has failed or that funds were returned.
				if (!sourceKnown) throw new Error("NEAR has not identified this source transaction");
				status = "failed";
			} else if (["PROCESSING", "KNOWN_DEPOSIT_TX", "INCOMPLETE_DEPOSIT"].includes(state)) {
				status = state === "PROCESSING" && sourceKnown ? "swapping" : "confirming";
			} else if (state !== "PENDING_DEPOSIT") throw new Error("NEAR returned an unknown execution status");
			return await this.database.updatePendingSwap(clientId, txHash, status, {
				...(sourceKnown ? { confirmations: 1, requiredConfirmations: 1 } : {}),
				...(status === "completed" ? { outboundTxid: outbound, outboundTxHash: outbound, outboundConfirmations: 1, outboundRequiredConfirmations: 1,
					receivedOutputBaseUnits: details.amountOut, receivedOutput: nearUnitsToDecimal(details.amountOut, destination.decimals), completedAt: new Date().toISOString() } : {}),
				...(status === "refunded" ? { refundTxid: refund, refundReason: details.refundReason || "NEAR Intents returned the deposit", refundedAmountBaseUnits: details.refundedAmount } : {}),
				...(status === "failed" ? { error: { provider: "near-intents", message: details.refundReason || "NEAR Intents reports execution failed" } } : {}),
				nearIntentsData: { ...near, depositAddress, refundTo, originAsset: source.assetId, destinationAsset: destination.assetId,
					sourceDecimals: source.decimals, destinationDecimals: destination.decimals, nearStatus: state, correlationId: body.correlationId,
					originChainTxHashes: origins, destinationChainTxHashes: outputs },
				providerCheck: { provider: "near-intents", result: state },
			});
		} catch (error) {
			return await this.database.updatePendingSwap(clientId, txHash, stored.status, { providerCheck: { provider: "near-intents", result: "unavailable", message: error instanceof Error ? error.message : String(error) } });
		}
	}

	/** A direct atomic swap is complete only after the source receipt contains
	 * the requested output transfer. Never use the quote as the received amount. */
	private async refreshUniswap(clientId: string, txHash: string, stored: StoredPendingSwap): Promise<StoredPendingSwap | null> {
		if (stored.payload.integration !== "uniswap" || !this.options.evm) return stored;
		try {
			const sell = objectOrEmpty(stored.payload.sellAsset), buy = objectOrEmpty(stored.payload.buyAsset);
			const token = String(buy.caip).toLowerCase().split("eip155:1/erc20:")[1];
			if (sell.caip !== "eip155:1/slip44:60" || buy.networkId !== "eip155:1" || !UNISWAP_OUTPUTS.has(token)) throw new Error("Unsupported direct Uniswap pair");
			const { data } = await this.options.evm.lookupTransaction("eip155:1", txHash);
			const tx = data.tx as any, receipt = data.receipt as any;
			if (!tx || !receipt) return stored;
			if (String(tx.hash).toLowerCase() !== txHash || String(receipt.transactionHash).toLowerCase() !== txHash
				|| String(tx.from).toLowerCase() !== String(sell.address).toLowerCase()
				|| String(tx.to).toLowerCase() !== UNISWAP_ROUTER || String(receipt.to).toLowerCase() !== UNISWAP_ROUTER
				|| BigInt(tx.value) !== BigInt(String(sell.amountBaseUnits))) throw new Error("Uniswap transaction does not match the deposit");
			const [commands, inputs] = UNISWAP_EXECUTE.decodeFunctionData("execute", tx.input);
			if (commands !== "0x0b000604" || inputs.length !== 4) throw new Error("Unexpected direct Uniswap route");
			// SWEEP encodes both the actual recipient and the enforced net minimum.
			const sweep = String(inputs[3]).replace(/^0x/, "");
			if (!/^[0-9a-f]{192}$/i.test(sweep) || `0x${sweep.slice(24, 64)}`.toLowerCase() !== token
				|| `0x${sweep.slice(88, 128)}`.toLowerCase() !== String(buy.address).toLowerCase()) throw new Error("Uniswap payout recipient does not match");
			if (BigInt(receipt.status) === 0n) return await this.database.updatePendingSwap(clientId, txHash, "failed", { error: "Uniswap transaction reverted", failedAt: new Date().toISOString() });
			if (BigInt(receipt.status) !== 1n) throw new Error("Unknown Uniswap receipt status");
			const recipientTopic = String(buy.address).slice(2).toLowerCase().padStart(64, "0");
			const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
			const received = (receipt.logs || []).filter((log: any) => !log.removed && String(log.address).toLowerCase() === token
				&& log.topics?.length === 3 && String(log.topics[0]).toLowerCase() === transferTopic
				&& String(log.topics[2]).toLowerCase() === `0x${recipientTopic}`)
				.reduce((sum: bigint, log: any) => sum + BigInt(log.data), 0n) as bigint;
			if (received <= 0n || received < BigInt(`0x${sweep.slice(128)}`)) throw new Error("Uniswap receipt has no matching minimum payout");
			const head = BigInt(String((await this.options.evm.readRpc("eip155:1", "eth_blockNumber", [])).data));
			const confirmations = Number(head - BigInt(receipt.blockNumber) + 1n);
			if (confirmations < 1) throw new Error("Uniswap receipt is ahead of the current chain");
			return await this.database.updatePendingSwap(clientId, txHash, confirmations >= 2 ? "completed" : "output_confirming", {
				confirmations, requiredConfirmations: 2, outboundConfirmations: confirmations, outboundRequiredConfirmations: 2,
				outboundTxid: txHash, outboundTxHash: txHash, receivedOutput: unitsToDecimal(received.toString(), 6), receivedOutputBaseUnits: received.toString(),
				...(confirmations >= 2 ? { completedAt: new Date().toISOString() } : {}),
			});
		} catch (error) {
			return await this.database.updatePendingSwap(clientId, txHash, stored.status, { lastError: error instanceof Error ? error.message : String(error) });
		}
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
			let nextStatus = relayTrackingStatus(relayStatus, stored.status);
			const inTxHashes = stringArray(directStatus?.inTxHashes || (directStatus as any)?.data?.inTxs?.map((item: any) => item?.hash));
			const outTxHashes = stringArray(directStatus?.txHashes || (directStatus as any)?.data?.outTxs?.map((item: any) => item?.hash));
			const sameChain = directStatus?.originChainId != null && directStatus?.originChainId === directStatus?.destinationChainId;
			const solverDeposit = existingRelay.executionMode === "solver-deposit";
			const outboundTxHash = outTxHashes[0] || (nextStatus === "completed" && sameChain && !solverDeposit ? inTxHashes[0] || String(stored.payload.txHash || txHash) : undefined);
			if (nextStatus === "completed" && solverDeposit && !outboundTxHash) nextStatus = "output_confirming";
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

function nearPositiveUnits(raw: unknown): bigint {
	if (typeof raw !== "string" || !/^[0-9]+$/.test(raw) || BigInt(raw) <= 0n) throw new Error("NEAR is missing a positive settlement amount");
	return BigInt(raw);
}

function nearDecimalUnits(raw: string, decimals: number): bigint {
	if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(raw)) throw new Error("NEAR tracking is missing an exact asset amount");
	const [whole, fraction = ""] = raw.split(".");
	if (/[1-9]/.test(fraction.slice(decimals))) throw new Error("NEAR tracking amount exceeds asset precision");
	return nearPositiveUnits(`${whole}${fraction.slice(0, decimals).padEnd(decimals, "0")}`);
}

function nearHashList(raw: unknown): string[] {
	return Array.isArray(raw) ? raw.flatMap(item => typeof item?.hash === "string" && item.hash.length >= 8 && !/\s/.test(item.hash) ? [item.hash] : []) : [];
}

function nearHashMatches(network: string, left: string, right: string): boolean {
	return /^(?:eip155:|bip122:|tron:|ripple:)/.test(network)
		? left.replace(/^0x/i, "").toLowerCase() === right.replace(/^0x/i, "").toLowerCase() : left === right;
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
