export {};

import { Transaction } from "@solana/web3.js";

const baseUrl = (process.argv.find((arg) => arg.startsWith("--url="))?.slice(6) || "http://127.0.0.1:12000").replace(/\/$/, "");
const queryKey = process.env.LIVE_QUERY_KEY || `vault:live:${crypto.randomUUID()}:${crypto.randomUUID()}`;
const fixtureAddress = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const usdcContract = "0xA0b86991c6218b36c1d19d4a2e9eb0cE3606eB48";

interface Observation {
	name: string;
	status: "pass" | "skip";
	durationMs: number;
	detail?: Record<string, unknown>;
}

const observations: Observation[] = [];

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function requestJson(path: string, init: RequestInit = {}): Promise<{ body: any; durationMs: number }> {
	const started = performance.now();
	const response = await fetch(`${baseUrl}${path}`, {
		...init,
		headers: { Authorization: queryKey, Accept: "application/json", ...(init.headers || {}) },
		signal: AbortSignal.timeout(30_000),
	});
	const durationMs = Math.round((performance.now() - started) * 100) / 100;
	const body = await response.json().catch(() => null);
	if (!response.ok) throw new Error(`${init.method || "GET"} ${path} failed (${response.status}): ${JSON.stringify(body)}`);
	return { body, durationMs };
}

async function check(name: string, task: () => Promise<{ durationMs: number; detail?: Record<string, unknown> }>): Promise<void> {
	const result = await task();
	observations.push({ name, status: "pass", ...result });
	console.log(`PASS ${name} (${result.durationMs}ms)`);
}

await check("health", async () => {
	const result = await requestJson("/api/v1/health");
	assert(result.body?.status === "ok" && result.body?.database === "ok", "Gateway is not ready");
	assert(result.body?.evm === "enabled", "EVM adapter is disabled");
	assert(result.body?.market === "enabled", "Market adapter is disabled");
	assert(result.body?.utxo === "enabled", "UTXO adapter is disabled");
	assert(result.body?.portfolio === "enabled", "Portfolio adapter is disabled");
	assert(result.body?.hive === "enabled", "Hive adapter is disabled");
	return { durationMs: result.durationMs, detail: { adapters: { evm: result.body.evm, market: result.body.market, utxo: result.body.utxo, zerion: result.body.zerion } } };
});

await check("registration", async () => {
	const result = await requestJson("/api/v1/user/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ username: "vault-live-contract", queryKey }),
	});
	assert(result.body?.success === true, "Registration failed");
	return { durationMs: result.durationMs };
});

await check("authenticated SSE subscription", async () => {
	const started = performance.now();
	const response = await fetch(`${baseUrl}/api/v1/events/subscribe`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "text/event-stream", "x-api-key": queryKey },
		body: JSON.stringify({ addresses: [{ address: fixtureAddress, networkId: "eip155:1" }], events: ["tx:incoming", "tx:confirmed"] }),
		signal: AbortSignal.timeout(5_000),
	});
	assert(response.ok && response.body, "SSE subscription failed");
	const reader = response.body.getReader();
	const first = new TextDecoder().decode((await reader.read()).value);
	await reader.cancel();
	assert(first.includes("event: connected") && first.includes('"watching":1'), "SSE connected frame is invalid");
	return { durationMs: Math.round((performance.now() - started) * 100) / 100 };
});

await check("Socket.IO v4 compatibility", async () => {
	const started = performance.now();
	const socketUrl = baseUrl.replace(/^http/, "ws") + "/socket.io/?EIO=4&transport=websocket";
	await new Promise<void>((resolve, reject) => {
		const socket = new WebSocket(socketUrl);
		const timeout = setTimeout(() => { socket.close(); reject(new Error("Socket.IO authentication timed out")); }, 5_000);
		socket.onerror = () => { clearTimeout(timeout); reject(new Error("Socket.IO connection failed")); };
		socket.onmessage = (event) => {
			const frame = String(event.data);
			if (frame.startsWith("0")) { socket.send("40"); return; }
			if (frame.startsWith("40")) { socket.send(`42["authenticate",${JSON.stringify({ queryKey })}]`); return; }
			if (!frame.startsWith("42")) return;
			const [name, data] = JSON.parse(frame.slice(2));
			if (name === "authenticated" && data?.success === true) {
				clearTimeout(timeout);
				socket.close();
				resolve();
			}
		};
	});
	return { durationMs: Math.round((performance.now() - started) * 100) / 100 };
});

