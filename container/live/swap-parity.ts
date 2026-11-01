/** Demand-only comparison. Public fixtures; never signs or broadcasts funds.
 * Registers one isolated API client per host, then reads RPC and swap quotes.
 * bun container/live/swap-parity.ts https://oracles.cc https://api.keepkey.info
 */
export {};

const hosts = process.argv.slice(2);
if (!hosts.length) throw new Error("Provide at least one API origin");
const owner = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const usdt = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

async function inspect(origin: string) {
	const key = `vault:swap-parity:${crypto.randomUUID()}:${crypto.randomUUID()}`;
	const observations: Record<string, unknown> = {};
	async function request(name: string, path: string, body?: unknown) {
		const started = performance.now();
		try {
			const response = await fetch(`${origin}${path}`, {
				method: body === undefined ? "GET" : "POST",
				headers: { Authorization: key, "Content-Type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(45_000),
			});
			const rawBody = await response.text();
			let data: unknown;
			try { data = JSON.parse(rawBody); } catch { data = { nonJson: true }; }
			observations[name] = { status: response.status, durationMs: Math.round(performance.now() - started), body: data };
			return data as any;
		} catch (error) {
			observations[name] = { error: error instanceof Error ? error.message : String(error) };
		}
	}
	// The registration response contains credentials; never print or retain it.
	await request("registration", "/api/v1/user/register", { username: `swap-parity-${crypto.randomUUID()}`, queryKey: key });
	delete observations.registration;
	await request("healthBefore", "/api/v1/swap/health");
	const rpc = (name: string, method: string, params: unknown[]) => request(name, "/api/v1/evm/rpc", { networkId: "eip155:1", method, params });
	await rpc("paddedCall", "eth_call", [{ to: usdt, data: "0x313ce567", gas: "0x070d60", nonce: "0x0000", value: "0x00" }, "latest"]);
	await rpc("estimateGas", "eth_estimateGas", [{ from: owner, to: "0x000000000000000000000000000000000000dEaD", value: "0x01" }, "pending"]);
	await rpc("feeHistory", "eth_feeHistory", ["0x4", "latest", [60]]);
	await rpc("simulateV1", "eth_simulateV1", [{ blockStateCalls: [{ calls: [{ to: usdt, data: "0x313ce567" }] }] }, "latest"]);
	const quote = await request("ethUsdtQuote", "/api/v1/quote", {
		sellAsset: "eip155:1/slip44:60", buyAsset: `eip155:1/erc20:${usdt.toLowerCase()}`,
		sellAmount: "0.01", senderAddress: owner, recipientAddress: owner, slippage: 1,
	});
	// Calldata is ephemeral and verbose. Retain only behavior and fee attribution.
	const entries = Array.isArray(quote) ? quote : Array.isArray(quote?.data) ? quote.data : null;
	if (entries) (observations.ethUsdtQuote as any).body = entries.map((entry: any) => {
		const route = entry.quote || entry;
		return { integration: entry.integration, swapper: route.swapper, amountOut: route.amountOut, fees: route.raw?.fees, meta: route.meta, gasLimit: route.txs?.[0]?.txParams?.gasLimit };
	});
	await request("healthAfter", "/api/v1/swap/health");
	return { origin, checkedAt: new Date().toISOString(), observations };
}

console.log(JSON.stringify(await Promise.all(hosts.map(inspect)), null, 2));
