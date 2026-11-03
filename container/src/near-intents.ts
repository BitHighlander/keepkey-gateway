import { Interface } from "ethers";
import type { QuoteAdapter, QuoteRequest } from "./swap";
import { validateSwapAddress } from "./swap-addresses";

export const NEAR_INTENTS_ORIGIN = "https://1click.chaindefuser.com";
export const NEAR_INTENTS_FEE_RECIPIENT = "caa0106da86351f909f1dfa28e7bfa65665554dc512ab2eedd431b040daa3a1f";
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
type Asset = { caip: string; assetId: string; decimals: number; symbol: string };
const natives: Array<[string, string, string, number, string]> = [
	["eip155:1/slip44:60", "nep141:eth.omft.near", "ETH", 18, "eth"],
	["eip155:42161/slip44:60", "nep141:arb.omft.near", "ETH", 18, "arb"],
	["eip155:8453/slip44:60", "nep141:base.omft.near", "ETH", 18, "base"],
	["eip155:10/slip44:60", "nep245:v2_1.omni.hot.tg:10_11111111111111111111", "ETH", 18, "op"],
	["eip155:43114/slip44:9000", "nep245:v2_1.omni.hot.tg:43114_11111111111111111111", "AVAX", 18, "avax"],
	["eip155:56/slip44:714", "nep245:v2_1.omni.hot.tg:56_11111111111111111111", "BNB", 18, "bsc"],
	["eip155:137/slip44:966", "nep245:v2_1.omni.hot.tg:137_11111111111111111111", "POL", 18, "pol"],
	["eip155:100/slip44:60", "nep141:gnosis.omft.near", "xDAI", 18, "gnosis"],
	["bip122:000000000019d6689c085ae165831e93/slip44:0", "nep141:btc.omft.near", "BTC", 8, "btc"],
	["bip122:12a765e31ffd4059bada1e25190f6e98/slip44:2", "nep141:ltc.omft.near", "LTC", 8, "ltc"],
	["bip122:00040fe8ec8471911baa1db1266ea15d/slip44:133", "nep141:zec.omft.near", "ZEC", 8, "zec"],
	["bip122:000007d91d1254d60e2dd1ae58038307/slip44:5", "nep141:dash.omft.near", "DASH", 8, "dash"],
	["bip122:00000000001a91e3dace36e2be3bf030/slip44:3", "nep141:doge.omft.near", "DOGE", 8, "doge"],
	["bip122:000000000000000000651ef99cb9fcbe/slip44:145", "nep141:bch.omft.near", "BCH", 8, "bch"],
	[`${SOL}/slip44:501`, "nep141:sol.omft.near", "SOL", 9, "sol"],
	["tron:0x2b6653dc/slip44:195", "nep141:tron.omft.near", "TRX", 6, "tron"],
	["ripple:4109c6f2045fc7eff4cde8f9905d19c2/slip44:144", "nep141:xrp.omft.near", "XRP", 6, "xrp"],
];
const chains = new Map(natives.map(([caip, , , , blockchain]) => [blockchain, caip.split("/")[0]]));
export const NATIVE_NEAR_ASSETS = natives.map(([caip, assetId, symbol, decimals, blockchain]) => ({ caip, assetId, symbol, decimals, blockchain, networkId: caip.split("/")[0] }));
export const NEAR_INTENTS_NETWORKS = [...new Set(chains.values())];
const knownNetworks = new Set(NEAR_INTENTS_NETWORKS.map(n => n.toLowerCase()));
const erc20 = new Interface(["function transfer(address to,uint256 amount)"]);
function key(caip: string): string {
	const [network, asset = ""] = caip.split("/");
	const nativeAlias: Record<string, string> = { "eip155:43114": "slip44:9000", "eip155:56": "slip44:714", "eip155:137": "slip44:966" };
	if (asset === "slip44:60" && nativeAlias[network.toLowerCase()]) return `${network.toLowerCase()}/${nativeAlias[network.toLowerCase()]}`;
	// Token base58 case is significant. Only EVM contract IDs can be normalized.
	return `${network.toLowerCase()}/${asset.startsWith("erc20:") || asset.startsWith("slip44:") ? asset.toLowerCase() : asset}`;
}
function fail(message: string): never { throw new Error(`NEAR Intents: ${message}`); }
function positive(value: unknown, label: string): bigint {
	if (!/^[0-9]+$/.test(String(value)) || BigInt(String(value)) <= 0n) fail(`invalid ${label}`);
	return BigInt(String(value));
}
function nonnegative(value: unknown): bigint | null {
	return /^[0-9]+$/.test(String(value)) ? BigInt(String(value)) : null;
}
function units(amount: string, decimals: number): bigint {
	if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(amount)) fail("amount must be a positive decimal string");
	const [whole, fraction = ""] = amount.split(".");
	if (/[1-9]/.test(fraction.slice(decimals))) fail(`amount exceeds ${decimals}-decimal asset precision`);
	return positive(`${whole}${fraction.slice(0, decimals).padEnd(decimals, "0")}`, "source amount");
}
export function nearUnitsToDecimal(value: string | bigint, decimals: number): string {
	const amount = BigInt(value).toString().padStart(decimals + 1, "0");
	if (!decimals) return amount;
	return `${amount.slice(0, -decimals)}.${amount.slice(-decimals)}`.replace(/\.?0+$/, "");
}
export function nearAddressMatches(caip: string, left: string, right: string): boolean {
	if (caip.startsWith("eip155:")) return left.toLowerCase() === right.toLowerCase();
	if (caip.startsWith("bip122:000000000000000000651ef99cb9fcbe")) return left.replace(/^bitcoincash:/i, "").toLowerCase() === right.replace(/^bitcoincash:/i, "").toLowerCase();
	if (/^(?:bc1|ltc1)/i.test(left) && /^(?:bc1|ltc1)/i.test(right)) return left.toLowerCase() === right.toLowerCase();
	return left === right;
}