await check("openapi operation contract", async () => {
	const result = await requestJson("/spec/swagger.json");
	const operations = new Set<string>();
	for (const path of Object.values(result.body?.paths || {}) as any[]) {
		for (const operation of Object.values(path || {}) as any[]) {
			if (typeof operation?.operationId === "string") operations.add(operation.operationId);
		}
	}
	const required = ["RecordVaultPerformance", "CreateHiveAccount", "GetHiveAccount", "GetHiveUsernameAvailable", "GetHiveTxParams", "GetHiveHistory", "BroadcastHiveTx", "BroadcastHiveOps", "Quote", "CreatePendingSwap", "GetPendingSwap", "GetStakingPositions", "GetName", "GetNameRegistrationQuote", "SearchAssets", "GetAvailableAssets", "GetSupportedSwapChains", "GetSwapHealth", "GetMarketInfo", "GetPortfolioBalances", "GetTransactionHistory", "GetAccountInfo", "BuildSolanaTransfer", "BuildSolanaTransferToken", "GetGasPriceByNetwork", "GetNonceByNetwork", "GetBalanceAddressByNetwork", "GetTokenDecimals", "GetTokenBalance", "GetPubkeyInfo", "ListUnspent", "GetFeeRate", "GetFeeRateByNetwork", "LookupUtxoTx", "UtxoLookup", "Broadcast"];
	for (const operation of required) assert(operations.has(operation), `OpenAPI is missing ${operation}`);
	return { durationMs: result.durationMs, detail: { verifiedOperations: required } };
});

await check("broadcast payload validation is fail-closed", async () => {
	const started = performance.now();
	for (const networkId of ["cosmos:cosmoshub-4", "ripple:4109c6f2045fc7eff4cde8f9905d19c2"]) {
		const response = await fetch(`${baseUrl}/api/v1/broadcast`, {
			method: "POST",
			headers: { Authorization: queryKey, "Content-Type": "application/json" },
			body: JSON.stringify({ networkId, serialized: "not-a-signed-transaction" }),
			signal: AbortSignal.timeout(5_000),
		});
		const body = await response.json() as any;
		assert(response.status === 400 && body?.error?.code === "broadcast_error", `${networkId} malformed payload did not fail closed`);
	}
	return { durationMs: Math.round((performance.now() - started) * 100) / 100 };
});

await check("Vault telemetry PostgreSQL ingest", async () => {
	const result = await requestJson("/api/v1/telemetry/vault", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ records: [{ traceId: `live-${Date.now()}`, clientTotalMs: 25, serverMs: 20, outcome: "ok", degraded: false, appVersion: "contract-test", platform: "test", at: Date.now() }] }) });
	assert(result.body?.accepted === 1, "Telemetry record was not persisted");
	return { durationMs: result.durationMs };
});

const publicHiveKey = "STM71ftbuam2PxxkyJzX4VSG29qaKwb77B25CfvqbZ2Mr4FwxvwDi";
await check("Hive account resolution", async () => {
	const result = await requestJson(`/api/v1/hive/account/${publicHiveKey}`);
	assert(result.body?.success === true && result.body?.account?.name === "keepkey", "Hive key did not resolve to @keepkey");
	assert(typeof result.body.account.hp === "string" && Number.isFinite(result.body.account.rcPercent), "Hive account power or RC fields are missing");
	return { durationMs: result.durationMs };
});

await check("Hive username availability", async () => {
	const result = await requestJson("/api/v1/hive/username-available/keepkey");
	assert(result.body?.success === true && result.body?.available === false, "Known Hive account was reported available");
	return { durationMs: result.durationMs };
});

await check("Hive signing parameters", async () => {
	const result = await requestJson("/api/v1/hive/tx-params");
	assert(result.body?.success === true && Number.isSafeInteger(result.body?.refBlockNum) && /^[a-f0-9]{64}$/.test(result.body?.chainId || ""), "Hive signing parameters are invalid");
	return { durationMs: result.durationMs };
});

await check("Hive onboarding rejects malformed claims before provider work", async () => {
	const started = performance.now();
	const response = await fetch(`${baseUrl}/api/v1/hive/create-account`, {
		method: "POST",
		headers: { Authorization: queryKey, "Content-Type": "application/json" },
		body: JSON.stringify({ username: "Invalid--Hive--Name" }),
		signal: AbortSignal.timeout(5_000),
	});
	const body = await response.json() as any;
	assert(
		(response.status === 400 || response.status === 503) && body?.error?.code === "hive_error",
		"Hive onboarding claim did not fail closed",
	);
	return { durationMs: Math.round((performance.now() - started) * 100) / 100 };
});

