import { describe, expect, test } from "bun:test";
import { bech32 } from "@scure/base";
import { Interface } from "ethers";
import { NearIntentsQuoteAdapter, NEAR_INTENTS_FEE_RECIPIENT, NATIVE_NEAR_ASSETS } from "./near-intents";
import type { QuoteRequest } from "./swap";

const ETH = "eip155:1/slip44:60", LTC = "bip122:12a765e31ffd4059bada1e25190f6e98/slip44:2";
const sender = "0x1111111111111111111111111111111111111111", deposit = "0x2222222222222222222222222222222222222222";
const pubHash = new Uint8Array(Buffer.from("751e76e8199196d454941c45d1b3a323f1433bd6", "hex"));
const ltcAddress = bech32.encode("ltc", [0, ...bech32.toWords(pubHash)]);
const btcAddress = bech32.encode("bc", [0, ...bech32.toWords(pubHash)]);
const now = 1793730000000;
const request: QuoteRequest = { sellAsset: ETH, buyAsset: LTC, sellAmount: "0.021319123456789123", senderAddress: sender, recipientAddress: ltcAddress, slippage: 3 };
function setup(options: { tokens?: any[]; mutate?: (raw: any) => void; statusMutate?: (raw: any) => void; tokenOutage?: boolean; feeBps?: number } = {}) {
	const calls: string[] = [], payloads: any[] = [];
	let raw: any;
	const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
		calls.push(String(url));
		if (String(url).endsWith("/v0/tokens")) return options.tokenOutage ? new Response("offline", { status: 503 }) : Response.json(options.tokens || []);
		if (String(url).endsWith("/v0/quote")) {
			const payload = JSON.parse(String(init?.body)); payloads.push(payload);
			const source = payload.originAsset.includes("ltc") ? ltcAddress : payload.originAsset.includes("sol") ? "11111111111111111111111111111111" : deposit;
			raw = { correlationId: "near-quote", quoteRequest: { ...payload, appFees: [{ recipient: NEAR_INTENTS_FEE_RECIPIENT, fee: 15 }, { recipient: "1click-platform.near", fee: 20 }] },
				quote: { depositAddress: source, amountIn: payload.amount, minAmountIn: payload.amount, amountOut: "89548376", minAmountOut: "86861924", deadline: payload.deadline, timeEstimate: 187, withdrawFee: "500" } };
			options.mutate?.(raw);
			return Response.json(raw);
		}
		if (String(url).includes("/v0/status?")) {
			const status = { status: "PENDING_DEPOSIT", quoteResponse: structuredClone(raw) };
			options.statusMutate?.(status);
			return Response.json(status);
		}
		throw new Error(`Unexpected URL: ${url}`);
	};
	return { adapter: new NearIntentsQuoteAdapter(fetcher as typeof fetch, { now: () => now, feeBps: options.feeBps }), calls, payloads };
}

