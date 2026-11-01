import assetData from "../data/assets.json";
import chainData from "../data/chains.json";
import swapAssetsSnapshot from "../data/swap-assets.json";
import supportedChainsSnapshot from "../data/swap-supported-chains.json";
import type { EvmClient } from "./evm";
import type { SwapHealthObservation } from "./catalog";
import {
	AddressLookupTableAccount,
	AddressLookupTableProgram,
	PublicKey,
	TransactionInstruction,
	TransactionMessage,
	VersionedTransaction,
} from "@solana/web3.js";

export interface QuoteRequest {
	sellAsset: string;
	sellAmount: string;
	buyAsset: string;
	recipientAddress: string;
	senderAddress: string;
	slippage?: number;
	memoless?: boolean;
}

export interface QuoteAdapter {
	readonly key: string;
	readonly tier?: number;
	eligible(request: QuoteRequest): boolean;
	quote(request: QuoteRequest): Promise<Record<string, any>>;
}

export class SwapError extends Error {
	constructor(message: string, public readonly status = 502) {
		super(message);
	}
}

type ProviderKey = "thorchain" | "mayachain";
type AssetRecord = { assetId: string; chainId: string; symbol: string; decimals?: number };
type ChainRecord = {
	chainId: string;
	namespace: string;
	nativeAssetCaip?: string;
	nativeCurrency?: { symbol?: string; decimals?: number };
	thorchainId?: string;
	mayachainId?: string;
};

const ASSETS = assetData as Record<string, AssetRecord>;
const CHAINS = chainData as Record<string, ChainRecord>;
const SWAP_ASSETS = new Map(swapAssetsSnapshot.data.assets.map((asset) => [asset.caip.toLowerCase(), asset]));
const PROTOCOL_NETWORKS: Record<ProviderKey, ReadonlySet<string>> = {
	thorchain: new Set(supportedChainsSnapshot.thorchain.map((network) => network.toLowerCase())),
	mayachain: new Set(supportedChainsSnapshot.mayachain.map((network) => network.toLowerCase())),
};

const PROTOCOLS = {
	thorchain: {
		label: "thorchain",
		hosts: ["https://rest.cosmos.directory/thorchain", "https://gateway.liquify.com/chain/thorchain_api"],
		path: "/thorchain/quote/swap",
		affiliate: "keep",
		affiliateBps: 30,
	},
	mayachain: {
		label: "mayachain",
		hosts: ["https://mayanode.mayachain.info", "https://rest.cosmos.directory/mayachain", "https://api-maya.liquify.com"],
		path: "/mayachain/quote/swap",
		affiliate: "keep",
		affiliateBps: 30,
	},
} as const;

function networkId(caip: string): string {
	return caip.slice(0, caip.indexOf("/"));
}

function findAsset(caip: string): AssetRecord | undefined {
	return ASSETS[caip] || ASSETS[caip.toLowerCase()] || Object.values(ASSETS).find((asset) => asset.assetId.toLowerCase() === caip.toLowerCase());
}

function exactDecimalToUnits(amount: string, decimals: number): string {
	if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(amount)) throw new SwapError("sellAmount must be a positive decimal string", 400);
	const [whole, fraction = ""] = amount.split(".");
	if (fraction.length > decimals && /[1-9]/.test(fraction.slice(decimals))) throw new SwapError(`sellAmount exceeds ${decimals}-decimal protocol precision`, 400);
	const units = BigInt(`${whole}${fraction.slice(0, decimals).padEnd(decimals, "0")}`);
	if (units <= 0n) throw new SwapError("sellAmount must be greater than zero", 400);
	return units.toString();
}

function unitsToDecimal(units: string, decimals: number): string {
	const value = BigInt(units);
	const padded = value.toString().padStart(decimals + 1, "0");
	const whole = padded.slice(0, -decimals);
	const fraction = padded.slice(-decimals).replace(/0+$/, "");
	return fraction ? `${whole}.${fraction}` : whole;
}

function protocolAsset(caip: string, provider: ProviderKey): string | null {
	const network = networkId(caip);
	if (!PROTOCOL_NETWORKS[provider].has(network.toLowerCase())) return null;

	const pinned = SWAP_ASSETS.get(caip.toLowerCase());
	if (pinned && (provider === "thorchain" || ["BTC", "ETH", "ARB", "MAYA", "THOR", "DASH", "ZEC"].includes(pinned.chain))) {
		return pinned.asset;
	}

	const chain = CHAINS[network] || Object.values(CHAINS).find((entry) => entry.chainId.toLowerCase() === network.toLowerCase());
	const asset = findAsset(caip);
	const chainTicker = provider === "thorchain" ? chain?.thorchainId : chain?.mayachainId;
	if (!chainTicker || !asset?.symbol) return null;
	const assetPart = caip.slice(caip.indexOf("/") + 1);
	if (assetPart.startsWith("slip44:")) return `${chainTicker}.${asset.symbol.toUpperCase()}`;
	if (assetPart.startsWith("denom:")) return `${chainTicker}.${asset.symbol.toUpperCase()}`;
	const separator = assetPart.indexOf(":");
	if (separator < 0) return null;
	return `${chainTicker}.${asset.symbol.toUpperCase()}-${assetPart.slice(separator + 1).toUpperCase()}`;
}

function protocolDecimals(provider: ProviderKey, protocolAssetName: string): number {
	return provider === "mayachain" && protocolAssetName.startsWith("MAYA.") ? 10 : 8;
}

function memoAssetFromNode(rawMemo: unknown, fallback: string): string {
	if (typeof rawMemo !== "string") return fallback;
	const segments = rawMemo.split(":");
	return segments[1] || fallback;
}

function buildMemo(asset: string, destination: string, limit: bigint, affiliate: string, bps: number): string {
	return `=:${asset}:${destination}:${limit}:${affiliate}:${bps}`;
}

function transactionType(caip: string): string {
	const network = networkId(caip);
	if (network.startsWith("eip155:")) return "EVM";
	if (network.startsWith("solana:")) return "SOLANA";
	if (network === "cosmos:thorchain-mainnet-v1" || network === "cosmos:mayachain-mainnet-v1") return "deposit";
	return "transfer";
}

const RELAY_NETWORKS = new Set(supportedChainsSnapshot.relay.map((network) => network.toLowerCase()));
const RELAY_APP_FEE_RECIPIENT = "0x87Ab2637bc4231604ad708c5e8aAC92A260c7704";
const RELAY_APP_FEE_BPS = 30;

function evmChainNumber(caip: string): number | null {
	const match = networkId(caip).match(/^eip155:(\d+)$/);
	return match ? Number(match[1]) : null;
}