const pendingSwapTxHash = "0x1111111111111111111111111111111111111111111111111111111111111200";
const pendingSwapFixture = {
	txHash: pendingSwapTxHash,
	addresses: [],
	sellAsset: { caip: "eip155:1/slip44:60", symbol: "ETH", amount: "0.01", amountBaseUnits: "10000000000000000", address: fixtureAddress, networkId: "eip155:1" },
	buyAsset: { caip: `eip155:1/erc20:${usdcContract.toLowerCase()}`, symbol: "USDC", amount: "25", amountBaseUnits: "25000000", address: fixtureAddress, networkId: "eip155:1" },
	quote: { id: pendingSwapTxHash, integration: "relay", expectedAmountOut: "25", minimumAmountOut: "24", fees: { affiliate: "0", protocol: "0", network: "0" }, slippage: 3 },
	integration: "relay",
	swapper: "Relay",
	relayData: { requestId: "live-contract-request" },
};

await check("pending swap idempotent persistence", async () => {
	const first = await requestJson("/api/v1/swaps/pending", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pendingSwapFixture) });
	const second = await requestJson("/api/v1/swaps/pending", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...pendingSwapFixture, invocationId: "idempotent-retry" }) });
	assert(first.body?.status === "pending" && second.body?.status === "pending", "Pending swap was not registered");
	assert(first.body?.createdAt === second.body?.createdAt && second.body?.invocationId === "idempotent-retry", "Pending swap retry was not an idempotent update");
	return { durationMs: first.durationMs + second.durationMs };
});

await check("pending swap durable read without provider demand", async () => {
	const result = await requestJson(`/api/v1/swaps/pending/${pendingSwapTxHash}`);
	assert(result.body?.txHash === pendingSwapTxHash && result.body?.relayData?.requestId === "live-contract-request", "Pending swap read lost its Vault envelope");
	assert(result.body?.confirmations === 0 && result.body?.outboundConfirmations === 0, "Pending swap defaults are invalid");
	return { durationMs: result.durationMs };
});

await check("Maya historical swap classification", async () => {
	const txHash = "A9260E10AE66DF46C4EE4128A664B41736DBD845D07041F67DE278F9CEF25A46";
	const fixture = {
		txHash,
		addresses: [],
		sellAsset: { caip: "bip122:00040fe8ec8471911baa1db1266ea15d/slip44:133", symbol: "ZEC", amount: "2", amountBaseUnits: "200000000", address: "", networkId: "bip122:00040fe8ec8471911baa1db1266ea15d" },
		buyAsset: { caip: `eip155:1/erc20:${usdcContract.toLowerCase()}`, symbol: "USDC", amount: "1184.747774", amountBaseUnits: "1184747774", address: fixtureAddress, networkId: "eip155:1" },
		quote: { id: "historical-maya-contract", integration: "mayachain", expectedAmountOut: "1184.747774", minimumAmountOut: "1170", memo: "=:ETH.USDC" },
		integration: "mayachain",
		swapper: "MayaChain",
	};
	await requestJson("/api/v1/swaps/pending", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fixture) });
	const result = await requestJson(`/api/v1/swaps/pending/${txHash}?rescan=true`);
	assert(result.body?.status === "completed" && result.body?.outboundTxid === "17AB8000BBD3CB951C83F917C5A93282C259F281CC284FBC5665BB226089609A", "Maya Midgard did not classify the known completed swap");
	assert(result.body?.receivedOutput === "1184.747774", "Maya output amount was not normalized from Midgard base units");
	return { durationMs: result.durationMs };
});

await check("pinned discovery search", async () => {
	const first = await requestJson("/api/v1/discovery/search?q=ethereum&limit=30");
	assert(Array.isArray(first.body) && first.body.some((asset: any) => asset.assetId === "eip155:1/slip44:60"), "Discovery search omitted Ethereum");
	assert(first.body.find((asset: any) => asset.assetId === "eip155:1/slip44:60")?.precision === 18, "Discovery search omitted Ethereum precision");
	const repeat = await requestJson("/api/v1/discovery/search?q=ethereum&limit=30");
	assert(JSON.stringify(repeat.body) === JSON.stringify(first.body), "Pinned discovery results changed between reads");
	return { durationMs: first.durationMs + repeat.durationMs, detail: { count: first.body.length } };
});

