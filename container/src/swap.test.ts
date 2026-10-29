import { describe, expect, test } from "bun:test";
import { VersionedTransaction } from "@solana/web3.js";
import { ProtocolQuoteAdapter, QuoteRouter, RelayQuoteAdapter, ShapeShiftQuoteAdapter, SwapError, SwapKitQuoteAdapter, ZeroXQuoteAdapter } from "./swap";

const request = {
	sellAsset: "eip155:1/slip44:60",
	sellAmount: "0.01",
	buyAsset: "eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
	recipientAddress: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
	senderAddress: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
	slippage: 1,
};

function fixtureFetch(url: string | URL | Request): Promise<Response> {
	const parsed = new URL(String(url));
	const provider = parsed.pathname.startsWith("/mayachain") ? "maya" : "thor";
	return Promise.resolve(Response.json({
		expected_amount_out: provider === "thor" ? "2410911698" : "2400000000",
		amount_out_min: provider === "thor" ? "2338584347" : "2300000000",
		inbound_address: "0xed23d1bf7ac2ce8b4c09a090e252ea6ee5145e6e",
		router: "0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146",
		memo: "=:ETH.USDC:destination::keep:30",
		expiry: 1787528001,
		fees: { affiliate: "7329702", outbound: "24992500", total_bps: 150, slippage_bps: 19 },
		total_swap_seconds: 30,
	}));
}