function evmCurrencyAddress(caip: string): string | null {
	const assetPart = caip.slice(caip.indexOf("/") + 1);
	if (assetPart.startsWith("slip44:")) return "0x0000000000000000000000000000000000000000";
	if (assetPart.startsWith("erc20:0x") && /^erc20:0x[a-fA-F0-9]{40}$/.test(assetPart)) return assetPart.slice(6);
	return null;
}

export class RelayQuoteAdapter implements QuoteAdapter {
	readonly key = "relay";
	constructor(private readonly fetcher: typeof fetch = fetch) {}

	eligible(request: QuoteRequest): boolean {
		return evmChainNumber(request.sellAsset) !== null
			&& evmChainNumber(request.buyAsset) !== null
			&& RELAY_NETWORKS.has(networkId(request.sellAsset).toLowerCase())
			&& RELAY_NETWORKS.has(networkId(request.buyAsset).toLowerCase())
			&& evmCurrencyAddress(request.sellAsset) !== null
			&& evmCurrencyAddress(request.buyAsset) !== null
			&& findAsset(request.sellAsset) !== undefined
			&& findAsset(request.buyAsset) !== undefined;
	}

	async quote(request: QuoteRequest): Promise<Record<string, any>> {
		if (!this.eligible(request)) throw new SwapError("Relay does not support this pair", 422);
		const sell = findAsset(request.sellAsset)!;
		const buy = findAsset(request.buyAsset)!;
		const amount = exactDecimalToUnits(request.sellAmount, sell.decimals ?? 18);
		const originChainId = evmChainNumber(request.sellAsset)!;
		const destinationChainId = evmChainNumber(request.buyAsset)!;
		const response = await this.fetcher("https://api.relay.link/quote", {
			method: "POST",
			headers: { Accept: "application/json", "Content-Type": "application/json" },
			body: JSON.stringify({
				user: request.senderAddress,
				originChainId,
				destinationChainId,
				originCurrency: evmCurrencyAddress(request.sellAsset),
				destinationCurrency: evmCurrencyAddress(request.buyAsset),
				amount,
				recipient: request.recipientAddress,
				tradeType: "EXACT_INPUT",
				appFees: [{ recipient: RELAY_APP_FEE_RECIPIENT, fee: String(RELAY_APP_FEE_BPS) }],
			}),
			signal: AbortSignal.timeout(15_000),
		});
		const raw = await response.json().catch(() => null) as any;
		if (!response.ok) throw new SwapError(`Relay quote failed (${response.status}): ${raw?.message || raw?.error || "unknown error"}`, response.status === 400 ? 422 : 502);

		const transactionItem = (raw.steps || [])
			.filter((step: any) => !["approve", "approval"].includes(String(step.id || step.kind).toLowerCase()))
			.flatMap((step: any) => step.items || [step])
			.find((item: any) => {
				const data = item.data || item;
				return typeof data.to === "string" && typeof data.data === "string";
			});
		const txData = transactionItem?.data || transactionItem;
		if (!txData?.to || !txData?.data || txData.data.length < 10) throw new SwapError("Relay returned no executable EVM transaction");

		const currencyOut = raw.details?.currencyOut;
		const outUnits = String(currencyOut?.amount || "");
		if (!/^\d+$/.test(outUnits) || BigInt(outUnits) <= 0n) throw new SwapError("Relay returned no output amount");
		const outputDecimals = Number(currencyOut?.currency?.decimals ?? buy.decimals);
		if (!Number.isInteger(outputDecimals) || outputDecimals < 0 || outputDecimals > 255) throw new SwapError("Relay returned invalid output precision");
		const minimumUnits = /^\d+$/.test(String(currencyOut?.minimumAmount || ""))
			? String(currencyOut.minimumAmount)
			: (BigInt(outUnits) * BigInt(Math.floor((100 - Number(request.slippage ?? 3)) * 100)) / 10_000n).toString();
		const totalImpactPercent = Math.abs(Number(raw.details?.totalImpact?.percent));
		const normalizedRaw = {
			...raw,
			fees: {
				...(raw.fees || {}),
				total_bps: RELAY_APP_FEE_BPS,
				// Relay's gas amount is source-native base units, never destination
				// token units. The wallet reserves source gas separately.
				outbound: "0",
				affiliate: String(raw.fees?.app?.amount || "0"),
			},
			total_swap_seconds: Number(raw.details?.timeEstimate || 0),
		};

		return {
			id: crypto.randomUUID(),
			source: "relay",
			swapper: "Relay",
			amountOut: unitsToDecimal(outUnits, outputDecimals),
			amountOutMin: unitsToDecimal(minimumUnits, outputDecimals),
			buyAmount: unitsToDecimal(outUnits, outputDecimals),
			meta: { quoteMode: "RELAY_DIRECT", originChainId, destinationChainId, feeBreakdown: {
				integrator: { bps: RELAY_APP_FEE_BPS, recipient: RELAY_APP_FEE_RECIPIENT },
				sourceNetwork: { amountBaseUnits: String(raw.fees?.gas?.amount || "0"), asset: CHAINS[networkId(request.sellAsset)]?.nativeAssetCaip },
				...(Number.isFinite(totalImpactPercent) ? { priceImpactPercent: totalImpactPercent } : {}),
			} },
			txs: [{
				type: "EVM",
				chain: networkId(request.sellAsset),
				txParams: {
					to: txData.to,
					data: txData.data,
					value: String(txData.value || "0"),
					gasLimit: String(txData.gas || txData.gasLimit || ""),
					maxFeePerGas: txData.maxFeePerGas ? String(txData.maxFeePerGas) : undefined,
					maxPriorityFeePerGas: txData.maxPriorityFeePerGas ? String(txData.maxPriorityFeePerGas) : undefined,
					chainId: Number(txData.chainId || originChainId),
					recipientAddress: txData.to,
					senderAddress: request.senderAddress,
					amount: request.sellAmount,
				},
			}],
			complete: true,
			steps: 1,
			relayRequestId: raw.requestId,
			raw: normalizedRaw,
		};
	}
}

const ZEROX_NETWORKS = new Set(supportedChainsSnapshot.zeroex.map((network) => network.toLowerCase()));
const ZEROX_FEE_RECIPIENT = RELAY_APP_FEE_RECIPIENT;
const ZEROX_FEE_BPS = 30;

function zeroxTokenAddress(caip: string): string | null {
	const relayAddress = evmCurrencyAddress(caip);
	return relayAddress === "0x0000000000000000000000000000000000000000"
		? "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
		: relayAddress;
}

export class ZeroXQuoteAdapter implements QuoteAdapter {
	readonly key = "zeroex";
	constructor(private readonly apiKey: string, private readonly fetcher: typeof fetch = fetch) {}