await check("pinned available swap assets", async () => {
	const result = await requestJson("/api/v1/swap/available-assets");
	assert(result.body?.success === true && result.body?.data?.total === 23, "Available-assets envelope is invalid");
	assert(result.body.data.assets.some((asset: any) => asset.asset === "SOL.USDC" && asset.decimals === 6), "Available assets omitted Solana USDC");
	return { durationMs: result.durationMs, detail: { count: result.body.data.total } };
});

await check("pinned swap provider chains", async () => {
	const result = await requestJson("/api/v1/swappers/supported-chains");
	assert(Array.isArray(result.body?.thorchain) && result.body.thorchain.includes("eip155:1"), "THORChain coverage is invalid");
	assert(Array.isArray(result.body?.shapeshift) && result.body.shapeshift.includes("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), "ShapeShift coverage omitted Solana");
	assert(result.body.relay.includes("eip155:999") && result.body.relay.includes("eip155:4663"), "Relay coverage omitted Hyperliquid or Robinhood Chain");
	assert(Array.isArray(result.body?.chainflip) && result.body.chainflip.includes("bip122:000000000019d6689c085ae165831e93"), "Chainflip fallback coverage is invalid");
	return { durationMs: result.durationMs };
});

await check("demand-only swap health", async () => {
	const result = await requestJson("/api/v1/swap/health");
	assert(Array.isArray(result.body?.integrations) && result.body.integrations.length === 6, "Swap health envelope is invalid");
	assert(["thorchain", "mayachain", "relay", "zeroex", "shapeshift", "swapkit"].every((key) => result.body.integrations.some((integration: any) => integration.key === key)), "Swap health omitted an independent or fallback integration");
	assert(result.body.integrations.filter((integration: any) => integration.key !== "swapkit").every((integration: any) => integration.status === "unknown"), "Direct and ShapeShift integrations must remain demand-tested, not background-polled");
	assert(result.body.integrations.find((integration: any) => integration.key === "swapkit")?.status === "gated", "SwapKit must remain explicitly fee-gated");
	return { durationMs: result.durationMs };
});

await check("swap affiliate attribution contracts", async () => {
	const started = performance.now();
	const partnerResponse = await fetch("https://api.shapeshift.com/v1/partner/keepkey", { signal: AbortSignal.timeout(10_000) });
	const partner = await partnerResponse.json() as any;
	assert(partnerResponse.ok && partner?.partnerCode === "keepkey" && Number(partner?.partnerBps) > 0, "ShapeShift keepkey partner attribution is not active");
	const swapkitKey = process.env.SWAPKIT_API_KEY;
	assert(typeof swapkitKey === "string" && swapkitKey.length > 0, "SWAPKIT_API_KEY is required for live fallback verification");
	const swapkitResponse = await fetch("https://api.swapkit.dev/v3/quote", {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json", "x-api-key": swapkitKey },
		body: JSON.stringify({ sellAsset: "ETH.ETH", buyAsset: "BTC.BTC", sellAmount: "0.001", slippage: 3 }),
		signal: AbortSignal.timeout(20_000),
	});
	const swapkit = await swapkitResponse.json() as any;
	assert(swapkitResponse.ok && Array.isArray(swapkit?.routes), `SwapKit API-key quote failed (${swapkitResponse.status})`);
	const attributed = swapkit.routes.filter((route: any) => Array.isArray(route.fees) && route.fees.some((fee: any) => fee.type === "affiliate" && Number(fee.amountBps) > 0));
	const unattributed = swapkit.routes.filter((route: any) => Array.isArray(route.fees) && route.fees.some((fee: any) => fee.type === "affiliate" && Number(fee.amountBps) === 0));
	assert(attributed.length > 0 || unattributed.length === swapkit.routes.length, "SwapKit returned ambiguous affiliate fee metadata");
	return { durationMs: Math.round((performance.now() - started) * 100) / 100, detail: { shapeShiftPartnerBps: Number(partner.partnerBps), swapkit: attributed.length > 0 ? "fee-attributed" : "gated-unattributed", swapkitAttributedRoutes: attributed.length } };
});

await check("diverse executable swap quote", async () => {
	const result = await requestJson("/api/v1/quote", {
		method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
			sellAsset: "eip155:1/slip44:60", sellAmount: "0.01",
			buyAsset: `eip155:1/erc20:${usdcContract.toLowerCase()}`,
			recipientAddress: fixtureAddress, senderAddress: fixtureAddress, slippage: 1,
		}),
	});
	assert(Array.isArray(result.body) && result.body.length >= 2, "Quote router returned no provider diversity");
	assert(result.body.every((quote: any) => typeof quote?.quote?.amountOut === "string" && quote.quote.amountOut !== "0"), "Quote router returned a zero output");
	assert(result.body.some((quote: any) => quote.integration === "relay") && result.body.some((quote: any) => quote.integration === "zeroex"), "Independent Relay and 0x routes were not both retained");
	return { durationMs: result.durationMs, detail: { integrations: result.body.map((quote: any) => quote.integration) } };
});

