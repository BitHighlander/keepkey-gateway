import { pathToFileURL } from "node:url";

const baseUrl = (process.argv.find((arg) => arg.startsWith("--url="))?.slice(6) || "http://127.0.0.1:12000").replace(/\/$/, "");
const modulePath = process.env.VAULT_PIONEER_CLIENT_PATH
	|| "/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault/node_modules/@pioneer-platform/pioneer-client/lib/index.js";
const { default: Pioneer } = await import(pathToFileURL(modulePath).href);
const queryKey = process.env.LIVE_QUERY_KEY || `vault:generated:${crypto.randomUUID()}:${crypto.randomUUID()}`;

const registration = await fetch(`${baseUrl}/api/v1/user/register`, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({ username: "vault-generated-client", queryKey }),
});
if (!registration.ok) throw new Error(`Registration failed: ${registration.status}`);

const client = new Pioneer(`${baseUrl}/spec/swagger.json`, {
	queryKey,
	timeout: 60_000,
	overrideHost: new URL(baseUrl).host,
});
const pioneer = await client.init();
const requiredMethods = [
	"RecordVaultPerformance", "CreateHiveAccount", "GetHiveAccount", "GetHiveUsernameAvailable", "GetHiveTxParams", "GetHiveHistory", "BroadcastHiveTx", "BroadcastHiveOps",
	"Quote", "CreatePendingSwap", "GetPendingSwap", "GetStakingPositions", "GetName", "GetNameRegistrationQuote", "SearchAssets", "GetAvailableAssets",
	"GetSupportedSwapChains", "GetSwapHealth", "GetMarketInfo", "GetPortfolioBalances", "GetTransactionHistory", "GetAccountInfo", "BuildSolanaTransfer",
	"BuildSolanaTransferToken", "GetGasPriceByNetwork", "GetNonceByNetwork", "GetBalanceAddressByNetwork", "GetTokenDecimals", "GetTokenBalance",
	"GetPubkeyInfo", "ListUnspent", "GetFeeRate", "GetFeeRateByNetwork", "LookupUtxoTx", "UtxoLookup", "Broadcast", "GetZerionPositions",
];
for (const method of requiredMethods) {
	if (typeof pioneer[method] !== "function") throw new Error(`Generated client omitted ${method}`);
}

const txHash = "0x2222222222222222222222222222222222222222222222222222222222221200";
const body = {
	txHash,
	addresses: [],
	sellAsset: { caip: "eip155:1/slip44:60", symbol: "ETH", amount: "0.01", amountBaseUnits: "10000000000000000", address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", networkId: "eip155:1" },
	buyAsset: { caip: "eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", amount: "25", amountBaseUnits: "25000000", address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", networkId: "eip155:1" },
	quote: { id: txHash, integration: "relay", expectedAmountOut: "25", minimumAmountOut: "24", fees: { affiliate: "0", protocol: "0", network: "0" }, slippage: 3 },
	integration: "relay",
	swapper: "Relay",
	relayData: { requestId: "generated-client-request" },
};

const created = await pioneer.CreatePendingSwap(body);
const fetched = await pioneer.GetPendingSwap({ txHash });
const createdSwap = created?.data || created;
const fetchedSwap = fetched?.data || fetched;
if (createdSwap?.status !== "pending" || fetchedSwap?.txHash !== txHash) throw new Error("Generated-client pending swap contract failed");
if (fetchedSwap?.relayData?.requestId !== "generated-client-request") throw new Error("Generated-client pending swap lost Relay metadata");

console.log(JSON.stringify({
	methodsVerified: requiredMethods.length,
	status: fetchedSwap.status,
	durable: createdSwap.createdAt === fetchedSwap.createdAt,
	relayMetadata: true,
}));
