import { describe, expect, test } from "bun:test";
import { PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import { RelayQuoteAdapter } from "./swap";

const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501";
const ETH = "eip155:1/slip44:60";
const BTC = "bip122:000000000019d6689c085ae165831e93/slip44:0";
const SOLANA_ID = 792703809;
const BITCOIN_ID = 8253038;
const sender = "DLZ7cTizVcBpXJRcitAf7EKCtcr3KAZjmSCK6nvoUAaW";
const solRecipient = "3qhAXpHuoX8HPC7tNUu68gFybpdvF3XS6aY2aVzr87Mw";
const evmAddress = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const solCurrency = { chainId: SOLANA_ID, address: "11111111111111111111111111111111", symbol: "SOL", decimals: 9 };
const ethCurrency = { chainId: 1, address: "0x0000000000000000000000000000000000000000", symbol: "ETH", decimals: 18 };
const baseRequest = { sellAsset: SOL, buyAsset: ETH, sellAmount: "0.25", senderAddress: sender, recipientAddress: evmAddress, slippage: 3 };

function instructions() {
  const ix = SystemProgram.transfer({ fromPubkey: new PublicKey(sender), toPubkey: new PublicKey(solRecipient), lamports: 250000000 });
  return [{ programId: ix.programId.toBase58(), keys: ix.keys.map(key => ({ pubkey: key.pubkey.toBase58(), isSigner: key.isSigner, isWritable: key.isWritable })), data: ix.data.toString("hex") }];
}
function solQuote() {
  return {
    steps: [{ id: "deposit", requestId: "relay-sol-fixture", items: [{ data: { chainId: SOLANA_ID, instructions: instructions(), addressLookupTableAddresses: [] } }] }],
    details: { currencyIn: { amount: "250000000", currency: { ...solCurrency } }, currencyOut: { amount: "10000000000000000", minimumAmount: "9700000000000000", currency: { ...ethCurrency } }, timeEstimate: 15 },
    fees: { app: { amount: "750000", currency: { ...solCurrency } }, gas: { amount: "14463", currency: { ...solCurrency } } },
  };
}
function fixtureFetch(body: any, requests: any[] = []) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("api.relay.link/quote")) { requests.push(JSON.parse(String(init?.body))); return Response.json(body); }
    return Response.json([{ jsonrpc: "2.0", id: 1, result: { value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 123 } } }]);
  }) as typeof fetch;
}