const marketPath = "/api/v1/market/info";
const marketBody = JSON.stringify([
	"bip122:000000000019d6689c085ae165831e93/slip44:0",
	"eip155:1/slip44:60",
	"eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
]);
await check("market CAIP batch", async () => {
	const result = await requestJson(marketPath, { method: "POST", headers: { "Content-Type": "application/json" }, body: marketBody });
	assert(Array.isArray(result.body) && result.body.length === 3, "Market response must be a three-price array");
	assert(result.body.every((price: unknown) => typeof price === "number" && price > 0), "Market prices must be positive numbers");
	return { durationMs: result.durationMs, detail: { count: result.body.length } };
});
await check("market cached repeat", async () => {
	const result = await requestJson(marketPath, { method: "POST", headers: { "Content-Type": "application/json" }, body: marketBody });
	assert(Array.isArray(result.body) && result.body.every((price: unknown) => typeof price === "number" && price > 0), "Cached market response is invalid");
	return { durationMs: result.durationMs };
});

await check("EVM gas", async () => {
	const result = await requestJson("/api/v1/evm/gas-price/eip155:1");
	assert(typeof result.body?.average === "number" && result.body.average >= 0, "Gas response has no average Gwei value");
	return { durationMs: result.durationMs };
});

await check("EVM supported network matrix", async () => {
	const started = performance.now();
	const networks = ["eip155:1", "eip155:10", "eip155:56", "eip155:100", "eip155:137", "eip155:143", "eip155:999", "eip155:8453", "eip155:4663", "eip155:42161", "eip155:43114"];
	for (const networkId of networks) {
		const result = await requestJson(`/api/v1/evm/gas-price/${networkId}`);
		assert(typeof result.body?.average === "number" && result.body.average >= 0, `${networkId} returned an invalid gas price`);
	}
	return { durationMs: Math.round((performance.now() - started) * 100) / 100, detail: { networks } };
});

await check("EVM pending nonce", async () => {
	const result = await requestJson(`/api/v1/evm/nonce/eip155:1/${fixtureAddress}`);
	assert(Number.isSafeInteger(result.body?.nonce) && result.body.nonce >= 0, "Nonce is not a non-negative safe integer");
	return { durationMs: result.durationMs };
});

await check("EVM native balance", async () => {
	const result = await requestJson(`/api/v1/evm/balance/eip155:1/${fixtureAddress}`);
	assert(typeof result.body?.balance === "string" && /^\d+(\.\d+)?$/.test(result.body.balance), "Native balance is not a decimal string");
	return { durationMs: result.durationMs };
});

await check("ERC-20 decimals", async () => {
	const result = await requestJson(`/api/v1/evm/token/decimals/eip155:1/${usdcContract}`);
	assert(result.body?.decimals === 6, "Ethereum USDC must report 6 decimals");
	return { durationMs: result.durationMs };
});

await check("ERC-20 balance", async () => {
	const result = await requestJson(`/api/v1/evm/token/balance/eip155:1/${fixtureAddress}/${usdcContract}`);
	assert(typeof result.body?.balance === "string" && /^\d+(\.\d+)?$/.test(result.body.balance), "Token balance is not a decimal string");
	return { durationMs: result.durationMs };
});

const bitcoinNetwork = "bip122:000000000019d6689c085ae165831e93";
const publicBitcoinXpub = "xpub6BxKtd6aAuz23XqtWXeSqxShJZn8yqiUmaTdvsPWS3riKkNRcXEPmn1CXmKM1M43mrWfN5QwjdLRghZLrgwMLCeRZqZNuYhVNXr6Pp7aDsH";
const publicFixtureTransaction = "855654b8b1f964eb06e06ce52aa0f29a4ffb34faedcd9bae748880c878131ad2";