describe("direct NEAR Intents", () => {
	test("supports an explicit zero app fee and still bounds provider-added fees", async () => {
		const fixture = setup({ feeBps: 0, mutate: raw => { raw.quoteRequest.appFees = [{ recipient: "1click-platform.near", fee: 20 }]; } });
		const quote = await fixture.adapter.quote(request);
		expect(fixture.payloads[0].appFees).toBeUndefined();
		expect(quote.raw.fees.items.some((item: any) => item.kind === "affiliate")).toBe(false);
		expect(quote.raw.fees.total_bps).toBe(20);
		await expect(setup({ feeBps: 0, mutate: raw => { raw.quoteRequest.appFees = [{ recipient: "1click-platform.near", fee: 500 }]; } }).adapter.quote(request)).rejects.toThrow("fee");
		await expect(setup({ feeBps: 0, mutate: raw => { raw.quoteRequest.appFees = [{ recipient: NEAR_INTENTS_FEE_RECIPIENT, fee: 1 }]; } }).adapter.quote(request)).rejects.toThrow("fee");
	});
	test("accepts Vault native EVM aliases without changing fee or transaction asset identity", async () => {
		for (const [network, assetId] of [["56", "56"], ["137", "137"], ["43114", "43114"]]) {
			const fixture = setup(), caip = `eip155:${network}/slip44:60`;
			const quote = await fixture.adapter.quote({ ...request, sellAsset: caip });
			expect(fixture.payloads[0].originAsset).toBe(`nep245:v2_1.omni.hot.tg:${assetId}_11111111111111111111`);
			expect(quote.txs[0].txParams.token).toBe(caip);
			expect(quote.raw.fees.items[0].assetCaip).toBe(caip);
		}
	});
	test("does no startup traffic and preserves exact native ETH, addresses, protocol minimum and effective fee split", async () => {
		const fixture = setup();
		expect(fixture.calls).toHaveLength(0);
		expect(fixture.adapter.eligible(request)).toBe(true);
		expect(fixture.adapter.memoless).toBe(true);
		const quote = await fixture.adapter.quote(request);
		expect(fixture.payloads[0]).toMatchObject({ dry: false, depositMode: "SIMPLE", amount: "21319123456789123", originAsset: "nep141:eth.omft.near", destinationAsset: "nep141:ltc.omft.near", refundTo: sender, refundType: "ORIGIN_CHAIN", recipient: ltcAddress, recipientType: "DESTINATION_CHAIN", appFees: [{ recipient: NEAR_INTENTS_FEE_RECIPIENT, fee: 30 }] });
		expect(quote).toMatchObject({ swapper: "NEAR Intents", amountOut: "0.89548376", amountOutMin: "0.86861924", inbound_address: deposit });
		expect(quote.txs[0].txParams).toMatchObject({ amount: request.sellAmount, data: "0x", value: "21319123456789123", senderAddress: sender, to: deposit, chainId: 1 });
		expect(quote.raw.fees).toMatchObject({ total_bps: 35, affiliate: "0", outbound: "0" });
		expect(quote.raw.fees.items).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: "affiliate", assetCaip: ETH, decimals: 18, bps: 15, recipient: NEAR_INTENTS_FEE_RECIPIENT }),
			expect.objectContaining({ kind: "protocol", assetCaip: ETH, bps: 20 }),
			expect.objectContaining({ kind: "network", assetCaip: LTC, decimals: 8, amountBaseUnits: "500" }),
		]));
		expect(quote.meta.depositVerification.status).toBe("PENDING_DEPOSIT");
		expect(fixture.calls.filter(url => url.includes("/status?"))).toHaveLength(1);
	});
	test("restores broad native coverage and UTXO/Solana plain deposits", async () => {
		for (const asset of NATIVE_NEAR_ASSETS) expect(setup().adapter.eligible({ ...request, sellAsset: asset.caip })).toBe(true);
		const ltc = setup();
		const quote = await ltc.adapter.quote({ ...request, sellAsset: LTC, sellAmount: "1.12345678", senderAddress: ltcAddress, buyAsset: ETH, recipientAddress: sender });
		expect(quote.txs[0]).toMatchObject({ type: "transfer", chain: LTC.split("/")[0], txParams: { to: ltcAddress, amount: "1.12345678", senderAddress: ltcAddress } });
		expect(quote.txs[0].txParams.memo).toBeUndefined();
		const sol = setup();
		const sq = await sol.adapter.quote({ ...request, sellAsset: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501", sellAmount: "0.25", senderAddress: "11111111111111111111111111111111" });
		expect(sq.txs[0].type).toBe("SOLANA");
	});
	test("discovers an unpinned ERC20 with exact registry decimals and encodes its transfer", async () => {
		const contract = "0x3333333333333333333333333333333333333333";
		const fixture = setup({ tokens: [{ assetId: "nep141:custom-token.near", blockchain: "eth", contractAddress: contract, decimals: 6, symbol: "CUSTOM" }] });
		const quote = await fixture.adapter.quote({ ...request, sellAsset: `${ETH.split("/")[0]}/erc20:${contract}`, sellAmount: "1.123456" });
		expect(fixture.payloads[0]).toMatchObject({ originAsset: "nep141:custom-token.near", amount: "1123456" });
		expect(quote.txs[0].txParams).toMatchObject({ to: contract, recipientAddress: deposit, value: "0" });
		const decoded = new Interface(["function transfer(address,uint256)"]).decodeFunctionData("transfer", quote.txs[0].txParams.data);
		expect(decoded[0].toLowerCase()).toBe(deposit);
		expect(decoded[1]).toBe(1123456n);
		expect(quote.raw.fees.items[0]).toMatchObject({ decimals: 6, symbol: "CUSTOM", amountBaseUnits: "1685" });
	});
	test("a registry outage retains natives but never guesses unknown-token decimals", async () => {
		const fixture = setup({ tokenOutage: true });
		await expect(fixture.adapter.quote(request)).resolves.toHaveProperty("amountOut");
		await expect(fixture.adapter.quote({ ...request, sellAsset: "eip155:1/erc20:0x3333333333333333333333333333333333333333" })).rejects.toThrow("absent from the live token registry");
	});
	test("rejects invalid native precision and cross-chain addresses before allocating a quote", async () => {
		const fixture = setup();
		await expect(fixture.adapter.quote({ ...request, recipientAddress: sender })).rejects.toThrow();
		expect(fixture.calls).toHaveLength(0);
		await expect(fixture.adapter.quote({ ...request, sellAsset: LTC, sellAmount: "1.123456789", senderAddress: ltcAddress, buyAsset: ETH, recipientAddress: sender })).rejects.toThrow("8-decimal asset precision");
		expect(fixture.payloads).toHaveLength(0);
	});
	test("rejects substituted refund/payout/assets/input, unsafe limits, fees, deadlines and memo deposits", async () => {
		for (const mutate of [
			(raw: any) => { raw.quoteRequest.refundTo = NEAR_INTENTS_FEE_RECIPIENT; },
			(raw: any) => { raw.quoteRequest.refundType = "INTENTS"; },
			(raw: any) => { raw.quoteRequest.recipient = btcAddress; },
			(raw: any) => { raw.quoteRequest.destinationAsset = "nep141:btc.omft.near"; },
			(raw: any) => { raw.quote.amountIn = "1"; },
			(raw: any) => { raw.quote.minAmountOut = "1"; },
			(raw: any) => { raw.quoteRequest.appFees = [{ recipient: "other.near", fee: 30 }]; },
			(raw: any) => { raw.quoteRequest.appFees[0].fee = 300; },
			(raw: any) => { raw.quoteRequest.appFees = [{ recipient: NEAR_INTENTS_FEE_RECIPIENT, fee: 20 }, { recipient: NEAR_INTENTS_FEE_RECIPIENT, fee: 20 }]; },
			(raw: any) => { raw.quote.deadline = new Date(now - 1000).toISOString(); },
			(raw: any) => { raw.quote.depositAddress = ltcAddress; },
			(raw: any) => { raw.quote.depositMemo = "123"; },
		]) {
			await expect(setup({ mutate }).adapter.quote(request)).rejects.toThrow("NEAR Intents");
		}
	});
	test("independently verifies the pending deposit record before offering the route", async () => {
		for (const statusMutate of [
			(status: any) => { status.status = "SUCCESS"; },
			(status: any) => { status.quoteResponse.quoteRequest.refundTo = deposit; },
			(status: any) => { status.quoteResponse.quote.depositAddress = sender; },
			(status: any) => { status.quoteResponse.quote.amountOut = "99999999"; },
			(status: any) => { status.quoteResponse.quoteRequest.appFees[0].fee = 20; },
		]) await expect(setup({ statusMutate }).adapter.quote(request)).rejects.toThrow("NEAR Intents");
	});
});