	eligible(request: QuoteRequest): boolean {
		const sellNetwork = networkId(request.sellAsset).toLowerCase();
		return sellNetwork === networkId(request.buyAsset).toLowerCase()
			&& ZEROX_NETWORKS.has(sellNetwork)
			&& zeroxTokenAddress(request.sellAsset) !== null
			&& zeroxTokenAddress(request.buyAsset) !== null
			&& findAsset(request.sellAsset) !== undefined
			&& findAsset(request.buyAsset) !== undefined;
	}

	async quote(request: QuoteRequest): Promise<Record<string, any>> {
		if (!this.eligible(request)) throw new SwapError("0x does not support this pair", 422);
		const sell = findAsset(request.sellAsset)!;
		const buy = findAsset(request.buyAsset)!;
		const chainId = evmChainNumber(request.sellAsset)!;
		const params = new URLSearchParams({
			chainId: String(chainId),
			sellToken: zeroxTokenAddress(request.sellAsset)!,
			buyToken: zeroxTokenAddress(request.buyAsset)!,
			sellAmount: exactDecimalToUnits(request.sellAmount, sell.decimals ?? 18),
			taker: request.senderAddress,
			slippageBps: String(Math.round(Number(request.slippage ?? 3) * 100)),
			swapFeeRecipient: ZEROX_FEE_RECIPIENT,
			swapFeeBps: String(ZEROX_FEE_BPS),
			swapFeeToken: zeroxTokenAddress(request.buyAsset)!,
		});
		const response = await this.fetcher(`https://api.0x.org/swap/allowance-holder/quote?${params}`, {
			headers: { Accept: "application/json", "0x-api-key": this.apiKey, "0x-version": "v2" },
			signal: AbortSignal.timeout(15_000),
		});
		const raw = await response.json().catch(() => null) as any;
		if (!response.ok) throw new SwapError(`0x quote failed (${response.status}): ${raw?.reason || raw?.message || raw?.name || "unknown error"}`, response.status === 400 ? 422 : 502);
		if (raw.liquidityAvailable !== true) throw new SwapError("0x returned no liquidity", 422);
		if (!raw.transaction?.to || typeof raw.transaction?.data !== "string" || raw.transaction.data.length < 10) throw new SwapError("0x returned no executable transaction");
		if (!/^\d+$/.test(String(raw.buyAmount || "")) || BigInt(raw.buyAmount) <= 0n) throw new SwapError("0x returned no output amount");
		const outputDecimals = buy.decimals ?? 18;
		const minBuy = /^\d+$/.test(String(raw.minBuyAmount || "")) ? String(raw.minBuyAmount) : String(raw.buyAmount);
		const feeAmounts = [raw.fees?.integratorFee?.amount, raw.fees?.zeroExFee?.amount]
			.filter((amount): amount is string => typeof amount === "string" && /^\d+$/.test(amount))
			.reduce((sum, amount) => sum + BigInt(amount), 0n);
		const totalBps = feeAmounts > 0n ? Number((feeAmounts * 10_000n + BigInt(raw.buyAmount) - 1n) / BigInt(raw.buyAmount)) : ZEROX_FEE_BPS;
		const normalizedRaw = {
			...raw,
			fees: { ...raw.fees, total_bps: totalBps, affiliate: String(raw.fees?.integratorFee?.amount || "0"), outbound: "0" },
		};
		return {
			id: raw.zid || crypto.randomUUID(),
			source: "zeroex",
			swapper: "0x",
			amountOut: unitsToDecimal(String(raw.buyAmount), outputDecimals),
			amountOutMin: unitsToDecimal(minBuy, outputDecimals),
			buyAmount: unitsToDecimal(String(raw.buyAmount), outputDecimals),
			txs: [{ type: "EVM", chain: networkId(request.sellAsset), txParams: {
				to: raw.transaction.to,
				data: raw.transaction.data,
				value: String(raw.transaction.value || "0"),
				gasLimit: String(raw.transaction.gas || ""),
				gasPrice: raw.transaction.gasPrice ? String(raw.transaction.gasPrice) : undefined,
				chainId,
				recipientAddress: raw.transaction.to,
				senderAddress: request.senderAddress,
				amount: request.sellAmount,
			} }],
			complete: true,
			steps: 1,
			meta: { quoteMode: "ZEROX_DIRECT", zid: raw.zid },
			raw: normalizedRaw,
		};
	}
}

const SHAPESHIFT_PARTNER_CODE = "keepkey";
const SOLANA_RPC_TIMEOUT_MS = 12_000;
const MAX_SOLANA_INSTRUCTIONS = 32;
const MAX_SOLANA_KEYS_PER_INSTRUCTION = 64;
const MAX_SOLANA_LOOKUP_TABLES = 16;
const MAX_SOLANA_INSTRUCTION_DATA_BYTES = 16_384;
const MAX_SOLANA_WIRE_BYTES = 1_232;

type ShapeShiftSolanaInstruction = {
	programId: string;
	keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
	data: string;
};

function strictSolanaPublicKey(value: unknown, label: string): PublicKey {
	if (typeof value !== "string") throw new SwapError(`ShapeShift returned invalid Solana ${label}`, 422);
	try {
		const key = new PublicKey(value);
		if (key.toBase58() !== value) throw new Error("non-canonical public key");
		return key;
	} catch {
		throw new SwapError(`ShapeShift returned invalid Solana ${label}`, 422);
	}
}

function strictBase64(value: unknown, label: string): Buffer {
	if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
		throw new SwapError(`ShapeShift returned invalid base64 ${label}`, 422);
	}
	const decoded = Buffer.from(value, "base64");
	if (decoded.toString("base64") !== value) throw new SwapError(`ShapeShift returned non-canonical base64 ${label}`, 422);
	return decoded;
}