await check("Bitcoin public-key discovery", async () => {
	const result = await requestJson(`/api/v1/utxo/pubkey-info/${bitcoinNetwork}/${publicBitcoinXpub}`);
	assert(typeof result.body?.balance === "string" && Array.isArray(result.body?.tokens), "Bitcoin xpub discovery shape is invalid");
	assert(result.body.tokens.some((token: any) => typeof token?.path === "string" && typeof token?.name === "string"), "Bitcoin discovery returned no address paths");
	return { durationMs: result.durationMs, detail: { derivedAddresses: result.body.tokens.length } };
});

await check("Bitcoin unspent outputs", async () => {
	const result = await requestJson(`/api/v1/utxo/unspent/${bitcoinNetwork}/${publicBitcoinXpub}`);
	assert(Array.isArray(result.body), "Bitcoin UTXOs must be an array");
	return { durationMs: result.durationMs, detail: { count: result.body.length } };
});

await check("Bitcoin fee rates", async () => {
	const result = await requestJson(`/api/v1/utxo/fee-rate-by-network/${bitcoinNetwork}`);
	assert([result.body?.slow, result.body?.average, result.body?.fast].every((value) => typeof value === "number" && value > 0), "Bitcoin fee rates must be positive numbers");
	return { durationMs: result.durationMs };
});

await check("Bitcoin transaction lookup", async () => {
	const result = await requestJson(`/api/v1/utxo/lookup-alias/${bitcoinNetwork}/${publicFixtureTransaction}`);
	assert(result.body?.txid === publicFixtureTransaction && typeof result.body?.hex === "string", "Bitcoin transaction lookup is missing txid or raw hex");
	return { durationMs: result.durationMs };
});

await check("mixed BTC and EVM portfolio", async () => {
	const result = await requestJson("/api/v1/portfolio/balances", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			pubkeys: [
				{ caip: `${bitcoinNetwork}/slip44:0`, pubkey: publicBitcoinXpub },
				{ caip: "eip155:1/slip44:60", pubkey: fixtureAddress },
				{ caip: "eip155:8453/slip44:60", pubkey: fixtureAddress },
			],
			includeDefi: true,
		}),
	});
	assert(Array.isArray(result.body?.balances), "Portfolio balances must be an array");
	assert(result.body.balances.some((entry: any) => entry.caip === `${bitcoinNetwork}/slip44:0` && entry.pubkey === publicBitcoinXpub), "Portfolio omitted the requested Bitcoin xpub");
	assert(result.body.balances.some((entry: any) => entry.caip === "eip155:1/slip44:60" && entry.pubkey.toLowerCase() === fixtureAddress.toLowerCase()), "Portfolio omitted Ethereum native balance");
	assert(result.body.balances.some((entry: any) => entry.caip === "eip155:8453/slip44:60" && entry.pubkey.toLowerCase() === fixtureAddress.toLowerCase()), "Portfolio omitted Base native balance");
	assert(typeof result.body?.meta?.serverMs === "number" && result.body?.meta?.degraded === false, "Portfolio reported a degraded live response");
	assert(Array.isArray(result.body?.defiPositions), "includeDefi must return defiPositions");
	return { durationMs: result.durationMs, detail: { balances: result.body.balances.length, defiPositions: result.body.defiPositions.length } };
});

await check("Cosmos XRP and Solana portfolio", async () => {
	const result = await requestJson("/api/v1/portfolio/balances", {
		method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pubkeys: [
			{ caip: "cosmos:cosmoshub-4/slip44:118", pubkey: "cosmos1rs7fckgznkaxs4sq02pexwjgar43p5wn7akqnc" },
			{ caip: "ripple:4109c6f2045fc7eff4cde8f9905d19c2/slip44:144", pubkey: "rLRYvj3RXU16THYgwhWR3ZN639XAE68RLB" },
			{ caip: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501", pubkey: "2hYvcUnojGD5JfBtb3hStqFtU8GzFh2mToyxboPVu9MQ" },
		] }),
	});
	for (const caip of ["cosmos:cosmoshub-4/slip44:118", "ripple:4109c6f2045fc7eff4cde8f9905d19c2/slip44:144", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501"]) {
		assert(result.body?.balances?.some((entry: any) => entry.caip === caip && typeof entry.balance === "string"), `Portfolio omitted ${caip}`);
	}
	assert(result.body?.meta?.degraded === false, `Multichain portfolio degraded: ${JSON.stringify(result.body?.meta?.failures)}`);
	return { durationMs: result.durationMs, detail: { balances: result.body.balances.length } };
});