/** Demand-driven 1Click integration. Construction and eligibility never fetch. */
export class NearIntentsQuoteAdapter implements QuoteAdapter {
	readonly key = "nearIntents";
	readonly memoless = true;
	private assets = new Map<string, Asset>(natives.map(([caip, assetId, symbol, decimals]) => [key(caip), { caip, assetId, symbol, decimals }]));
	private tokenLoad?: Promise<void>;
	private tokenLoadedAt = 0;
	private readonly now: () => number;
	private readonly recipient: string;
	private readonly feeBps: number;
	constructor(private readonly fetcher: typeof fetch = fetch, private readonly options: {
		apiKey?: string; feeRecipient?: string; feeBps?: number; now?: () => number;
	} = {}) {
		this.now = options.now || Date.now;
		this.recipient = options.feeRecipient || NEAR_INTENTS_FEE_RECIPIENT;
		this.feeBps = options.feeBps ?? 30;
		if (!Number.isInteger(this.feeBps) || this.feeBps < 0 || this.feeBps > 450) throw new Error("NEAR feeBps must be an integer from 0 to 450");
	}
	eligible(request: QuoteRequest): boolean {
		return [request.sellAsset, request.buyAsset].every(caip => knownNetworks.has(caip.split("/")[0].toLowerCase())
			&& /\/(?:slip44:[0-9]+|erc20:0x[0-9a-fA-F]{40}|token:[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(caip));
	}
	assetSupport(): Asset[] { return [...this.assets.values()].map(asset => ({ ...asset })); }
	private headers(): Record<string, string> {
		return { "Content-Type": "application/json", Accept: "application/json", ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}) };
	}
	private async json(path: string, init: RequestInit = {}): Promise<any> {
		const response = await this.fetcher(`${NEAR_INTENTS_ORIGIN}${path}`, { ...init, headers: this.headers(), signal: AbortSignal.timeout(15_000) });
		const body = await response.json().catch(() => null);
		if (!response.ok) fail(`provider HTTP ${response.status}: ${typeof body?.message === "string" ? body.message : "request unavailable"}`);
		if (!body || typeof body !== "object") fail("provider returned an invalid response");
		return body;
	}
	private async loadTokens(): Promise<void> {
		if (this.tokenLoadedAt && this.now() - this.tokenLoadedAt < 5 * 60_000) return;
		if (this.tokenLoad) return this.tokenLoad;
		this.tokenLoad = (async () => {
			try {
				const body = await this.json("/v0/tokens");
				const tokens = Array.isArray(body) ? body : body.tokens;
				if (!Array.isArray(tokens)) fail("invalid token registry");
				for (const token of tokens) {
					const network = chains.get(token.blockchain);
					if (!network || typeof token.assetId !== "string" || !Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 255) continue;
					let caip: string | undefined;
					const native = natives.find(([candidate, assetId, symbol]) => candidate.split("/")[0] === network
						&& (assetId === token.assetId || ((!token.contractAddress || /^0x0{40}$/.test(token.contractAddress)) && symbol === token.symbol)));
					if (native) caip = native[0];
					else if (network.startsWith("eip155:") && /^0x[0-9a-fA-F]{40}$/.test(token.contractAddress) && !/^0x0{40}$/.test(token.contractAddress)) caip = `${network}/erc20:${token.contractAddress.toLowerCase()}`;
					else if ((network === SOL || network.startsWith("tron:")) && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(token.contractAddress)) caip = `${network}/token:${token.contractAddress}`;
					if (caip) this.assets.set(key(caip), { caip, assetId: token.assetId, decimals: token.decimals, symbol: String(token.symbol || "token") });
				}
				this.tokenLoadedAt = this.now();
			} catch {
				// Native mappings remain usable during a registry outage; unknown
				// tokens fail explicitly rather than guessing their decimals.
			}
		})().finally(() => { this.tokenLoad = undefined; });
		return this.tokenLoad;
	}
	async quote(request: QuoteRequest): Promise<Record<string, any>> {
		if (!this.eligible(request)) fail("unsupported pair");
		for (const [caip, address] of [[request.sellAsset, request.senderAddress], [request.buyAsset, request.recipientAddress]]) {
			const error = validateSwapAddress(caip, address);
			if (error) fail(error);
		}
		await this.loadTokens();
		const sell = this.assets.get(key(request.sellAsset)), buy = this.assets.get(key(request.buyAsset));
		if (!sell || !buy) fail("asset is absent from the live token registry");
		const amount = units(request.sellAmount, sell.decimals);
		const slippageBps = Math.round(Number(request.slippage ?? 3) * 100);
		if (!Number.isInteger(slippageBps) || slippageBps <= 0 || slippageBps > 5000) fail("invalid slippage");
		const deadline = new Date(this.now() + 30 * 60_000).toISOString();
		const wanted = { dry: false, swapType: "EXACT_INPUT", depositType: "ORIGIN_CHAIN", depositMode: "SIMPLE", originAsset: sell.assetId,
			destinationAsset: buy.assetId, amount: amount.toString(), slippageTolerance: slippageBps,
			recipient: request.recipientAddress, recipientType: "DESTINATION_CHAIN", refundTo: request.senderAddress, refundType: "ORIGIN_CHAIN",
			deadline, referral: "keepkey", ...(this.feeBps > 0 ? { appFees: [{ recipient: this.recipient, fee: this.feeBps }] } : {}) };
		const raw = await this.json("/v0/quote", { method: "POST", body: JSON.stringify(wanted) });
		const validate = (body: any) => {
			const echo = body?.quoteRequest, quote = body?.quote;
			if (!echo || !quote || echo.dry !== false || echo.swapType !== "EXACT_INPUT" || echo.depositType !== "ORIGIN_CHAIN"
				|| echo.depositMode !== "SIMPLE" || echo.refundType !== "ORIGIN_CHAIN" || echo.recipientType !== "DESTINATION_CHAIN"
				|| echo.originAsset !== sell.assetId || echo.destinationAsset !== buy.assetId || echo.amount !== amount.toString()
				|| echo.slippageTolerance !== slippageBps || !nearAddressMatches(sell.caip, String(echo.refundTo), request.senderAddress)
				|| !nearAddressMatches(buy.caip, String(echo.recipient), request.recipientAddress)) fail("quote does not match the requested deposit, assets or customer addresses");
			const effectiveFees = echo.appFees;
			if (!Array.isArray(effectiveFees)
				|| effectiveFees.some((fee: any) => typeof fee.recipient !== "string" || !Number.isInteger(fee.fee) || fee.fee < 0)
				|| effectiveFees.reduce((sum: number, fee: any) => sum + fee.fee, 0) > this.feeBps + 25) fail("quote lost or exceeded the configured affiliate fee");
			const affiliateBps = effectiveFees.filter((fee: any) => fee.recipient === this.recipient).reduce((sum: number, fee: any) => sum + fee.fee, 0);
			if (affiliateBps > this.feeBps || (this.feeBps > 0 && affiliateBps <= 0)) fail("quote lost or exceeded the configured affiliate fee");
			if (quote.amountIn !== amount.toString() || positive(quote.minAmountIn, "minimum input") > amount) fail("provider changed the deposit amount");
			const output = positive(quote.amountOut, "output"), minimum = positive(quote.minAmountOut, "minimum output");
			if (minimum > output || minimum < output * BigInt(10_000 - slippageBps) / 10_000n) fail("provider returned an unsafe minimum output");
			if (typeof quote.depositAddress !== "string" || !quote.depositAddress || validateSwapAddress(sell.caip, quote.depositAddress)) fail("invalid source-chain deposit address");
			// SIMPLE deposits must not rely on a tag/memo that a plain transfer
			// builder could silently omit. The destination is registered off-chain.
			if (quote.depositMemo != null && quote.depositMemo !== "") fail("this deposit requires an unsupported memo");
			const expires = Math.min(Date.parse(echo.deadline), Date.parse(quote.deadline || echo.deadline));
			if (!Number.isFinite(expires) || expires <= this.now() + 15_000 || expires > Date.parse(deadline)) fail("invalid or expired deposit deadline");
			return { echo, quote, output, minimum, effectiveFees, expires };
		};
		const bound = validate(raw);
		const status = await this.json(`/v0/status?depositAddress=${encodeURIComponent(bound.quote.depositAddress)}`);
		if (status.status !== "PENDING_DEPOSIT") fail("deposit is not awaiting payment");
		const registered = validate(status.quoteResponse);
		const feeSchedule = (fees: any[]) => JSON.stringify(fees.map(fee => [fee.recipient, fee.fee]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
		if (registered.quote.depositAddress !== bound.quote.depositAddress || registered.output !== bound.output || registered.minimum !== bound.minimum
			|| registered.expires !== bound.expires || feeSchedule(registered.effectiveFees) !== feeSchedule(bound.effectiveFees)) fail("registered deposit terms do not match the quote");
		const quote = bound.quote;
		const network = sell.caip.split("/")[0];
		const txParams: Record<string, any> = { to: quote.depositAddress, recipientAddress: quote.depositAddress, senderAddress: request.senderAddress, amount: request.sellAmount, token: request.sellAsset, swapper: "NEAR Intents" };
		let type = "transfer";
		if (network.startsWith("eip155:")) {
			type = "EVM";
			txParams.chainId = Number(network.slice(7));
			txParams.data = "0x";
			txParams.value = amount.toString();
			if (sell.caip.includes("/erc20:")) {
				txParams.to = sell.caip.split("/erc20:")[1];
				txParams.data = erc20.encodeFunctionData("transfer", [quote.depositAddress, amount]);
				txParams.value = "0";
			}
		} else if (network === SOL) type = "SOLANA";
		const feeItems: Record<string, unknown>[] = bound.effectiveFees.map((fee: any) => ({ kind: fee.recipient === this.recipient ? "affiliate" : "protocol",
			assetCaip: request.sellAsset, symbol: sell.symbol, decimals: sell.decimals, amountBaseUnits: (amount * BigInt(fee.fee) / 10_000n).toString(), bps: fee.fee,
			recipient: fee.recipient, label: fee.recipient === this.recipient ? "KeepKey app fee" : "1Click platform fee" }));
		const withdraw = nonnegative(quote.withdrawFee);
		const refund = nonnegative(quote.refundFee);
		if (withdraw !== null && withdraw > 0n) feeItems.push({ kind: "network", assetCaip: request.buyAsset, symbol: buy.symbol, decimals: buy.decimals,
			amountBaseUnits: withdraw.toString(), label: "Destination withdrawal (included in output)" });
		return { id: raw.correlationId || crypto.randomUUID(), source: "near-intents", swapper: "NEAR Intents", complete: true, steps: 1,
			amountOut: nearUnitsToDecimal(bound.output, buy.decimals), buyAmount: nearUnitsToDecimal(bound.output, buy.decimals), amountOutMin: nearUnitsToDecimal(bound.minimum, buy.decimals),
			inbound_address: quote.depositAddress, expiry: Math.floor(bound.expires / 1000), minAmountIn: nearUnitsToDecimal(quote.minAmountIn, sell.decimals),
			txs: [{ type, chain: network, txParams }],
			meta: { quoteMode: "NEAR_INTENTS", correlationId: raw.correlationId, depositAddress: quote.depositAddress, depositMemo: null,
				originAsset: sell.assetId, destinationAsset: buy.assetId, refundTo: request.senderAddress, recipient: request.recipientAddress,
				sourceDecimals: sell.decimals, destinationDecimals: buy.decimals, timeEstimate: quote.timeEstimate,
				depositVerification: { status: "PENDING_DEPOSIT", checkedAt: this.now() }, feeBreakdown: { requestedAppBps: this.feeBps, effectiveAppFees: bound.effectiveFees, items: feeItems,
					...(refund !== null ? { refund: { assetCaip: request.sellAsset, symbol: sell.symbol, decimals: sell.decimals, amountBaseUnits: refund.toString(), label: "Refund cost if returned" } } : {}) },
				submitUrl: `${NEAR_INTENTS_ORIGIN}/v0/deposit/submit`, statusUrl: `${NEAR_INTENTS_ORIGIN}/v0/status` },
			raw: { ...raw, fees: { total_bps: bound.effectiveFees.reduce((sum: number, fee: any) => sum + fee.fee, 0), affiliate: "0", outbound: "0", items: feeItems }, total_swap_seconds: Number(quote.timeEstimate) || 0 } };
	}
}
