/** Read-only contract preflight. It does not register clients, request quotes,
 * create watches, or sign/broadcast transactions. API coverage is only one gate.
 * bun container/live/migration-readiness.ts https://oracles.cc https://api.keepkey.com
 */
export const vaultOperations = [
 "Broadcast", "BuildSolanaTransfer", "BuildSolanaTransferToken", "CreatePendingSwap",
 "EvmReadRpc", "GetAccountInfo", "GetAvailableAssets", "GetBalanceAddressByNetwork",
 "GetFeeRate", "GetFeeRateByNetwork", "GetGasPriceByNetwork", "GetMarketInfo", "GetName",
 "GetNameRegistrationQuote", "GetNonceByNetwork", "GetPendingSwap", "GetPortfolioBalances",
 "GetPubkeyInfo", "GetStakingPositions", "GetTokenAllowance", "GetTokenBalance",
 "GetTokenDecimals", "GetTransactionHistory", "ListUnspent", "LookupTokenMetadata",
 "LookupTx", "LookupUtxoTx", "Quote", "SearchAssets", "UtxoLookup",
] as const;

export function inspectContract(origin: string, document: any) {
 const found = new Set<string>();
 for (const item of Object.values(document?.paths || {})) {
  for (const method of ["get", "post", "put", "patch", "delete", "head", "options"]) {
   const id = (item as any)?.[method]?.operationId;
   if (typeof id === "string") found.add(id);
  }
 }
 const expectedApiBase = `${origin.replace(/\/+$/, "")}/api/v1`;
 const advertised = document?.servers?.[0]?.url;
 const missingOperations = vaultOperations.filter(operation => !found.has(operation));
 return { expectedApiBase, advertisedApiBase: advertised ?? null, requiredOperations: vaultOperations.length,
  missingOperations, contractAvailable: advertised === expectedApiBase && missingOperations.length === 0 };
}

export async function inspectOrigin(origin: string, fetcher: typeof fetch = fetch) {
 const base = origin.replace(/\/+$/, "");
 try {
  const response = await fetcher(`${base}/spec/swagger.json`, { signal: AbortSignal.timeout(20_000), redirect: "error" });
  if (!response.ok) return { origin: base, contractAvailable: false, failure: `http_${response.status}` };
  return { origin: base, ...inspectContract(base, await response.json()) };
 } catch {
  // Network errors can include URLs/credentials. Report a bounded category only.
  return { origin: base, contractAvailable: false, failure: "unreachable_or_invalid_specification" };
 }
}

if (import.meta.main) {
 const origins = process.argv.slice(2);
 if (!origins.length) throw new Error("Provide one or more public API origins");
 const results = await Promise.all(origins.map(origin => inspectOrigin(origin)));
 console.log(JSON.stringify({ checkedAt: new Date().toISOString(), readOnly: true, results,
  remainingCutoverGates: ["pending-swap continuity", "authenticated read parity", "capacity and failover", "production TLS/DNS", "Desktop provider fallback cleanup"] }, null, 2));
 if (results.some(result => !result.contractAvailable)) process.exitCode = 1;
}
