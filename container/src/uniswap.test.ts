import { expect, test } from "bun:test";
import { AbiCoder, Interface } from "ethers";
import { UniswapQuoteAdapter, UNISWAP_EXECUTE, UNISWAP_ROUTER, UNISWAP_QUOTER, WETH } from "./uniswap";

const abi = AbiCoder.defaultAbiCoder();
const request = { sellAsset: "eip155:1/slip44:60", buyAsset: "eip155:1/erc20:0xdac17f958d2ee523a2206206994597c13d831ec7",
	sellAmount: "0.01", senderAddress: "0x1111111111111111111111111111111111111111", recipientAddress: "0x2222222222222222222222222222222222222222", slippage: 1 };
const quoter = new Interface(["function quoteExactInputSingle((address,address,uint256,uint24,uint160)) returns (uint256,uint160,uint32,uint256)"]);
const rpc = { readRpc: async (network: unknown, method: unknown, args: unknown) => {
	expect(network).toBe("eip155:1"); expect(method).toBe("eth_call");
	const [call, block] = args as any[];
	expect(block).toBe("pending"); expect(call.to).toBe(UNISWAP_QUOTER);
	const [params] = quoter.decodeFunctionData("quoteExactInputSingle", call.data);
	expect(String(params[0]).toLowerCase()).toBe(WETH); expect(params[2]).toBe(10000000000000000n);
	return { success: true as const, data: abi.encode(["uint256", "uint160", "uint32", "uint256"], [params[3] === 500n ? 25_000_000n : 24_000_000n, 0, 0, 100000]) };
} };

test("builds an atomic native swap with recipient, fee, deadline and net minimum enforced in calldata", async () => {
	const quote = await new UniswapQuoteAdapter(rpc, () => 1000000).quote(request);
	expect(quote.amountOut).toBe("24.925"); expect(quote.amountOutMin).toBe("24.67575");
	expect(quote.meta.feeBreakdown.integrator.bps).toBe(30);
	const tx = quote.txs[0].txParams;
	expect(tx.to).toBe(UNISWAP_ROUTER); expect(tx.value).toBe("10000000000000000");
	const [commands, inputs, deadline] = UNISWAP_EXECUTE.decodeFunctionData("execute", tx.data);
	expect(commands).toBe("0x0b000604"); expect(deadline).toBe(1180n);
	const wrap = abi.decode(["address", "uint256"], inputs[0]); expect(wrap[1]).toBe(BigInt(tx.value));
	const swap = abi.decode(["address", "uint256", "uint256", "bytes", "bool"], inputs[1]);
	expect(swap[1]).toBe(BigInt(tx.value)); expect(swap[2]).toBe(24_750_000n); expect(swap[4]).toBe(false);
	const fee = abi.decode(["address", "address", "uint256"], inputs[2]); expect(fee[2]).toBe(30n);
	const sweep = abi.decode(["address", "address", "uint256"], inputs[3]);
	expect(sweep[1]).toBe(request.recipientAddress); expect(sweep[2]).toBe(24_675_750n);
});

test("limits eligibility to native ETH and supported stablecoins on Ethereum", () => {
	const adapter = new UniswapQuoteAdapter(rpc);
	expect(adapter.eligible(request)).toBe(true);
	expect(adapter.eligible({ ...request, sellAsset: request.buyAsset, buyAsset: request.sellAsset })).toBe(false);
	expect(adapter.eligible({ ...request, buyAsset: request.buyAsset.replace("eip155:1/", "eip155:8453/") })).toBe(false);
});

test("survives a missing pool and fails closed when no pool quotes", async () => {
	let calls = 0;
	const onePool = { readRpc: async (...args: Parameters<typeof rpc.readRpc>) => {
		if (++calls === 1) throw new Error("pool unavailable"); return rpc.readRpc(...args);
	} };
	expect((await new UniswapQuoteAdapter(onePool).quote(request)).amountOut).toBe("23.928");
	await expect(new UniswapQuoteAdapter({ readRpc: async () => { throw new Error("node unavailable"); } }).quote(request)).rejects.toThrow("No direct Uniswap pool");
});