await check("Bitcoin xpub transaction history", async () => {
	const result = await requestJson("/api/v1/tx/history", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ queries: [{ caip: `${bitcoinNetwork}/slip44:0`, pubkey: publicBitcoinXpub }] }),
	});
	const history = result.body?.histories?.[0];
	assert(result.body?.success === true && Array.isArray(history?.transactions), "Bitcoin history envelope is invalid");
	assert(history.transactions.length > 0, "Known Bitcoin xpub returned no transactions");
	assert(history.transactions.every((tx: any) => typeof tx.txid === "string" && typeof tx.timestamp === "number" && Array.isArray(tx.from) && Array.isArray(tx.to)), "Bitcoin history contains malformed transactions");
	return { durationMs: result.durationMs, detail: { transactions: history.transactions.length } };
});

await check("EVM transaction history", async () => {
	const result = await requestJson("/api/v1/tx/history", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ queries: [
			{ caip: "eip155:1/slip44:60", pubkey: fixtureAddress },
			{ caip: "eip155:8453/slip44:60", pubkey: fixtureAddress },
		] }),
	});
	assert(result.body?.success === true && result.body.histories?.length === 2, "EVM history envelope is invalid");
	const transactions = result.body.histories.flatMap((history: any) => history.transactions || []);
	assert(transactions.length > 0, "Known EVM address returned no transactions");
	assert(transactions.every((tx: any) => /^0x[a-f0-9]{64}$/.test(tx.txid) && typeof tx.timestamp === "number"), "EVM history contains malformed transactions");
	return { durationMs: result.durationMs, detail: { ethereum: result.body.histories[0].transactions.length, base: result.body.histories[1].transactions.length } };
});

await check("Cosmos XRP and Solana transaction history", async () => {
	const result = await requestJson("/api/v1/tx/history", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ queries: [
			{ caip: "cosmos:cosmoshub-4/slip44:118", pubkey: "cosmos1rs7fckgznkaxs4sq02pexwjgar43p5wn7akqnc" },
			{ caip: "ripple:4109c6f2045fc7eff4cde8f9905d19c2/slip44:144", pubkey: "rLRYvj3RXU16THYgwhWR3ZN639XAE68RLB" },
			{ caip: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501", pubkey: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
		] }),
	});
	assert(result.body?.success === true && result.body.histories?.length === 3, "Multichain history envelope is invalid");
	for (const history of result.body.histories) {
		assert(Array.isArray(history.transactions), `${history.caip} history is not an array`);
		assert(history.transactions.every((tx: any) => typeof tx.txid === "string" && typeof tx.timestamp === "number"), `${history.caip} returned malformed transactions`);
	}
	assert(result.body.histories[0].transactions.length > 0, "Known Cosmos account returned no history");
	assert(result.body.histories[1].transactions.length > 0, "Known XRP account returned no history");
	assert(result.body.histories[2].transactions.length > 0, "Known Solana account returned no history");
	return { durationMs: result.durationMs, detail: { counts: result.body.histories.map((history: any) => ({ caip: history.caip, transactions: history.transactions.length })) } };
});

await check("Cosmos-family account sequences", async () => {
	const fixtures = [
		["cosmos", "cosmos1rs7fckgznkaxs4sq02pexwjgar43p5wn7akqnc"],
		["thorchain", "thor1g9el7lzjwh9yun2c4jjzhy09j98vkhfxfhgnzx"],
		["mayachain", "maya1g9el7lzjwh9yun2c4jjzhy09j98vkhfxfqkl5k"],
		["osmosis", "osmo1rs7fckgznkaxs4sq02pexwjgar43p5wnkx9s92"],
	] as const;
	const started = performance.now();
	for (const [network, address] of fixtures) {
		const result = await requestJson(`/api/v1/getAccountInfo/${network}/${address}`);
		assert(/^\d+$/.test(result.body?.account?.account_number) && /^\d+$/.test(result.body?.account?.sequence), `${network} returned invalid signing sequence data`);
	}
	return { durationMs: Math.round((performance.now() - started) * 100) / 100, detail: { networks: fixtures.map(([network]) => network) } };
});