describe("diverse direct swap routing", () => {
	test("builds a THORChain executable quote with affiliate and LIM", async () => {
		const adapter = new ProtocolQuoteAdapter("thorchain", fixtureFetch as typeof fetch);
		const quote = await adapter.quote(request);
		expect(quote.amountOut).toBe("24.10911698");
		expect(quote.txs[0].type).toBe("EVM");
		expect(quote.txs[0].txParams.recipientAddress).toBe("0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146");
		expect(quote.txs[0].txParams.memo).toContain(":2386802581:keep:30");
		expect(quote.raw.fees.total_bps).toBe(150);
	});

	test("returns independent routes best-first and shares concurrent identical demand", async () => {
		let calls = 0;
		const counted = async (...args: Parameters<typeof fetch>) => { calls++; return fixtureFetch(args[0]); };
		const router = new QuoteRouter([
			new ProtocolQuoteAdapter("thorchain", counted as typeof fetch),
			new ProtocolQuoteAdapter("mayachain", counted as typeof fetch),
		]);
		const [first, second] = await Promise.all([router.quote(request), router.quote(request)]);
		expect(first.map((quote) => quote.integration)).toEqual(["thorchain", "mayachain"]);
		expect(second).toEqual(first);
		expect(calls).toBe(2);
	});

	test("keeps working when one independent provider fails", async () => {
		const thor = new ProtocolQuoteAdapter("thorchain", (() => Promise.resolve(new Response("down", { status: 503 }))) as unknown as typeof fetch);
		const maya = new ProtocolQuoteAdapter("mayachain", fixtureFetch as typeof fetch);
		const quotes = await new QuoteRouter([thor, maya]).quote(request);
		expect(quotes).toHaveLength(1);
		expect(quotes[0].integration).toBe("mayachain");
	});

	test("rejects zero slippage and unsafe address delimiters", async () => {
		const router = new QuoteRouter([new ProtocolQuoteAdapter("thorchain", fixtureFetch as typeof fetch)]);
		expect(router.quote({ ...request, slippage: 0 })).rejects.toBeInstanceOf(SwapError);
		expect(router.quote({ ...request, recipientAddress: "bitcoincash:qbad" })).rejects.toBeInstanceOf(SwapError);
	});

	test("normalizes a direct Relay route with KeepKey app fees and calldata", async () => {
		let submitted: any;
		const relayFetch = async (_url: string | URL | Request, init?: RequestInit) => {
			submitted = JSON.parse(String(init?.body));
			return Response.json({
				requestId: "0xrequest",
				steps: [{ id: "swap", items: [{ data: { to: "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f", data: "0xcd6e13f700000000", value: "10000000000000000", chainId: 1, gas: "521216" } }] }],
				fees: { gas: { amount: "24445899461264" }, app: { amount: "30000000000000" } },
				details: { currencyOut: { amount: "24432430", minimumAmount: "24188105", currency: { decimals: 6 } }, totalImpact: { percent: "-0.31" }, timeEstimate: 12 },
			});
		};
		const quote = await new RelayQuoteAdapter(relayFetch as typeof fetch).quote(request);
		expect(submitted.appFees).toEqual([{ recipient: "0x87Ab2637bc4231604ad708c5e8aAC92A260c7704", fee: "30" }]);
		expect(quote.amountOut).toBe("24.43243");
		expect(quote.txs[0]).toMatchObject({ type: "EVM", txParams: { to: "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f", gasLimit: "521216" } });
		expect(quote.raw.fees.total_bps).toBe(31);
	});

	test("normalizes a direct 0x v2 route with explicit integrator fees", async () => {
		let requestedUrl = "";
		let requestedHeaders: HeadersInit | undefined;
		const zeroXFetch = async (url: string | URL | Request, init?: RequestInit) => {
			requestedUrl = String(url);
			requestedHeaders = init?.headers;
			return Response.json({
				liquidityAvailable: true,
				buyAmount: "24454392",
				minBuyAmount: "24208792",
				fees: { integratorFee: { amount: "73693" }, zeroExFee: { amount: "36847" }, gasFee: null },
				transaction: { to: "0x0000000000001ff3684f28c67538d4d072c22734", data: "0x2213bc0b00000000", gas: "335845", gasPrice: "69626457", value: "10000000000000000" },
				zid: "0xquote",
			});
		};
		const quote = await new ZeroXQuoteAdapter("secret", zeroXFetch as typeof fetch).quote(request);
		const params = new URL(requestedUrl).searchParams;
		expect(params.get("swapFeeRecipient")).toBe("0x87Ab2637bc4231604ad708c5e8aAC92A260c7704");
		expect(params.get("swapFeeBps")).toBe("30");
		expect(new Headers(requestedHeaders).get("0x-api-key")).toBe("secret");
		expect(quote).toMatchObject({ swapper: "0x", amountOut: "24.454392", amountOutMin: "24.208792" });
		expect(quote.raw.fees.total_bps).toBe(46);
	});

	test("uses ShapeShift as an independently fee-attributed provider fallback", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const shapeShiftFetch = async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), init });
			if (String(url).includes("/rates?")) return Response.json({ rates: [
				{ swapperName: "Relay", buyAmountCryptoBaseUnit: "25000000", affiliateBps: "40", partnerBps: "30" },
				{ swapperName: "Bebop", buyAmountCryptoBaseUnit: "24554920", affiliateBps: "40", partnerBps: "30" },
			] });
			const swapperName = JSON.parse(String(init?.body)).swapperName;
			return Response.json({
				quoteId: "partner-quote", swapperName, buyAmountAfterFeesCryptoBaseUnit: "25000000", partnerBps: "30", shapeshiftBps: "10", affiliateBps: "40",
				steps: [{ estimatedExecutionTimeMs: 0, transactionData: { type: "evm", chainId: 1, to: "0xbeb0b0623f66bE8cE162EbDfA2ec543A522F4ea6", data: "0x2143d82c00000000", value: "10000000000000000", gasLimit: "409622" } }],
			});
		};
		const quote = await new ShapeShiftQuoteAdapter(shapeShiftFetch as typeof fetch).quote(request);
		expect(new Headers(calls[0].init?.headers).get("x-partner-code")).toBe("keepkey");
		expect(JSON.parse(String(calls[1].init?.body)).swapperName).toBe("Relay");
		expect(quote).toMatchObject({ swapper: "Relay", amountOut: "25", quoteId: "partner-quote" });
		expect(quote.raw.fees.total_bps).toBe(40);
	});

	test("normalizes a ShapeShift Chainflip UTXO deposit-channel fallback", async () => {
		const btcRequest = {
			...request,
			sellAsset: "bip122:000000000019d6689c085ae165831e93/slip44:0",
			buyAsset: "eip155:1/slip44:60",
			sellAmount: "0.001",
			senderAddress: "bc1qsender000000000000000000000000000000000",
		};
		let calls = 0;
		const shapeShiftFetch = async () => {
			calls++;
			if (calls === 1) return Response.json({ rates: [{ swapperName: "Chainflip", buyAmountCryptoBaseUnit: "1000000000000000", affiliateBps: "40", partnerBps: "30" }] });
			return Response.json({ quoteId: "chainflip-quote", swapperName: "Chainflip", buyAmountAfterFeesCryptoBaseUnit: "1000000000000000", partnerBps: "30", shapeshiftBps: "10", affiliateBps: "40", steps: [{ transactionData: { type: "utxo", to: "bc1qdeposit0000000000000000000000000000000", value: "100000" } }] });
		};
		const quote = await new ShapeShiftQuoteAdapter(shapeShiftFetch as unknown as typeof fetch).quote(btcRequest);
		expect(quote).toMatchObject({ swapper: "Chainflip", inbound_address: "bc1qdeposit0000000000000000000000000000000", txs: [{ type: "transfer", txParams: { value: "100000", memo: "" } }] });
	});

	test("assembles a fee-attributed ShapeShift Solana instruction route for Vault", async () => {
		const sender = "DLZ7cTizVcBpXJRcitAf7EKCtcr3KAZjmSCK6nvoUAaW";
		const recipient = "3qhAXpHuoX8HPC7tNUu68gFybpdvF3XS6aY2aVzr87Mw";
		const solanaRequest = {
			...request,
			sellAsset: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501",
			buyAsset: "eip155:1/slip44:60",
			sellAmount: "0.000000001",
			senderAddress: sender,
			recipientAddress: request.recipientAddress,
		};
		let calls = 0;
		const shapeShiftFetch = async (url: string | URL | Request) => {
			calls++;
			if (String(url).includes("/rates?")) return Response.json({ rates: [{ swapperName: "NEAR Intents", buyAmountCryptoBaseUnit: "1000", affiliateBps: "40", partnerBps: "30" }] });
			if (String(url).includes("/v1/swap/quote")) return Response.json({
				quoteId: "solana-partner-quote",
				swapperName: "NEAR Intents",
				depositAddress: recipient,
				buyAmountAfterFeesCryptoBaseUnit: "1000",
				partnerBps: "30",
				affiliateBps: "40",
				steps: [{ transactionData: {
					type: "solana_instructions",
					instructions: [{
						programId: "11111111111111111111111111111111",
						keys: [
							{ pubkey: sender, isSigner: true, isWritable: true },
							{ pubkey: recipient, isSigner: false, isWritable: true },
						],
						data: "",
					}],
					addressLookupTableAddresses: [],
				} }],
			});
			return Response.json([{ jsonrpc: "2.0", id: 1, result: { value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 123 } } }]);
		};

		const quote = await new ShapeShiftQuoteAdapter(shapeShiftFetch as typeof fetch, "nodes-key").quote(solanaRequest);
		expect(calls).toBe(3);
		expect(quote).toMatchObject({
			swapper: "NEAR Intents",
			// The 1Click deposit address, not the user's destination: Vault verifies it with 1Click.
			inbound_address: recipient,
			meta: { depositAddress: recipient },
			txs: [{ type: "SOLANA", txParams: { senderAddress: sender, recipientAddress: recipient, amount: "0.000000001" } }],
		});
		const wire = Buffer.from(quote.txs[0].txParams.serializedTx, "base64");
		const transaction = VersionedTransaction.deserialize(wire);
		expect(transaction.message.staticAccountKeys[0].toBase58()).toBe(sender);
		expect(transaction.message.header.numRequiredSignatures).toBe(1);
		expect(wire.length).toBeLessThanOrEqual(1232);
	});

	test("rejects ShapeShift Solana routes requiring an additional signer", async () => {
		const sender = "DLZ7cTizVcBpXJRcitAf7EKCtcr3KAZjmSCK6nvoUAaW";
		let calls = 0;
		const shapeShiftFetch = async (url: string | URL | Request) => {
			calls++;
			if (String(url).includes("/rates?")) return Response.json({ rates: [{ swapperName: "Relay", buyAmountCryptoBaseUnit: "1000", affiliateBps: "40", partnerBps: "30" }] });
			return Response.json({
				quoteId: "unsafe-solana-quote", swapperName: "Relay", buyAmountAfterFeesCryptoBaseUnit: "1000", partnerBps: "30", affiliateBps: "40",
				steps: [{ transactionData: { type: "solana_instructions", instructions: [{ programId: "11111111111111111111111111111111", keys: [{ pubkey: "3qhAXpHuoX8HPC7tNUu68gFybpdvF3XS6aY2aVzr87Mw", isSigner: true, isWritable: false }], data: "" }], addressLookupTableAddresses: [] } }],
			});
		};
		const adapter = new ShapeShiftQuoteAdapter(shapeShiftFetch as typeof fetch, "nodes-key");
		await expect(adapter.quote({ ...request, sellAsset: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501", sellAmount: "0.000000001", senderAddress: sender })).rejects.toThrow("unsupported additional signer");
		expect(calls).toBe(2);
	});

	test("gates SwapKit fallback on live nonzero affiliate attribution", async () => {
		let calls = 0;
		const noFeeFetch = async () => {
			calls++;
			return Response.json({ routes: [{ routeId: "route", providers: ["ONEINCH"], fees: [{ type: "affiliate", amount: "0", amountBps: 0 }] }] });
		};
		const adapter = new SwapKitQuoteAdapter("key", noFeeFetch as unknown as typeof fetch);
		expect(adapter.quote(request)).rejects.toThrow("no fee-attributed");
		expect(calls).toBe(1);
	});

	test("normalizes a fee-attributed SwapKit v3 executable fallback", async () => {
		let calls = 0;
		let quoteBody: any;
		const swapKitFetch = async (_url: string | URL | Request, init?: RequestInit) => {
			calls++;
			if (calls === 1) { quoteBody = JSON.parse(String(init?.body)); return Response.json({ quoteId: "quote", routes: [{ routeId: "route", providers: ["ONEINCH"], expectedBuyAmount: "24.6", expectedBuyAmountMaxSlippage: "24.3", fees: [{ type: "affiliate", amount: "0.0738", amountBps: 30 }] }] }); }
			return Response.json({ swapId: "swap", providers: ["ONEINCH"], expectedBuyAmount: "24.6", expectedBuyAmountMaxSlippage: "24.3", fees: [{ type: "affiliate", amount: "0.0738", amountBps: 30 }, { type: "service", amount: "0.0492", amountBps: 20 }], meta: { txType: "EVM" }, tx: { to: "0x9025B8ff35Ca44f7018C3a37FE0f69e63DBb0743", data: "0xda5d417000000000", value: "10000000000000000", gas: "0x52160" } });
		};
		const quote = await new SwapKitQuoteAdapter("key", swapKitFetch as unknown as typeof fetch).quote(request);
		expect(calls).toBe(2);
		expect(quoteBody.affiliateFee).toBeUndefined();
		expect(quote).toMatchObject({ swapper: "ONEINCH", amountOut: "24.6", amountOutMin: "24.3" });
		expect(quote.raw.fees.total_bps).toBe(50);
	});
});
