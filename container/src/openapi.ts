export function openApiDocument(requestUrl: string): Record<string, unknown> {
	const url = new URL(requestUrl);
	return {
		openapi: "3.0.0",
		info: {
			title: "Pioneer v5",
			version: "0.1.0-local",
			description: "Consumer-driven KeepKey wallet gateway",
		},
		servers: [{ url: `${url.origin}/api/v1` }],
		components: {
			securitySchemes: {
				queryKey: { type: "apiKey", name: "Authorization", in: "header" },
			},
		},
		paths: {
			"/events/subscribe": {
				post: { operationId: "SubscribeEvents", security: [{ queryKey: [] }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["addresses"], properties: { addresses: { type: "array", minItems: 1, maxItems: 200, items: { type: "object", required: ["address", "networkId"] } }, events: { type: "array", items: { type: "string", enum: ["tx:incoming", "tx:confirmed"] } } } } } } }, responses: { 200: { description: "Authenticated event stream" }, 401: { description: "Unauthorized" } } },
			},
			"/telemetry/vault": {
				post: { operationId: "RecordVaultPerformance", security: [{ queryKey: [] }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["records"], properties: { records: { type: "array", maxItems: 100, items: { type: "object" } } } } } } }, responses: { 200: { description: "Accepted telemetry count" }, 401: { description: "Unauthorized" } } },
			},
			"/hive/account/{pubkey}": {
				get: { operationId: "GetHiveAccount", parameters: [pathParameter("pubkey")], responses: providerResponses("Hive account resolved from an STM public key") },
			},
			"/hive/username-available/{name}": {
				get: { operationId: "GetHiveUsernameAvailable", parameters: [pathParameter("name")], responses: providerResponses("Hive username availability") },
			},
			"/hive/create-account": {
				post: { operationId: "CreateHiveAccount", security: [{ queryKey: [] }], requestBody: { required: true, content: { "application/json": { schema: objectBody(["username", "ownerKey", "activeKey", "postingKey", "memoKey", "attestation", "ethAddress", "ethSignature"]) } } }, responses: providerResponses("Create an attested, ETH-gated sponsored Hive account") },
			},
			"/hive/tx-params": {
				get: { operationId: "GetHiveTxParams", responses: providerResponses("Current Hive TaPoS signing parameters") },
			},
			"/hive/history/{account}": {
				get: { operationId: "GetHiveHistory", parameters: [pathParameter("account")], responses: providerResponses("Recent Hive transfers") },
			},
			"/hive/broadcast": {
				post: { operationId: "BroadcastHiveTx", requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } }, responses: providerResponses("Broadcast a signed Hive transfer") },
			},
			"/hive/broadcast-ops": {
				post: { operationId: "BroadcastHiveOps", requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } }, responses: providerResponses("Broadcast signed Hive operations") },
			},
			"/staking/positions": {
				post: { operationId: "GetStakingPositions", security: [{ queryKey: [] }], requestBody: { required: true, content: { "application/json": { schema: objectBody(["network", "address"]) } } }, responses: providerResponses("Current Cosmos staking positions") },
			},
			"/names/lookup": {
				post: { operationId: "GetName", security: [{ queryKey: [] }], requestBody: { required: true, content: { "application/json": { schema: objectBody(["network", "name"]) } } }, responses: providerResponses("THORName or MAYAName record") },
			},
			"/names/registration-quote": {
				post: { operationId: "GetNameRegistrationQuote", security: [{ queryKey: [] }], requestBody: { required: true, content: { "application/json": { schema: objectBody(["network"]) } } }, responses: providerResponses("Live name registration constants") },
			},
			"/swaps/pending": {
				post: {
					operationId: "CreatePendingSwap",
					security: [{ queryKey: [] }],
					requestBody: { required: true, content: { "application/json": { schema: pendingSwapCreateSchema() } } },
					responses: { 201: { description: "Pending swap registered idempotently" }, 400: { description: "Invalid swap" }, 401: { description: "Unauthorized" } },
				},
			},
			"/swaps/pending/{txHash}": {
				get: {
					operationId: "GetPendingSwap",
					security: [{ queryKey: [] }],
					parameters: [pathParameter("txHash"), { name: "rescan", in: "query", required: false, schema: { type: "boolean", default: false } }],
					responses: { 200: { description: "Durable pending swap state" }, 401: { description: "Unauthorized" }, 404: { description: "Pending swap not found" } },
				},
				put: {
					operationId: "UpdatePendingSwap",
					security: [{ queryKey: [] }],
					parameters: [pathParameter("txHash")],
					requestBody: { required: true, content: { "application/json": { schema: {
						type: "object",
						required: ["relayData"],
						properties: { relayData: { type: "object", required: ["requestId"], properties: { requestId: { type: "string" } } } },
					} } } },
					responses: { 200: { description: "Updated pending swap state" }, 400: { description: "Only relayData.requestId can be updated" }, 401: { description: "Unauthorized" }, 404: { description: "Pending swap not found" } },
				},
			},
			"/quote": {
				post: {
					operationId: "Quote",
					security: [{ queryKey: [] }],
					requestBody: { required: true, content: { "application/json": { schema: {
						type: "object",
						required: ["sellAsset", "sellAmount", "buyAsset", "recipientAddress", "senderAddress"],
						properties: {
							sellAsset: { type: "string" }, sellAmount: { type: "string" }, buyAsset: { type: "string" },
							recipientAddress: { type: "string" }, senderAddress: { type: "string" }, slippage: { type: "number" }, memoless: { type: "boolean" },
						},
					} } } },
					responses: providerResponses("Independent executable swap quotes, best first"),
				},
			},
			"/discovery/search": {
				get: {
					operationId: "SearchAssets",
					security: [{ queryKey: [] }],
					parameters: [
						{ name: "q", in: "query", required: true, schema: { type: "string" } },
						{ name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 2000, default: 50 } },
					],
					responses: { 200: { description: "Pinned discovery asset matches" }, 400: { description: "Invalid search" }, 401: { description: "Unauthorized" } },
				},
			},
			"/swap/available-assets": {
				get: { operationId: "GetAvailableAssets", security: [{ queryKey: [] }], responses: { 200: { description: "Pinned swappable asset allowlist" }, 401: { description: "Unauthorized" } } },
			},
			"/swappers/supported-chains": {
				get: { operationId: "GetSupportedSwapChains", responses: { 200: { description: "Pinned provider chain coverage" } } },
			},
			"/swap/health": {
				get: { operationId: "GetSwapHealth", responses: { 200: { description: "Demand-driven swap integration health" } } },
			},
			"/health": {
				get: { operationId: "GetHealth", responses: { 200: { description: "Ready" }, 503: { description: "Not ready" } } },
			},
			"/ready": {
				get: { operationId: "GetReadiness", responses: { 200: { description: "Ready" }, 503: { description: "Not ready" } } },
			},
			"/user/register": {
				post: {
					operationId: "RegisterUser",
					requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
					responses: { 200: { description: "Registered" }, 400: { description: "Invalid body" } },
				},
			},
			"/market/info": {
				post: {
					operationId: "GetMarketInfo",
					security: [{ queryKey: [] }],
					requestBody: { required: true, content: { "application/json": { schema: { type: "array", items: { type: "string" } } } } },
					responses: { 200: { description: "USD prices in input order", content: { "application/json": { schema: { type: "array", items: { type: "number" } } } } }, 401: { description: "Unauthorized" } },
				},
			},
			"/portfolio/balances": {
				post: {
					operationId: "GetPortfolioBalances",
					security: [{ queryKey: [] }],
					parameters: [{ name: "forceRefresh", in: "query", required: false, schema: { type: "boolean" } }],
					requestBody: {
						required: true,
						content: {
							"application/json": {
								schema: {
									type: "object",
									required: ["pubkeys"],
									properties: {
										pubkeys: {
											type: "array",
											minItems: 1,
											maxItems: 100,
											items: { type: "object", required: ["caip", "pubkey"], properties: { caip: { type: "string" }, pubkey: { type: "string" } } },
										},
										includeDefi: { type: "boolean" },
										extraContracts: {
											type: "array",
											maxItems: 20,
											items: {
												type: "object",
												required: ["networkId", "contractAddress", "decimals"],
												properties: {
													networkId: { type: "string" },
													contractAddress: { type: "string" },
													decimals: { type: "integer" },
													symbol: { type: "string" },
													name: { type: "string" },
													icon: { type: "string" },
												},
											},
										},
									},
								},
							},
						},
					},
					responses: providerResponses("Cross-chain wallet portfolio"),
				},
			},
			"/tx/history": {
				post: {
					operationId: "GetTransactionHistory",
					security: [{ queryKey: [] }],
					parameters: [{ name: "forceRefresh", in: "query", required: false, schema: { type: "boolean" } }],
					requestBody: {
						required: true,
						content: { "application/json": { schema: {
							type: "object",
							required: ["queries"],
							properties: {
								queries: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", required: ["caip", "pubkey"], properties: { caip: { type: "string" }, pubkey: { type: "string" } } } },
								page: { type: "integer", minimum: 1 },
							},
						} } },
					},
					responses: providerResponses("Demand-driven transaction history"),
				},
			},
			"/getAccountInfo/{network}/{address}": {
				get: {
					operationId: "GetAccountInfo",
					security: [{ queryKey: [] }],
					parameters: [pathParameter("network"), pathParameter("address")],
					responses: providerResponses("Current account number, sequence, and chain state"),
				},
			},
			"/solana/build-transfer": {
				post: {
					operationId: "BuildSolanaTransfer",
					security: [{ queryKey: [] }],
					requestBody: { required: true, content: { "application/json": { schema: solanaTransferSchema(false) } } },
					responses: providerResponses("KeepKey-signable native Solana transaction"),
				},
			},
			"/solana/build-transfer-token": {
				post: {
					operationId: "BuildSolanaTransferToken",
					security: [{ queryKey: [] }],
					requestBody: { required: true, content: { "application/json": { schema: solanaTransferSchema(true) } } },
					responses: providerResponses("KeepKey-signable SPL token transaction"),
				},
			},
			"/evm/gas-price/{networkId}": {
				get: { operationId: "GetGasPriceByNetwork", security: [{ queryKey: [] }], parameters: [pathParameter("networkId")], responses: providerResponses("Gas price in Gwei") },
			},
			"/evm/nonce/{networkId}/{address}": {
				get: { operationId: "GetNonceByNetwork", security: [{ queryKey: [] }], parameters: [pathParameter("networkId"), pathParameter("address")], responses: providerResponses("Pending transaction nonce") },
			},
			"/evm/balance/{networkId}/{address}": {
				get: { operationId: "GetBalanceAddressByNetwork", security: [{ queryKey: [] }], parameters: [pathParameter("networkId"), pathParameter("address")], responses: providerResponses("Native balance") },
			},
			"/evm/token/decimals/{networkId}/{contractAddress}": {
				get: { operationId: "GetTokenDecimals", security: [{ queryKey: [] }], parameters: [pathParameter("networkId"), pathParameter("contractAddress")], responses: providerResponses("ERC-20 decimals") },
			},
			"/evm/token/balance/{networkId}/{address}/{contractAddress}": {
				get: { operationId: "GetTokenBalance", security: [{ queryKey: [] }], parameters: [pathParameter("networkId"), pathParameter("address"), pathParameter("contractAddress")], responses: providerResponses("ERC-20 balance") },
			},
			"/evm/rpc": {
				post: {
					operationId: "EvmReadRpc",
					security: [{ queryKey: [] }],
					requestBody: { required: true, content: { "application/json": { schema: {
						type: "object",
						required: ["networkId", "method", "params"],
						properties: {
							networkId: { type: "string", pattern: "^eip155:[1-9][0-9]*$" },
							method: { type: "string", enum: ["eth_call", "eth_estimateGas", "eth_feeHistory", "eth_getCode", "eth_blockNumber", "eth_simulateV1", "debug_traceCall"] },
							params: { type: "array", items: {} },
						},
					} } } },
					responses: { ...providerResponses("{ success: true, data: <raw JSON-RPC result> }"), 400: { description: "Invalid network, disallowed method, or params not an array" } },
				},
			},
			"/evm/lookup/{networkId}/{txid}": {
				get: { operationId: "LookupTx", security: [{ queryKey: [] }], parameters: [pathParameter("networkId"), pathParameter("txid")], responses: providerResponses("{ success: true, data: { tx, receipt } }; receipt is null until mined") },
			},
			"/evm/token/lookup": {
				post: {
					operationId: "LookupTokenMetadata",
					security: [{ queryKey: [] }],
					requestBody: { required: true, content: { "application/json": { schema: objectBody(["networkId", "contractAddress"]) } } },
					responses: providerResponses("{ success: true, data: { name, symbol, decimals, contractAddress, networkId, chainId, caip } }; 422 when not an ERC-20 here"),
				},
			},
			"/evm/token/allowance/{networkId}/{contractAddress}/{ownerAddress}/{spenderAddress}": {
				get: {
					operationId: "GetTokenAllowance",
					security: [{ queryKey: [] }],
					parameters: [pathParameter("networkId"), pathParameter("contractAddress"), pathParameter("ownerAddress"), pathParameter("spenderAddress")],
					responses: providerResponses("{ success: true, data: { allowance, owner, spender, token } }; allowance in base units"),
				},
			},
			"/utxo/pubkey-info/{network}/{xpub}": {
				get: { operationId: "GetPubkeyInfo", security: [{ queryKey: [] }], parameters: [pathParameter("network"), pathParameter("xpub")], responses: providerResponses("Blockbook public-key discovery") },
			},
			"/utxo/unspent/{network}/{xpub}": {
				get: { operationId: "ListUnspent", security: [{ queryKey: [] }], parameters: [pathParameter("network"), pathParameter("xpub")], responses: providerResponses("Signing-ready unspent outputs") },
			},
			"/utxo/fee-rate/{networkId}": {
				get: { operationId: "GetFeeRate", security: [{ queryKey: [] }], parameters: [pathParameter("networkId")], responses: providerResponses("UTXO fee rates in sat/vByte") },
			},
			"/utxo/fee-rate-by-network/{networkId}": {
				get: { operationId: "GetFeeRateByNetwork", security: [{ queryKey: [] }], parameters: [pathParameter("networkId")], responses: providerResponses("UTXO fee-rate compatibility alias") },
			},
			"/utxo/lookup/{networkId}/{txid}": {
				get: { operationId: "LookupUtxoTx", security: [{ queryKey: [] }], parameters: [pathParameter("networkId"), pathParameter("txid")], responses: providerResponses("UTXO transaction details") },
			},
			"/utxo/lookup-alias/{networkId}/{txid}": {
				get: { operationId: "UtxoLookup", security: [{ queryKey: [] }], parameters: [pathParameter("networkId"), pathParameter("txid")], responses: providerResponses("Vault UTXO lookup alias") },
			},
			"/broadcast": {
				post: {
					operationId: "Broadcast",
					security: [{ queryKey: [] }],
					requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["networkId", "serialized"], properties: { networkId: { type: "string" }, serialized: { type: "string" } } } } } },
					responses: providerResponses("Broadcast a signed EVM/UTXO hex or Cosmos/XRP/Solana base64 transaction"),
				},
			},
			"/zerion/positions/{address}": {
				get: {
					operationId: "GetZerionPositions",
					security: [{ queryKey: [] }],
					parameters: [pathParameter("address")],
					responses: { 200: { description: "Normalized DeFi positions" }, 401: { description: "Unauthorized" }, 503: { description: "Zerion disabled" } },
				},
			},
		},
	};
}