describe("Relay cross-chain legacy parity", () => {
  test("SOL to ETH builds a fresh, bounded transaction with visible accounts and preserves fee units", async () => {
    const requests: any[] = [];
    const quote = await new RelayQuoteAdapter(fixtureFetch(solQuote(), requests), { nownodesApiKey: "fixture" }).quote(baseRequest);
    expect(requests[0]).toMatchObject({ originChainId: SOLANA_ID, destinationChainId: 1, originCurrency: solCurrency.address, destinationCurrency: ethCurrency.address, amount: "250000000", refundTo: sender, recipient: evmAddress, slippageTolerance: "300" });
    expect(requests[0].appFees.map((fee: any) => fee.fee)).toEqual(["15", "15"]);
    const wire = Buffer.from(quote.txs[0].txParams.serializedTx, "base64");
    const transaction = VersionedTransaction.deserialize(wire);
    expect(quote.txs[0].type).toBe("SOLANA");
    expect(transaction.message.staticAccountKeys[0].toBase58()).toBe(sender);
    expect(transaction.message.addressTableLookups).toHaveLength(0);
    expect(transaction.message.header.numRequiredSignatures).toBe(1);
    expect(transaction.message.recentBlockhash).toBe("11111111111111111111111111111111");
    expect(wire.length).toBeLessThanOrEqual(1232);
    expect(quote.amountOut).toBe("0.01");
    expect(quote.relayRequestId).toBe("relay-sol-fixture");
    expect(quote.raw.fees.affiliate).toBe("0"); // Never label lamports as ETH units.
    expect(quote.raw.fees.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "affiliate", assetCaip: SOL, symbol: "SOL", decimals: 9, amountBaseUnits: "750000", amount: "0.00075", bps: 30 })]));
  });

  test("ETH to SOL preserves the Solana recipient and requires an exact native deposit", async () => {
    const requests: any[] = [];
    const response = { requestId: "evm-to-sol", steps: [{ id: "deposit", items: [{ data: { to: "0x4cd00e387622c35bddb9b4c962c136462338bc31", data: "0x49290c1c" + "0".repeat(64) + "a".repeat(64), value: "10000000000000000", chainId: 1 } }] }], details: { currencyIn: { amount: "10000000000000000", currency: { ...ethCurrency } }, currencyOut: { amount: "250000000", currency: { ...solCurrency } } } };
    const input = { ...baseRequest, sellAsset: ETH, buyAsset: SOL, sellAmount: "0.01", senderAddress: evmAddress, recipientAddress: solRecipient, relayExecutionMode: "solver-deposit" as const };
    const quote = await new RelayQuoteAdapter(fixtureFetch(response, requests)).quote(input);
    expect(requests[0]).toMatchObject({ originChainId: 1, destinationChainId: SOLANA_ID, recipient: solRecipient, destinationCurrency: solCurrency.address, forceSolverExecution: true, explicitDeposit: true });
    expect(quote.amountOut).toBe("0.25");
    expect(quote.txs[0]).toMatchObject({ type: "EVM", txParams: { chainId: 1, value: "10000000000000000" } });
  });

  test("Bitcoin remains destination-only with the provider's own native currency sentinel", async () => {
    let request: any;
    const sentinel = "btc-provider-native-sentinel";
    const response = solQuote();
    response.details.currencyOut = { amount: "100000", minimumAmount: "97000", currency: { chainId: BITCOIN_ID, address: sentinel, symbol: "BTC", decimals: 8 } };
    const fetcher = (async (url: any, init?: RequestInit) => {
      if (String(url).endsWith("/chains")) return Response.json({ chains: [{ id: BITCOIN_ID, currency: { address: sentinel } }] });
      if (String(url).includes("relay.link/quote")) { request = JSON.parse(String(init?.body)); return Response.json(response); }
      return fixtureFetch(response)(url, init);
    }) as typeof fetch;
    const adapter = new RelayQuoteAdapter(fetcher, { nownodesApiKey: "fixture" });
    const quote = await adapter.quote({ ...baseRequest, buyAsset: BTC, recipientAddress: "bc1qfixture" });
    expect(request.destinationChainId).toBe(BITCOIN_ID);
    expect(request.destinationCurrency).toBe(sentinel);
    expect(quote.amountOut).toBe("0.001");
    expect(adapter.eligible({ ...baseRequest, sellAsset: BTC })).toBe(false);
  });

  test("uses trusted resolver decimals for tokens absent from the pinned asset catalog", async () => {
    const token = "eip155:8453/erc20:0x1234567890123456789012345678901234567890";
    let submitted: any;
    const fetcher = (async (_url: any, init?: RequestInit) => {
      submitted = JSON.parse(String(init?.body));
      return Response.json({ steps: [{ items: [{ data: { to: evmAddress, data: "0x12345678", value: "0", chainId: 8453 } }] }], details: { currencyIn: { amount: "1234567" }, currencyOut: { amount: "1000000000000000", currency: { ...ethCurrency } } } });
    }) as typeof fetch;
    const resolver = { known: () => true, resolve: async (caip: string) => ({ assetId: caip, chainId: caip.split("/")[0], symbol: caip === token ? "USD" : "ETH", decimals: caip === token ? 6 : 18 }) };
    const quote = await new RelayQuoteAdapter(fetcher, { assetResolver: resolver }).quote({ ...baseRequest, sellAsset: token, sellAmount: "1.234567", senderAddress: evmAddress });
    expect(submitted.amount).toBe("1234567");
    expect(quote.amountOut).toBe("0.001");
  });

  test("rejects unexpected source chains, amounts, owners, or additional Solana signers", async () => {
    for (const change of [
      (q: any) => { q.details.currencyIn.amount = "1"; },
      (q: any) => { q.steps[0].items[0].data.chainId = 1; },
      (q: any) => { q.steps[0].items[0].data.from = solRecipient; },
      (q: any) => { q.steps[0].items[0].data.instructions[0].keys[1].isSigner = true; },
      (q: any) => { q.steps[0].items.push(q.steps[0].items[0]); },
    ]) {
      const response = solQuote(); change(response);
      await expect(new RelayQuoteAdapter(fixtureFetch(response), { nownodesApiKey: "fixture" }).quote(baseRequest)).rejects.toThrow();
    }
  });

  test("rejects output-asset substitution or unsafe output limits", async () => {
    for (const change of [
      (q: any) => { q.details.currencyOut.currency.chainId = 8453; },
      (q: any) => { q.details.currencyOut.currency.address = evmAddress; },
      (q: any) => { q.details.currencyOut.currency.decimals = 6; },
      (q: any) => { q.details.currencyOut.minimumAmount = "0"; },
      (q: any) => { q.details.currencyOut.minimumAmount = "99999999999999999"; },
    ]) {
      const response = solQuote(); change(response);
      await expect(new RelayQuoteAdapter(fixtureFetch(response), { nownodesApiKey: "fixture" }).quote(baseRequest)).rejects.toThrow();
    }
  });

  test("odd configured fees preserve the total, and invalid configuration fails closed", async () => {
    const requests: any[] = [];
    await new RelayQuoteAdapter(fixtureFetch(solQuote(), requests), { nownodesApiKey: "fixture", feeBps: 31 }).quote(baseRequest);
    expect(requests[0].appFees.map((fee: any) => fee.fee)).toEqual(["16", "15"]);
    expect(() => new RelayQuoteAdapter(fetch, { feeBps: 1001 })).toThrow("configuration");
    expect(() => new RelayQuoteAdapter(fetch, { feeRecipients: [] })).toThrow("configuration");
  });
});
