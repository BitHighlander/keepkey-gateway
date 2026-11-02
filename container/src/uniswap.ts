import { AbiCoder, Interface, formatUnits, parseUnits, solidityPacked } from "ethers";
import type { EvmClient } from "./evm";
import type { QuoteAdapter, QuoteRequest } from "./swap";

// Deliberately narrow: native ETH input needs neither Permit2 nor an approval.
// UR 1.2's v3 commands have an existing certified decoder on firmware 7.16.
export const UNISWAP_ROUTER = "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad";
export const UNISWAP_QUOTER = "0x61ffe014ba17989e743c5f6cb21bf9697530b21e";
export const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
export const UNISWAP_OUTPUTS = new Set([
	"0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
	"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
]);
const FEE_RECIPIENT = "0x87ab2637bc4231604ad708c5e8aac92a260c7704";
const FEE_BPS = 30n;
const THIS = "0x0000000000000000000000000000000000000002";
const abi = AbiCoder.defaultAbiCoder();
const quoter = new Interface(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)"]);
export const UNISWAP_EXECUTE = new Interface(["function execute(bytes commands,bytes[] inputs,uint256 deadline) payable"]);

export class UniswapQuoteAdapter implements QuoteAdapter {
	readonly key = "uniswap";
	constructor(private readonly evm: Pick<EvmClient, "readRpc">, private readonly now = Date.now) {}
	eligible(request: QuoteRequest): boolean {
		return request.sellAsset.toLowerCase() === "eip155:1/slip44:60"
			&& request.buyAsset.toLowerCase().startsWith("eip155:1/erc20:")
			&& UNISWAP_OUTPUTS.has(request.buyAsset.toLowerCase().split("erc20:")[1]);
	}
	async quote(request: QuoteRequest): Promise<Record<string, any>> {
		if (!this.eligible(request)) throw new Error("Direct Uniswap supports Ethereum ETH to USDT/USDC only");
		const amount = parseUnits(request.sellAmount, 18);
		const token = request.buyAsset.toLowerCase().split("erc20:")[1];
		// Compare the two liquid single-hop pools; no arbitrary paths or hooks.
		const pools = await Promise.allSettled([500, 3000].map(async fee => {
			const call = quoter.encodeFunctionData("quoteExactInputSingle", [[WETH, token, amount, fee, 0]]);
			const { data } = await this.evm.readRpc("eip155:1", "eth_call", [{ to: UNISWAP_QUOTER, data: call }, "pending"]);
			const [out] = quoter.decodeFunctionResult("quoteExactInputSingle", String(data));
			if (out <= 0n) throw new Error("Uniswap pool has no output");
			return { fee, out: BigInt(out) };
		}));
		const available = pools.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
		available.sort((a, b) => a.out > b.out ? -1 : a.out < b.out ? 1 : 0);
		if (!available.length) throw new Error("No direct Uniswap pool quote available");
		const best = available[0];
		const slippage = BigInt(Math.round(Number(request.slippage ?? 3) * 100));
		if (slippage <= 0n || slippage > 5000n) throw new Error("Invalid Uniswap slippage");
		const net = (gross: bigint) => gross - gross * FEE_BPS / 10_000n;
		const grossMinimum = best.out * (10_000n - slippage) / 10_000n;
		const minimum = net(grossMinimum);
		if (minimum <= 0n) throw new Error("Uniswap output is below one token unit");
		const expiry = Math.floor(this.now() / 1000) + 180;
		const path = solidityPacked(["address", "uint24", "address"], [WETH, best.fee, token]);
		const data = UNISWAP_EXECUTE.encodeFunctionData("execute", ["0x0b000604", [
			abi.encode(["address", "uint256"], [THIS, amount]),
			abi.encode(["address", "uint256", "uint256", "bytes", "bool"], [THIS, amount, grossMinimum, path, false]),
			abi.encode(["address", "address", "uint256"], [token, FEE_RECIPIENT, FEE_BPS]),
			abi.encode(["address", "address", "uint256"], [token, request.recipientAddress, minimum]),
		], expiry]);
		return { id: crypto.randomUUID(), source: "uniswap", swapper: "Uniswap", expiry,
			amountOut: formatUnits(net(best.out), 6), amountOutMin: formatUnits(minimum, 6),
			meta: { quoteMode: "UNISWAP_DIRECT", poolFee: best.fee, feeBreakdown: { integrator: { bps: Number(FEE_BPS), recipient: FEE_RECIPIENT } } },
			raw: { expiry, total_swap_seconds: 15, fees: { total_bps: Number(FEE_BPS), outbound: "0", affiliate: formatUnits(best.out - net(best.out), 6) } },
			txs: [{ type: "EVM", chain: "eip155:1", txParams: { to: UNISWAP_ROUTER, data, value: amount.toString(), chainId: 1,
				gasLimit: "250000", senderAddress: request.senderAddress, recipientAddress: UNISWAP_ROUTER, amount: request.sellAmount } }], complete: true, steps: 1 };
	}
}