async function assembleShapeShiftSolanaTransaction(
	tx: any,
	request: QuoteRequest,
	fetcher: typeof fetch,
	nownodesApiKey?: string,
): Promise<string> {
	if (!nownodesApiKey) throw new SwapError("Solana transaction assembly requires NOWNODES_API_KEY", 503);
	if (!Array.isArray(tx.instructions) || tx.instructions.length === 0 || tx.instructions.length > MAX_SOLANA_INSTRUCTIONS) {
		throw new SwapError(`ShapeShift returned an invalid Solana instruction count (maximum ${MAX_SOLANA_INSTRUCTIONS})`, 422);
	}
	if (!Array.isArray(tx.addressLookupTableAddresses) || tx.addressLookupTableAddresses.length > MAX_SOLANA_LOOKUP_TABLES) {
		throw new SwapError(`ShapeShift returned an invalid Solana lookup-table count (maximum ${MAX_SOLANA_LOOKUP_TABLES})`, 422);
	}

	const payer = strictSolanaPublicKey(request.senderAddress, "sender address");
	let totalInstructionDataBytes = 0;
	const instructions = tx.instructions.map((raw: ShapeShiftSolanaInstruction, instructionIndex: number) => {
		if (!raw || typeof raw !== "object" || !Array.isArray(raw.keys) || raw.keys.length > MAX_SOLANA_KEYS_PER_INSTRUCTION) {
			throw new SwapError(`ShapeShift returned invalid Solana instruction ${instructionIndex}`, 422);
		}
		const data = strictBase64(raw.data, `instruction ${instructionIndex} data`);
		totalInstructionDataBytes += data.length;
		if (totalInstructionDataBytes > MAX_SOLANA_INSTRUCTION_DATA_BYTES) {
			throw new SwapError("ShapeShift Solana instruction data is too large", 422);
		}
		const keys = raw.keys.map((rawKey, keyIndex) => {
			if (typeof rawKey?.isSigner !== "boolean" || typeof rawKey?.isWritable !== "boolean") {
				throw new SwapError(`ShapeShift returned invalid Solana account flags at instruction ${instructionIndex}, key ${keyIndex}`, 422);
			}
			const pubkey = strictSolanaPublicKey(rawKey.pubkey, `account at instruction ${instructionIndex}, key ${keyIndex}`);
			if (rawKey.isSigner && !pubkey.equals(payer)) {
				throw new SwapError(`ShapeShift Solana route requires unsupported additional signer ${pubkey.toBase58()}`, 422);
			}
			return { pubkey, isSigner: rawKey.isSigner, isWritable: rawKey.isWritable };
		});
		return new TransactionInstruction({
			programId: strictSolanaPublicKey(raw.programId, `program ID at instruction ${instructionIndex}`),
			keys,
			data,
		});
	});

	const lookupTableKeys: PublicKey[] = tx.addressLookupTableAddresses.map((value: unknown, index: number) => strictSolanaPublicKey(value, `lookup-table address ${index}`));
	if (new Set(lookupTableKeys.map((key) => key.toBase58())).size !== lookupTableKeys.length) {
		throw new SwapError("ShapeShift returned duplicate Solana lookup-table addresses", 422);
	}

	const latestId = 1;
	const lookupId = 2;
	const payload: Record<string, unknown>[] = [
		{ jsonrpc: "2.0", id: latestId, method: "getLatestBlockhash", params: [{ commitment: "confirmed" }] },
	];
	if (lookupTableKeys.length > 0) {
		payload.push({
			jsonrpc: "2.0",
			id: lookupId,
			method: "getMultipleAccounts",
			params: [lookupTableKeys.map((key) => key.toBase58()), { encoding: "base64", commitment: "confirmed" }],
		});
	}

	let response: Response;
	try {
		response = await fetcher(`https://sol.nownodes.io/${encodeURIComponent(nownodesApiKey)}`, {
			method: "POST",
			headers: { Accept: "application/json", "Content-Type": "application/json", "api-key": nownodesApiKey },
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(SOLANA_RPC_TIMEOUT_MS),
		});
	} catch (error) {
		throw new SwapError(`Solana transaction assembly RPC failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!response.ok) throw new SwapError(`Solana transaction assembly RPC failed (${response.status})`);
	const body = await response.json().catch(() => null) as any;
	const responses = Array.isArray(body) ? body : [body];
	const latestResponse = responses.find((entry: any) => entry?.id === latestId);
	if (latestResponse?.error) throw new SwapError(`Solana getLatestBlockhash failed: ${latestResponse.error.message || "unknown error"}`);
	const blockhash = latestResponse?.result?.value?.blockhash;
	if (typeof blockhash !== "string") throw new SwapError("Solana RPC returned an invalid latest blockhash");
	strictSolanaPublicKey(blockhash, "latest blockhash");

	const lookupTableAccounts: AddressLookupTableAccount[] = [];
	if (lookupTableKeys.length > 0) {
		const lookupResponse = responses.find((entry: any) => entry?.id === lookupId);
		if (lookupResponse?.error) throw new SwapError(`Solana getMultipleAccounts failed: ${lookupResponse.error.message || "unknown error"}`);
		const values = lookupResponse?.result?.value;
		if (!Array.isArray(values) || values.length !== lookupTableKeys.length) throw new SwapError("Solana RPC returned incomplete lookup-table accounts");
		for (let index = 0; index < values.length; index++) {
			const account = values[index];
			if (!account || account.owner !== AddressLookupTableProgram.programId.toBase58() || account.executable !== false || !Array.isArray(account.data) || account.data[1] !== "base64") {
				throw new SwapError(`Solana RPC returned invalid lookup-table account ${lookupTableKeys[index].toBase58()}`);
			}
			try {
				lookupTableAccounts.push(new AddressLookupTableAccount({
					key: lookupTableKeys[index],
					state: AddressLookupTableAccount.deserialize(strictBase64(account.data[0], `lookup-table ${index} data`)),
				}));
			} catch (error) {
				if (error instanceof SwapError) throw error;
				throw new SwapError(`Solana RPC returned undecodable lookup-table account ${lookupTableKeys[index].toBase58()}`);
			}
		}
	}

	let serialized: Uint8Array;
	try {
		const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions })
			.compileToV0Message(lookupTableAccounts);
		const transaction = new VersionedTransaction(message);
		serialized = transaction.serialize();
	} catch (error) {
		throw new SwapError(`ShapeShift Solana transaction could not be assembled: ${error instanceof Error ? error.message : String(error)}`, 422);
	}
	if (serialized.length > MAX_SOLANA_WIRE_BYTES) throw new SwapError(`ShapeShift Solana transaction exceeds ${MAX_SOLANA_WIRE_BYTES}-byte protocol limit`, 422);
	return Buffer.from(serialized).toString("base64");
}

export class ShapeShiftQuoteAdapter implements QuoteAdapter {
	readonly key = "shapeshift";
	readonly tier = 1;
	constructor(private readonly fetcher: typeof fetch = fetch, private readonly nownodesApiKey?: string) {}

	eligible(request: QuoteRequest): boolean {
		return findAsset(request.sellAsset) !== undefined
			&& findAsset(request.buyAsset) !== undefined;
	}

	async quote(request: QuoteRequest): Promise<Record<string, any>> {
		if (!this.eligible(request)) throw new SwapError("ShapeShift fallback does not support this pair", 422);
		const sell = findAsset(request.sellAsset)!;
		const buy = findAsset(request.buyAsset)!;
		const sellAmount = exactDecimalToUnits(request.sellAmount, sell.decimals ?? 18);
		const headers = { Accept: "application/json", "Content-Type": "application/json", "X-Partner-Code": SHAPESHIFT_PARTNER_CODE };
		const rateParams = new URLSearchParams({ sellAssetId: request.sellAsset, buyAssetId: request.buyAsset, sellAmountCryptoBaseUnit: sellAmount });
		const ratesResponse = await this.fetcher(`https://api.shapeshift.com/v1/swap/rates?${rateParams}`, { headers, signal: AbortSignal.timeout(15_000) });
		const ratesBody = await ratesResponse.json().catch(() => null) as any;
		if (!ratesResponse.ok) throw new SwapError(`ShapeShift rates failed (${ratesResponse.status})`);
		const rates = (Array.isArray(ratesBody) ? ratesBody : ratesBody?.rates || [])
			.filter((rate: any) => /^\d+$/.test(String(rate.buyAmountCryptoBaseUnit || "")) && BigInt(rate.buyAmountCryptoBaseUnit) > 0n && !rate.error)
			.sort((left: any, right: any) => BigInt(left.buyAmountCryptoBaseUnit) > BigInt(right.buyAmountCryptoBaseUnit) ? -1 : 1);
		if (rates.length === 0) throw new SwapError("ShapeShift returned no fallback route", 422);

		const failures: string[] = [];
		for (const rate of rates.slice(0, 4)) {
			const quoteResponse = await this.fetcher("https://api.shapeshift.com/v1/swap/quote", {
				method: "POST",
				headers,
				body: JSON.stringify({
					sellAssetId: request.sellAsset,
					buyAssetId: request.buyAsset,
					sellAmountCryptoBaseUnit: sellAmount,
					swapperName: rate.swapperName,
					sendAddress: request.senderAddress,
					receiveAddress: request.recipientAddress,
					slippageTolerancePercentageDecimal: (Number(request.slippage ?? 3) / 100).toString(),
				}),
				signal: AbortSignal.timeout(15_000),
			});
			const raw = await quoteResponse.json().catch(() => null) as any;
			if (!quoteResponse.ok) {
				failures.push(`${rate.swapperName}: HTTP ${quoteResponse.status}`);
				continue;
			}
			try {
				return await normalizeShapeShiftQuote(raw, rate, request, buy, this.fetcher, this.nownodesApiKey);
			} catch (error) {
				failures.push(`${rate.swapperName}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		throw new SwapError(`ShapeShift returned no executable fee-attributed route: ${failures.join(" | ")}`, 422);
	}
}

async function normalizeShapeShiftQuote(raw: any, rate: any, request: QuoteRequest, buy: AssetRecord, fetcher: typeof fetch, nownodesApiKey?: string): Promise<Record<string, any>> {
	const partnerBps = Number(raw.partnerBps ?? rate.partnerBps ?? 0);
	const affiliateBps = Number(raw.affiliateBps ?? rate.affiliateBps ?? 0);
	const shapeshiftBps = Number(raw.shapeshiftBps ?? rate.shapeshiftBps ?? affiliateBps - partnerBps);
	if (!Number.isInteger(partnerBps) || partnerBps <= 0 || !Number.isInteger(affiliateBps) || affiliateBps > 10_000 || affiliateBps < partnerBps || !Number.isInteger(shapeshiftBps) || shapeshiftBps < 0 || partnerBps + shapeshiftBps !== affiliateBps) {
		throw new SwapError("ShapeShift partner fee attribution is missing", 422);
	}
	const step = (raw.steps || []).find((candidate: any) => candidate?.transactionData);
	const tx = step?.transactionData;
	if (!tx || typeof tx !== "object") throw new SwapError("ShapeShift returned no source-chain transaction");
	const txType = String(tx.type || (tx.to && typeof tx.data === "string" ? "evm" : ""));
	const depositAddress = typeof raw.depositAddress === "string" && raw.depositAddress ? raw.depositAddress : undefined;
	let type: string;
	let txParams: Record<string, unknown>;
	if (txType === "evm") {
		if (!tx.to || typeof tx.data !== "string") throw new SwapError("ShapeShift returned malformed EVM transaction");
		if (tx.signatureRequired) throw new SwapError("ShapeShift route requires an unsupported Permit2 signature");
		type = "EVM";
		txParams = {
			to: tx.to, data: tx.data, value: String(tx.value || "0"),
			gasLimit: tx.gasLimit || tx.gas ? String(tx.gasLimit || tx.gas) : undefined,
			gasPrice: tx.gasPrice ? String(tx.gasPrice) : undefined,
			maxFeePerGas: tx.maxFeePerGas ? String(tx.maxFeePerGas) : undefined,
			maxPriorityFeePerGas: tx.maxPriorityFeePerGas ? String(tx.maxPriorityFeePerGas) : undefined,
			chainId: Number(tx.chainId || evmChainNumber(request.sellAsset)), recipientAddress: tx.to,
			vaultAddress: tx.to, senderAddress: request.senderAddress, amount: request.sellAmount,
		};
	} else if (txType === "utxo") {
		if (!tx.to || !/^\d+$/.test(String(tx.value || ""))) throw new SwapError("ShapeShift returned malformed UTXO deposit");
		type = "transfer";
		txParams = { to: tx.to, recipientAddress: tx.to, vaultAddress: tx.to, value: String(tx.value), amount: request.sellAmount, memo: String(tx.opReturnData || ""), senderAddress: request.senderAddress };
	} else if (txType === "cosmossdk_msg_send") {
		if (!tx.to || !tx.denom || !/^\d+$/.test(String(tx.value || ""))) throw new SwapError("ShapeShift returned malformed Cosmos send");
		type = "transfer";
		txParams = { to: tx.to, recipientAddress: tx.to, vaultAddress: tx.to, denom: tx.denom, value: String(tx.value), amount: request.sellAmount, memo: String(tx.memo || ""), senderAddress: request.senderAddress };
	} else if (txType === "cosmossdk_msg_deposit") {
		if (!tx.coin || !/^\d+$/.test(String(tx.value || "")) || !tx.memo) throw new SwapError("ShapeShift returned malformed Cosmos deposit");
		type = "deposit";
		txParams = { coin: tx.coin, value: String(tx.value), amount: request.sellAmount, memo: String(tx.memo), senderAddress: request.senderAddress };
	} else if (txType === "solana_instructions") {
		type = "SOLANA";
		txParams = {
			serializedTx: await assembleShapeShiftSolanaTransaction(tx, request, fetcher, nownodesApiKey),
			// Deposit-channel swappers (NEAR Intents) pay a top-level depositAddress;
			// Vault reads recipientAddress as the address this transaction pays.
			recipientAddress: depositAddress || request.recipientAddress,
			senderAddress: request.senderAddress,
			amount: request.sellAmount,
		};
	} else {
		throw new SwapError(`ShapeShift transaction type ${txType || "unknown"} is not safely signable by Vault`);
	}

	const outUnits = String(raw.buyAmountAfterFeesCryptoBaseUnit || rate.buyAmountCryptoBaseUnit || "");
	if (!/^\d+$/.test(outUnits) || BigInt(outUnits) <= 0n) throw new SwapError("ShapeShift fallback returned no output amount");
	const outputDecimals = buy.decimals ?? step?.buyAsset?.precision ?? 18;
	const minimum = (BigInt(outUnits) * BigInt(Math.floor((100 - Number(request.slippage ?? 3)) * 100)) / 10_000n).toString();
	const normalizedRaw = {
		...raw,
		fees: { total_bps: affiliateBps, affiliate: "0", outbound: "0" },
		total_swap_seconds: Math.ceil(Number(step?.estimatedExecutionTimeMs || rate.estimatedExecutionTimeMs || 0) / 1000),
	};
	const swapper = raw.swapperName || rate.swapperName;
	const inboundAddress = String((depositAddress || txParams.to || txParams.vaultAddress || ""));
	return {
		id: raw.quoteId || crypto.randomUUID(), quoteId: raw.quoteId, source: "shapeshift", swapper,
		amountOut: unitsToDecimal(outUnits, outputDecimals), amountOutMin: unitsToDecimal(minimum, outputDecimals), buyAmount: unitsToDecimal(outUnits, outputDecimals),
		inbound_address: inboundAddress || undefined, expiry: raw.expiresAt ? Math.floor(Number(raw.expiresAt) / 1000) : undefined,
		txs: [{ type, chain: networkId(request.sellAsset), txParams }], complete: true, steps: 1,
		meta: { quoteMode: "SHAPESHIFT_FALLBACK", quoteId: raw.quoteId, swapper, ...(depositAddress ? { depositAddress } : {}), feeBreakdown: {
			partner: { code: SHAPESHIFT_PARTNER_CODE, bps: partnerBps },
			shapeshift: { bps: shapeshiftBps },
			affiliateTotal: { bps: affiliateBps },
			// Provider-reported network fee remains explicit, in its original units;
			// never format it as the destination token's amount.
			providerNetwork: { amountBaseUnits: String(raw.networkFeeCryptoBaseUnit || rate.networkFeeCryptoBaseUnit || "0") },
		} }, raw: normalizedRaw,
	};
}

function swapKitAsset(caip: string): string | null {
	const pinned = SWAP_ASSETS.get(caip.toLowerCase());
	if (pinned) return pinned.asset;
	const asset = findAsset(caip);
	const network = networkId(caip);
	const native = swapAssetsSnapshot.data.assets.find((candidate) => candidate.networkId.toLowerCase() === network.toLowerCase() && candidate.isNative);
	if (!asset || !native) return null;
	const prefix = native.asset.split(".")[0];
	const assetPart = caip.slice(caip.indexOf("/") + 1);
	if (assetPart.startsWith("slip44:")) return native.asset;
	const separator = assetPart.indexOf(":");
	return separator >= 0 ? `${prefix}.${asset.symbol.toUpperCase()}-${assetPart.slice(separator + 1).toUpperCase()}` : null;
}

export class SwapKitQuoteAdapter implements QuoteAdapter {
	readonly key = "swapkit";
	readonly tier = 2;
	constructor(private readonly apiKey: string, private readonly fetcher: typeof fetch = fetch) {}

	eligible(request: QuoteRequest): boolean {
		return evmChainNumber(request.sellAsset) !== null
			&& swapKitAsset(request.sellAsset) !== null
			&& swapKitAsset(request.buyAsset) !== null;
	}

	async quote(request: QuoteRequest): Promise<Record<string, any>> {
		if (!this.eligible(request)) throw new SwapError("SwapKit fallback does not support this pair", 422);
		const headers = { Accept: "application/json", "Content-Type": "application/json", "x-api-key": this.apiKey };
		const quoteResponse = await this.fetcher("https://api.swapkit.dev/v3/quote", {
			method: "POST",
			headers,
			body: JSON.stringify({
				sellAsset: swapKitAsset(request.sellAsset),
				sellAmount: request.sellAmount,
				buyAsset: swapKitAsset(request.buyAsset),
				sourceAddress: request.senderAddress,
				destinationAddress: request.recipientAddress,
				slippage: Number(request.slippage ?? 3),
				disableEstimate: false,
				gasCheck: false,
			}),
			signal: AbortSignal.timeout(20_000),
		});
		const quoteBody = await quoteResponse.json().catch(() => null) as any;
		if (!quoteResponse.ok) throw new SwapError(`SwapKit quote failed (${quoteResponse.status}): ${quoteBody?.message || quoteBody?.error || "unknown error"}`);
		const routes = (quoteBody?.routes || []).filter((route: any) => {
			const attributed = (route.fees || []).some((fee: any) => fee.type === "affiliate" && Number(fee.amountBps) > 0);
			return attributed && route.routeId;
		}).sort((left: any, right: any) => Number(right.expectedBuyAmount || 0) - Number(left.expectedBuyAmount || 0));
		if (routes.length === 0) throw new SwapError("SwapKit returned no fee-attributed executable route", 422);
		const route = routes[0];
		const swapResponse = await this.fetcher("https://api.swapkit.dev/v3/swap", {
			method: "POST",
			headers,
			body: JSON.stringify({ routeId: route.routeId, sourceAddress: request.senderAddress, destinationAddress: request.recipientAddress }),
			signal: AbortSignal.timeout(20_000),
		});
		const raw = await swapResponse.json().catch(() => null) as any;
		if (!swapResponse.ok) throw new SwapError(`SwapKit executable route failed (${swapResponse.status}): ${raw?.message || raw?.error || "unknown error"}`);
		const txType = String(raw.txType || raw.meta?.txType || (raw.tx?.to && typeof raw.tx?.data === "string" ? "EVM" : "")).toUpperCase();
		if (txType !== "EVM" || !raw.tx?.to || typeof raw.tx?.data !== "string" || raw.tx.data.length < 10) throw new SwapError("SwapKit returned no executable EVM transaction");
		const amountOut = String(raw.expectedBuyAmount || route.expectedBuyAmount || "");
		const amountOutMin = String(raw.expectedBuyAmountMaxSlippage || route.expectedBuyAmountMaxSlippage || "");
		if (!/^\d+(?:\.\d+)?$/.test(amountOut) || Number(amountOut) <= 0 || !/^\d+(?:\.\d+)?$/.test(amountOutMin)) throw new SwapError("SwapKit returned invalid output amounts");
		const appliedFees = raw.fees || route.fees || [];
		const feeBps = appliedFees.reduce((sum: number, fee: any) => sum + (Number(fee.amountBps) || 0), 0);
		const affiliateFee = appliedFees.find((fee: any) => fee.type === "affiliate" && Number(fee.amountBps) > 0);
		if (!affiliateFee) throw new SwapError("SwapKit executable route lost affiliate fee attribution", 422);
		return {
			id: raw.swapId || route.routeId,
			source: "swapkit",
			swapper: (raw.providers || route.providers || []).join("+") || "SwapKit",
			amountOut,
			amountOutMin,
			buyAmount: amountOut,
			txs: [{ type: "EVM", chain: networkId(request.sellAsset), txParams: {
				to: raw.tx.to,
				data: raw.tx.data,
				value: String(raw.tx.value || "0"),
				gasLimit: String(raw.tx.gas || raw.tx.gasLimit || ""),
				gasPrice: raw.tx.gasPrice ? String(raw.tx.gasPrice) : undefined,
				chainId: evmChainNumber(request.sellAsset),
				recipientAddress: raw.tx.to,
				senderAddress: request.senderAddress,
				amount: request.sellAmount,
			} }],
			complete: true,
			steps: 1,
			meta: { quoteMode: "SWAPKIT_GATED_FALLBACK", quoteId: quoteBody.quoteId, routeId: route.routeId, providers: raw.providers || route.providers },
			raw: { ...raw, fees: { items: appliedFees, total_bps: feeBps, affiliate: String(affiliateFee.amount || "0"), outbound: "0" }, total_swap_seconds: Number(raw.estimatedTime?.total || route.estimatedTime?.total || 0) },
		};
	}
}

export class ProtocolQuoteAdapter implements QuoteAdapter {
	readonly key: ProviderKey;
	private readonly fetcher: typeof fetch;

	constructor(provider: ProviderKey, fetcher: typeof fetch = fetch) {
		this.key = provider;
		this.fetcher = fetcher;
	}

	eligible(request: QuoteRequest): boolean {
		return protocolAsset(request.sellAsset, this.key) !== null && protocolAsset(request.buyAsset, this.key) !== null;
	}

	async quote(request: QuoteRequest): Promise<Record<string, any>> {
		const sell = protocolAsset(request.sellAsset, this.key);
		const buy = protocolAsset(request.buyAsset, this.key);
		if (!sell || !buy) throw new SwapError(`${this.key} does not support this pair`, 422);
		const config = PROTOCOLS[this.key];
		const sellUnits = exactDecimalToUnits(request.sellAmount, protocolDecimals(this.key, sell));
		const query = new URLSearchParams({
			from_asset: sell,
			to_asset: buy,
			amount: sellUnits,
			destination: request.recipientAddress,
			affiliate: config.affiliate,
			affiliate_bps: String(config.affiliateBps),
		});
		const raw = await this.fetchWithFailover(`${config.path}?${query}`);
		if (typeof raw?.error === "string") throw new SwapError(`${config.label}: ${raw.error}`, 422);
		if (!/^\d+$/.test(String(raw?.expected_amount_out || "")) || BigInt(raw.expected_amount_out) <= 0n) {
			throw new SwapError(`${config.label} returned no output amount`);
		}

		const expected = BigInt(raw.expected_amount_out);
		const slippage = Math.min(50, Math.max(0.1, Number(request.slippage ?? 3)));
		const requestedMinimum = expected * BigInt(Math.floor((100 - slippage) * 100)) / 10_000n;
		const nodeMinimum = /^\d+$/.test(String(raw.amount_out_min || "")) ? BigInt(raw.amount_out_min) : 0n;
		const minimum = nodeMinimum > requestedMinimum ? nodeMinimum : requestedMinimum;
		if (minimum <= 0n) throw new SwapError(`${config.label} produced an unsafe zero swap limit`);

		let memo = buildMemo(buy, request.recipientAddress, minimum, config.affiliate, config.affiliateBps);
		if (networkId(request.sellAsset).startsWith("bip122:") && new TextEncoder().encode(memo).length > 80) {
			memo = buildMemo(memoAssetFromNode(raw.memo, buy), request.recipientAddress, minimum, config.affiliate, config.affiliateBps);
		}
		if (networkId(request.sellAsset).startsWith("bip122:") && new TextEncoder().encode(memo).length > 80) {
			throw new SwapError(`${config.label} memo exceeds the source chain's 80-byte limit`, 422);
		}

		const type = transactionType(request.sellAsset);
		const recipient = type === "EVM" ? (raw.router || raw.inbound_address) : raw.inbound_address;
		const txParams: Record<string, unknown> = {
			senderAddress: request.senderAddress,
			recipientAddress: recipient,
			amount: request.sellAmount,
			memo,
		};
		if (type === "EVM") {
			txParams.vaultAddress = raw.inbound_address;
			txParams.isThorchainSwap = this.key === "thorchain";
		}

		const outputDecimals = protocolDecimals(this.key, buy);
		return {
			id: crypto.randomUUID(),
			source: config.label,
			amountOut: unitsToDecimal(expected.toString(), outputDecimals),
			amountOutMin: unitsToDecimal(minimum.toString(), outputDecimals),
			buyAmount: unitsToDecimal(expected.toString(), outputDecimals),
			inbound_address: raw.inbound_address,
			router: raw.router,
			txs: [{ type, chain: networkId(request.sellAsset), txParams }],
			meta: { quoteMode: `${config.label.toUpperCase()}_DIRECT` },
			steps: 1,
			complete: true,
			raw,
		};
	}

	private async fetchWithFailover(path: string): Promise<any> {
		let lastError: Error | undefined;
		for (const host of PROTOCOLS[this.key].hosts) {
			try {
				const response = await this.fetcher(`${host}${path}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
				const body = await response.json().catch(() => null) as any;
				if (response.ok) return body;
				lastError = new Error(`${host} returned ${response.status}: ${body?.error || body?.message || "quote failed"}`);
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
			}
		}
		throw new SwapError(`${this.key} quote hosts failed: ${lastError?.message || "unknown error"}`);
	}
}

export class QuoteRouter {
	private readonly inFlight = new Map<string, Promise<any[]>>();
	private readonly observations = new Map<string, SwapHealthObservation>();

	constructor(private readonly adapters: readonly QuoteAdapter[], private readonly options: {
		validateQuote?: (request: QuoteRequest, quote: Record<string, any>) => Promise<Record<string, any>>;
		now?: () => number;
	} = {}) {}

	providerHealth(): SwapHealthObservation[] { return [...this.observations.values()]; }

	async quote(request: QuoteRequest): Promise<any[]> {
		validateQuoteRequest(request);
		const eligible = this.adapters.filter((adapter) => adapter.eligible(request));
		if (eligible.length === 0) throw new SwapError("No swap provider supports this pair", 422);
		const key = JSON.stringify(request);
		const existing = this.inFlight.get(key);
		if (existing) return existing;
		const running = this.run(eligible, request).finally(() => this.inFlight.delete(key));
		this.inFlight.set(key, running);
		return running;
	}

	private async run(adapters: readonly QuoteAdapter[], request: QuoteRequest): Promise<any[]> {
		const invocationId = crypto.randomUUID();
		const reasons: string[] = [];
		const attempts: Array<{ provider: string; status: "ok" | "unavailable"; reason?: string; checkedAt: number }> = [];
		const tiers = [...new Set(adapters.map((adapter) => adapter.tier || 0))].sort((left, right) => left - right);
		for (const tier of tiers) {
			const tierAdapters = adapters.filter((adapter) => (adapter.tier || 0) === tier);
			const settled = await Promise.allSettled(tierAdapters.map(async (adapter) => {
				try {
					let quote = await adapter.quote(request);
					if (this.options.validateQuote) quote = await this.options.validateQuote(request, quote);
					const checkedAt = (this.options.now || Date.now)();
					attempts.push({ provider: adapter.key, status: "ok", checkedAt });
					this.observations.set(adapter.key, { key: adapter.key, status: "ok", checkedAt, detail: "Last demand-driven quote check succeeded. Availability depends on the pair and amount." });
					if (String(quote.swapper).toLowerCase() === "chainflip") this.observations.set("chainflip", {
						key: "chainflip", status: "ok", checkedAt, detail: "Last Chainflip quote succeeded through ShapeShift; direct KeepKey broker routing is not configured.",
					});
					return { integration: adapter.key, quote, invocationId };
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					const checkedAt = (this.options.now || Date.now)();
					attempts.push({ provider: adapter.key, status: "unavailable", reason, checkedAt });
					// A failed pair/amount is not proof of an outage at the provider.
					this.observations.set(adapter.key, { key: adapter.key, status: "degraded", checkedAt, detail: "Last quote request was unavailable for its pair and amount. Request a quote for current availability and route-specific details." });
					throw error;
				}
			}));
			const quotes = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
			reasons.push(...settled.flatMap((result) => result.status === "rejected" ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : []));
			if (quotes.length > 0) {
				quotes.sort((left, right) => Number(right.quote.amountOut) - Number(left.quote.amountOut));
				return quotes.map((entry) => ({ ...entry, quote: {
					...entry.quote, invocationId,
					meta: { ...entry.quote.meta, routeDiagnostics: { selectedTier: tier, fallback: tier > 0, attempts: [...attempts] } },
				} }));
			}
		}
		throw new SwapError(`Swap unavailable: ${reasons.join(" | ")}`, 503);
	}
}

function validateQuoteRequest(request: QuoteRequest): void {
	for (const field of ["sellAsset", "buyAsset", "sellAmount", "recipientAddress", "senderAddress"] as const) {
		if (typeof request[field] !== "string" || !request[field].trim()) throw new SwapError(`${field} is required`, 400);
	}
	for (const [field, address] of [["recipientAddress", request.recipientAddress], ["senderAddress", request.senderAddress]] as const) {
		if (/[:/&#?\s]/.test(address)) throw new SwapError(`${field} contains a forbidden delimiter`, 400);
	}
	exactDecimalToUnits(request.sellAmount, 18);
	if (Number(request.sellAmount) > 1_000_000_000) throw new SwapError("sellAmount is unreasonably large", 400);
	if (request.slippage !== undefined && (!Number.isFinite(request.slippage) || request.slippage <= 0 || request.slippage > 50)) {
		throw new SwapError("slippage must be greater than 0 and at most 50 percent", 400);
	}
}

export function createQuoteRouter(options: { fetch?: typeof fetch; zeroxApiKey?: string; swapkitApiKey?: string; nownodesApiKey?: string; evm?: Pick<EvmClient, "readRpc"> } = {}): QuoteRouter {
	const fetcher = options.fetch || fetch;
	const adapters: QuoteAdapter[] = [
		new ProtocolQuoteAdapter("thorchain", fetcher),
		new ProtocolQuoteAdapter("mayachain", fetcher),
		new RelayQuoteAdapter(fetcher),
		new ShapeShiftQuoteAdapter(fetcher, options.nownodesApiKey),
	];
	if (options.zeroxApiKey) adapters.push(new ZeroXQuoteAdapter(options.zeroxApiKey, fetcher));
	if (options.swapkitApiKey) adapters.push(new SwapKitQuoteAdapter(options.swapkitApiKey, fetcher));
	return new QuoteRouter(adapters, options.evm ? { validateQuote: (request, quote) => validateNativeEvmQuote(options.evm!, request, quote) } : {});
}

/** Check native-input contract routes before offering them; ERC-20 routes may
 * still require an approval, so their final execution check belongs after it. */
export async function validateNativeEvmQuote(evm: Pick<EvmClient, "readRpc">, request: QuoteRequest, quote: Record<string, any>): Promise<Record<string, any>> {
	if (!/^eip155:\d+\/slip44:\d+$/.test(request.sellAsset)) return quote;
	const tx = quote.txs?.[0]?.txParams;
	if (!tx?.to || typeof tx.data !== "string" || tx.data.length < 10) return quote;
	const network = networkId(request.sellAsset);
	let estimate: unknown;
	try {
		estimate = (await evm.readRpc(network, "eth_estimateGas", [{ from: request.senderAddress, to: tx.to, data: tx.data, value: `0x${BigInt(tx.value || "0").toString(16)}` }, "pending"])).data;
	} catch (error) {
		throw new SwapError(`Source-chain execution check failed: ${error instanceof Error ? error.message : String(error)}`, 422);
	}
	if (typeof estimate !== "string" || !/^0x[0-9a-f]+$/i.test(estimate) || BigInt(estimate) <= 0n) throw new SwapError("Source-chain gas estimation returned no valid limit", 422);
	const quoted = /^(?:\d+|0x[0-9a-f]+)$/i.test(String(tx.gasLimit || "")) ? BigInt(tx.gasLimit) : 0n;
	const gas = BigInt(estimate) > quoted ? BigInt(estimate) : quoted;
	return { ...quote, txs: [{ ...quote.txs[0], txParams: { ...tx, gasLimit: gas.toString() } }, ...quote.txs.slice(1)], meta: {
		...quote.meta, executionCheck: { status: "estimated", checkedAt: Date.now(), gasEstimate: BigInt(estimate).toString(), quotedGasLimit: quoted.toString() },
	} };
}

export function createProtocolQuoteRouter(fetcher: typeof fetch = fetch): QuoteRouter {
	return createQuoteRouter({ fetch: fetcher });
}