function pathParameter(name: string): Record<string, unknown> {
	return { name, in: "path", required: true, schema: { type: "string" } };
}

function providerResponses(description: string): Record<string, unknown> {
	return {
		200: { description },
		401: { description: "Unauthorized" },
		422: { description: "Unsupported network" },
		502: { description: "Upstream provider failure" },
		503: { description: "Provider disabled" },
	};
}

function solanaTransferSchema(token: boolean): Record<string, unknown> {
	return {
		type: "object",
		required: token ? ["from", "to", "amount", "token", "decimals"] : ["from", "to", "amount"],
		properties: {
			from: { type: "string" },
			to: { type: "string" },
			amount: { type: "string", pattern: "^[0-9]+$" },
			memo: { type: "string", maxLength: 512 },
			...(token ? { token: { type: "string" }, decimals: { type: "integer", minimum: 0, maximum: 255 } } : {}),
		},
	};
}

function pendingSwapCreateSchema(): Record<string, unknown> {
	const asset = {
		type: "object",
		required: ["caip", "symbol", "amount", "amountBaseUnits", "address", "networkId"],
		properties: {
			caip: { type: "string" }, symbol: { type: "string" }, amount: { type: "string" },
			amountBaseUnits: { type: "string" }, address: { type: "string" }, networkId: { type: "string" },
		},
	};
	return {
		type: "object",
		required: ["txHash", "addresses", "sellAsset", "buyAsset", "quote", "integration"],
		properties: {
			txHash: { type: "string" }, addresses: { type: "array", items: { type: "string" } },
			sellAsset: asset, buyAsset: asset, quote: { type: "object" }, integration: { type: "string" },
			swapper: { type: "string" }, invocationId: { type: "string" }, relayData: { type: "object" }, nearIntentsData: { type: "object" },
		},
	};
}

function objectBody(required: string[]): Record<string, unknown> {
	return { type: "object", required, properties: Object.fromEntries(required.map((field) => [field, { type: "string" }])) };
}