await check("Cosmos staking positions", async () => {
	const result = await requestJson("/api/v1/staking/positions", {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ network: "cosmos", address: "cosmos1rs7fckgznkaxs4sq02pexwjgar43p5wn7akqnc" }),
	});
	assert(Array.isArray(result.body?.data), "Staking response is not a data array");
	assert(result.body.data.every((position: any) => typeof position.type === "string" && typeof position.balance === "string"), "Staking response contains malformed positions");
	return { durationMs: result.durationMs, detail: { positions: result.body.data.length } };
});

await check("THORName lookup and registration quote", async () => {
	const started = performance.now();
	const lookup = await requestJson("/api/v1/names/lookup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ network: "thorchain", name: "keepkey" }) });
	const quote = await requestJson("/api/v1/names/registration-quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ network: "thorchain" }) });
	assert(typeof lookup.body?.data?.found === "boolean", "THORName lookup omitted found state");
	assert(/^\d+$/.test(quote.body?.data?.registerFeeBase) && /^\d+$/.test(quote.body?.data?.feePerBlockBase) && quote.body?.data?.blocksPerYear > 0, "THORName quote is invalid");
	return { durationMs: Math.round((performance.now() - started) * 100) / 100, detail: { found: lookup.body.data.found } };
});

await check("XRP account signing state", async () => {
	const result = await requestJson("/api/v1/getAccountInfo/ripple/rLRYvj3RXU16THYgwhWR3ZN639XAE68RLB");
	assert(typeof result.body?.Balance === "string" && Number.isInteger(result.body?.Sequence) && Number.isInteger(result.body?.ledger_index_current), "XRP account state is invalid");
	return { durationMs: result.durationMs, detail: { ledgerIndex: result.body.ledger_index_current } };
});

const solanaFrom = "2hYvcUnojGD5JfBtb3hStqFtU8GzFh2mToyxboPVu9MQ";
const solanaTo = "11111111111111111111111111111111";
const solanaUsdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function assertKeepKeySolanaTransaction(body: any, expectedInstructions: number): void {
	assert(body?.success === true && typeof body?.serialized === "string" && typeof body?.blockhash === "string", "Solana builder response is invalid");
	const bytes = Buffer.from(body.serialized, "base64");
	assert(bytes[0] === 1 && bytes.subarray(1, 65).every((value) => value === 0), "Solana transaction is not in KeepKey dummy-signature format");
	assert(Transaction.from(bytes).instructions.length === expectedInstructions, `Solana transaction must contain ${expectedInstructions} instructions`);
}

await check("Solana native transaction build", async () => {
	const result = await requestJson("/api/v1/solana/build-transfer", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ from: solanaFrom, to: solanaTo, amount: "5000", memo: "vault-live-contract" }),
	});
	assertKeepKeySolanaTransaction(result.body, 2);
	return { durationMs: result.durationMs, detail: { bytes: Buffer.from(result.body.serialized, "base64").length } };
});

await check("Solana SPL transaction build", async () => {
	const result = await requestJson("/api/v1/solana/build-transfer-token", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ from: solanaFrom, to: solanaTo, token: solanaUsdc, amount: "1000000", decimals: 6, memo: "vault-live-contract" }),
	});
	assertKeepKeySolanaTransaction(result.body, result.body.needsCreateAta ? 3 : 2);
	return { durationMs: result.durationMs, detail: { bytes: Buffer.from(result.body.serialized, "base64").length, needsCreateAta: result.body.needsCreateAta } };
});

const health = await requestJson("/api/v1/health");
if (health.body?.zerion === "enabled") {
	await check("Zerion complex positions", async () => {
		const result = await requestJson(`/api/v1/zerion/positions/${fixtureAddress}`);
		assert(Array.isArray(result.body?.positions), "Zerion positions must be an array");
		return { durationMs: result.durationMs, detail: { count: result.body.positions.length } };
	});
} else {
	observations.push({ name: "Zerion complex positions", status: "skip", durationMs: 0, detail: { reason: "adapter disabled" } });
}

const report = {
	schemaVersion: 1,
	runAt: new Date().toISOString(),
	baseUrl,
	result: "pass",
	checks: observations,
};
await Bun.write("artifacts/live/latest.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n${observations.filter((item) => item.status === "pass").length} live checks passed; report: artifacts/live/latest.json`);
