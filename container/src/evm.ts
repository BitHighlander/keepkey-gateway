import { DemandCache } from "./demand-cache";
import type { PersistentCache } from "./cache";

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const EVM_TX_HASH = /^0x[a-fA-F0-9]{64}$/;
const RPC_TIMEOUT_MS = 12_000;

/** JSON-RPC methods a wallet may run on Pioneer's nodes to preview a
 * transaction. Nothing that writes, signs, or reads private node state. */
export const READ_RPC_METHODS: ReadonlySet<string> = new Set(["eth_call", "eth_getCode", "eth_blockNumber", "eth_simulateV1"]);

const RPC_ENDPOINTS: Readonly<Record<string, string>> = {
	"eip155:1": "https://eth.nownodes.io/",
	"eip155:10": "https://optimism.nownodes.io/",
	"eip155:56": "https://bsc.nownodes.io/",
	"eip155:137": "https://matic.nownodes.io/",
	"eip155:8453": "https://base.nownodes.io/",
	"eip155:42161": "https://arbitrum.nownodes.io/",
	"eip155:43114": "https://avax.nownodes.io/ext/bc/C/rpc",
	"eip155:100": "https://rpc.gnosischain.com",
	"eip155:143": "https://rpc.monad.xyz/",
	"eip155:999": "https://rpc.hyperliquid.xyz/evm",
	"eip155:4663": "https://rpc.mainnet.chain.robinhood.com",
};

interface EvmClientOptions {
	apiKey: string;
	cache: PersistentCache;
	fetch?: typeof fetch;
	endpoints?: Readonly<Record<string, string>>;
}

interface JsonRpcResponse {
	id?: number;
	result?: unknown;
	error?: { code?: number; message?: string };
}

export class EvmError extends Error {
	/** nodeError: the node answered with a JSON-RPC error (e.g. a revert), as
	 * opposed to a transport or provider failure. */
	constructor(message: string, public readonly status = 502, public readonly nodeError = false) {
		super(message);
	}
}

export interface TokenMetadata {
	name: string | null;
	symbol: string;
	decimals: number;
}

function requireAddress(value: string, label: string): string {
	if (!EVM_ADDRESS.test(value)) throw new EvmError(`Invalid ${label} address`, 400);
	return value.toLowerCase();
}

function parseQuantity(value: unknown, label: string): bigint {
	if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) {
		throw new EvmError(`Invalid ${label} returned by EVM node`);
	}
	return BigInt(value);
}

export function formatUnits(value: bigint, decimals: number): string {
	if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new EvmError("Invalid token decimals returned by EVM node");
	if (decimals === 0) return value.toString();
	const raw = value.toString().padStart(decimals + 1, "0");
	const whole = raw.slice(0, -decimals);
	const fraction = raw.slice(-decimals).replace(/0+$/, "");
	return fraction ? `${whole}.${fraction}` : whole;
}

/** Decodes an ABI `string` return, or a `bytes32` one (e.g. MKR's symbol()). */
function decodeAbiString(hex: string): string | null {
	const raw = hex.slice(2);
	let text: string;
	if (raw.length === 64) {
		text = Buffer.from(raw, "hex").toString("utf8");
	} else {
		if (raw.length < 128 || raw.length % 2 !== 0) return null;
		const offset = Number(BigInt(`0x${raw.slice(0, 64)}`)) * 2;
		if (offset + 64 > raw.length) return null;
		const length = Number(BigInt(`0x${raw.slice(offset, offset + 64)}`)) * 2;
		if (offset + 64 + length > raw.length) return null;
		text = Buffer.from(raw.slice(offset + 64, offset + 64 + length), "hex").toString("utf8");
	}
	const trimmed = text.replace(/\0+$/, "").trim();
	return trimmed || null;
}

function abiAddress(address: string): string {
	return address.slice(2).padStart(64, "0");
}

export class EvmClient {
	private readonly fetcher: typeof fetch;
	private readonly endpoints: Readonly<Record<string, string>>;
	private readonly cache: DemandCache;
	private readonly validatedNetworks = new Set<string>();
	private readonly inFlight = new Map<string, Promise<unknown>>();
	private requestId = 0;

	constructor(private readonly options: EvmClientOptions) {
		this.fetcher = options.fetch || fetch;
		this.endpoints = options.endpoints || RPC_ENDPOINTS;
		this.cache = new DemandCache(options.cache);
	}

	async getGasPrice(networkId: string): Promise<{ average: number; fast: number; fastest: number }> {
		return this.cache.get({ namespace: "evm_gas", key: networkId, freshForMs: 15_000, staleForMs: 60_000, source: "nownodes" }, async () => {
			const wei = parseQuantity(await this.rpc(networkId, "eth_gasPrice", []), "gas price");
			const average = Number(formatUnits(wei, 9));
			if (!Number.isFinite(average) || average < 0) throw new EvmError("Invalid gas price returned by EVM node");
			return { average, fast: average * 1.2, fastest: average * 1.5 };
		});
	}

	async getNonce(networkId: string, address: string): Promise<{ nonce: number }> {
		const normalized = requireAddress(address, "wallet");
		return this.cache.get({ namespace: "evm_nonce", key: `${networkId}:${normalized}`, freshForMs: 2_000, staleForMs: 2_000, source: "nownodes" }, async () => {
			const value = parseQuantity(await this.rpc(networkId, "eth_getTransactionCount", [normalized, "pending"]), "nonce");
			if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new EvmError("EVM nonce exceeds JavaScript safe integer range");
			return { nonce: Number(value) };
		});
	}

	async getBalance(networkId: string, address: string): Promise<{ balance: string }> {
		const normalized = requireAddress(address, "wallet");
		return this.cache.get({ namespace: "evm_balance", key: `${networkId}:${normalized}`, freshForMs: 8_000, staleForMs: 60_000, source: "nownodes" }, async () => {
			const value = parseQuantity(await this.rpc(networkId, "eth_getBalance", [normalized, "latest"]), "balance");
			return { balance: formatUnits(value, 18) };
		});
	}

	async getTokenDecimals(networkId: string, contractAddress: string): Promise<{ decimals: number }> {
		const contract = requireAddress(contractAddress, "contract");
		return this.cache.get({ namespace: "evm_token_decimals", key: `${networkId}:${contract}`, freshForMs: 24 * 60 * 60_000, staleForMs: 7 * 24 * 60 * 60_000, source: "nownodes" }, async () => {
			const result = parseQuantity(await this.rpc(networkId, "eth_call", [{ to: contract, data: "0x313ce567" }, "latest"]), "token decimals");
			if (result > 255n) throw new EvmError("Invalid token decimals returned by contract");
			return { decimals: Number(result) };
		});
	}

	async getTokenBalance(networkId: string, address: string, contractAddress: string): Promise<{ balance: string }> {
		const wallet = requireAddress(address, "wallet");
		const contract = requireAddress(contractAddress, "contract");
		return this.cache.get({ namespace: "evm_token_balance", key: `${networkId}:${wallet}:${contract}`, freshForMs: 8_000, staleForMs: 60_000, source: "nownodes" }, async () => {
			const [{ decimals }, rawBalance] = await Promise.all([
				this.getTokenDecimals(networkId, contract),
				this.rpc(networkId, "eth_call", [{ to: contract, data: `0x70a08231${wallet.slice(2).padStart(64, "0")}` }, "latest"]),
			]);
			return { balance: formatUnits(parseQuantity(rawBalance, "token balance"), decimals) };
		});
	}

	async broadcast(networkId: string, rawTransaction: string): Promise<{ success: true; txid: string }> {
		const serialized = rawTransaction.startsWith("0x") ? rawTransaction.toLowerCase() : `0x${rawTransaction.toLowerCase()}`;
		if (!/^0x[a-f0-9]+$/.test(serialized) || serialized.length % 2 !== 0 || serialized.length > 2_000_002) {
			throw new EvmError("Invalid serialized EVM transaction hex", 400);
		}
		// A broadcast is irreversible. Validate the configured endpoint before the
		// first send even though ordinary reads combine validation into one batch.
		if (!this.validatedNetworks.has(networkId)) await this.rpc(networkId, "eth_chainId", []);
		const result = await this.rpc(networkId, "eth_sendRawTransaction", [serialized]);
		if (typeof result !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(result)) throw new EvmError("EVM broadcast returned no transaction id");
		return { success: true, txid: result };
	}

	/** Read-only JSON-RPC passthrough (EvmReadRpc). Returns the node's raw result. */
	async readRpc(networkId: unknown, method: unknown, params: unknown): Promise<{ success: true; data: unknown }> {
		if (typeof networkId !== "string" || !/^eip155:[1-9]\d*$/.test(networkId)) throw new EvmError(`Invalid EVM network: ${String(networkId)}`, 400);
		if (typeof method !== "string" || !READ_RPC_METHODS.has(method)) throw new EvmError(`Method not allowed: ${String(method)}`, 400);
		if (!Array.isArray(params)) throw new EvmError("params must be an array", 400);
		// Results depend on the current block, so concurrent identical calls share
		// one upstream request and nothing is kept after it settles.
		const data = await this.singleflight(`rpc:${networkId}:${method}:${JSON.stringify(params)}`, () => this.nodeCall(networkId, method, params));
		return { success: true, data };
	}

	/** Transaction and receipt (LookupTx); receipt is null until mined. */
	async lookupTransaction(networkId: string, txid: string): Promise<{ success: true; data: { tx: unknown; receipt: unknown } }> {
		if (!EVM_TX_HASH.test(txid)) throw new EvmError("Invalid EVM transaction hash", 400);
		const hash = txid.toLowerCase();
		const [tx, receipt] = await this.singleflight(`lookup:${networkId}:${hash}`, () => Promise.all([
			this.rpc(networkId, "eth_getTransactionByHash", [hash]),
			this.rpc(networkId, "eth_getTransactionReceipt", [hash]),
		]));
		return { success: true, data: { tx, receipt } };
	}

	/** ERC-20 name/symbol/decimals (LookupTokenMetadata). A contract without
	 * symbol() or decimals() is refused, never given placeholder values. */
	async getTokenMetadata(networkId: string, contractAddress: string): Promise<{ success: true; data: TokenMetadata & { contractAddress: string; networkId: string; chainId: number; caip: string } }> {
		const contract = requireAddress(contractAddress, "contract");
		this.endpoint(networkId);
		const metadata = await this.cache.get({ namespace: "evm_token_metadata", key: `${networkId}:${contract}`, freshForMs: 24 * 60 * 60_000, staleForMs: 7 * 24 * 60 * 60_000, source: "nownodes" }, async (): Promise<TokenMetadata> => {
			const [decimalsHex, symbolHex, nameHex] = await Promise.all([
				this.contractCall(networkId, contract, "0x313ce567", "decimals()"),
				this.contractCall(networkId, contract, "0x95d89b41", "symbol()"),
				// name() is optional in ERC-20; only a contract-level failure means absent.
				this.contractCall(networkId, contract, "0x06fdde03", "name()").catch((error) => {
					if (error instanceof EvmError && error.status === 422) return "0x";
					throw error;
				}),
			]);
			if (decimalsHex.length !== 66) throw new EvmError(`decimals() at ${contract} is not an ERC-20 uint8`, 422);
			const decimals = BigInt(decimalsHex);
			if (decimals > 255n) throw new EvmError(`decimals() at ${contract} is out of range`, 422);
			const symbol = decodeAbiString(symbolHex);
			if (!symbol) throw new EvmError(`symbol() at ${contract} returned no token symbol`, 422);
			return { name: nameHex === "0x" ? null : decodeAbiString(nameHex), symbol, decimals: Number(decimals) };
		});
		const chainId = Number(networkId.slice("eip155:".length));
		return { success: true, data: { ...metadata, contractAddress: contract, networkId, chainId, caip: `${networkId}/erc20:${contract}` } };
	}

	/** ERC-20 allowance(owner, spender) in base units (GetTokenAllowance). */
	async getTokenAllowance(networkId: string, contractAddress: string, ownerAddress: string, spenderAddress: string): Promise<{ success: true; data: { allowance: string; owner: string; spender: string; token: string } }> {
		const token = requireAddress(contractAddress, "contract");
		const owner = requireAddress(ownerAddress, "owner");
		const spender = requireAddress(spenderAddress, "spender");
		const raw = await this.singleflight(`allowance:${networkId}:${token}:${owner}:${spender}`, () => this.contractCall(networkId, token, `0xdd62ed3e${abiAddress(owner)}${abiAddress(spender)}`, "allowance()"));
		if (raw.length !== 66) throw new EvmError(`allowance() at ${token} did not return a uint256`, 422);
		return { success: true, data: { allowance: BigInt(raw).toString(), owner, spender, token } };
	}

	private singleflight<T>(key: string, task: () => Promise<T>): Promise<T> {
		const running = this.inFlight.get(key) as Promise<T> | undefined;
		if (running) return running;
		const request = task().finally(() => this.inFlight.delete(key));
		this.inFlight.set(key, request);
		return request;
	}

	/** A node-answered JSON-RPC error (a revert, an unsupported method) is the
	 * caller's 422, not a provider outage. */
	private async nodeCall(networkId: string, method: string, params: unknown[]): Promise<unknown> {
		try {
			return await this.rpc(networkId, method, params);
		} catch (error) {
			if (error instanceof EvmError && error.nodeError) throw new EvmError(error.message, 422);
			throw error;
		}
	}

	/** eth_call against a contract at latest; empty return data is a 422. */
	private async contractCall(networkId: string, contract: string, data: string, label: string): Promise<string> {
		const result = await this.nodeCall(networkId, "eth_call", [{ to: contract, data }, "latest"]);
		if (typeof result !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(result)) throw new EvmError(`Invalid ${label} result returned by EVM node`);
		if (result === "0x") throw new EvmError(`${label} at ${contract} returned no data; not an ERC-20 contract on this network`, 422);
		return result.toLowerCase();
	}

	private endpoint(networkId: string): string {
		if (!/^eip155:[1-9][0-9]*$/.test(networkId)) throw new EvmError(`Unsupported EVM network: ${networkId}`, 422);
		const endpoint = this.endpoints[networkId];
		if (!endpoint) throw new EvmError(`Unsupported EVM network: ${networkId}`, 422);
		return endpoint;
	}

	private async rpc(networkId: string, method: string, params: unknown[]): Promise<unknown> {
		const endpoint = this.endpoint(networkId);
		const callId = ++this.requestId;
		const shouldValidate = !this.validatedNetworks.has(networkId);
		const validationId = shouldValidate ? ++this.requestId : undefined;
		const call = { jsonrpc: "2.0", id: callId, method, params };
		const payload = shouldValidate
			? [{ jsonrpc: "2.0", id: validationId, method: "eth_chainId", params: [] }, call]
			: call;

		let response: Response;
		try {
			response = await this.fetcher(endpoint, {
				method: "POST",
				headers: { Accept: "application/json", "Content-Type": "application/json", "api-key": this.options.apiKey },
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
			});
		} catch (error) {
			throw new EvmError(`EVM node request failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!response.ok) throw new EvmError(`EVM node request failed (${response.status})`);

		const body = await response.json() as JsonRpcResponse | JsonRpcResponse[];
		const responses = Array.isArray(body) ? body : [body];
		if (shouldValidate) {
			const validation = responses.find((item) => item.id === validationId);
			const actualChainId = parseQuantity(validation?.result, "chain id");
			const expectedChainId = BigInt(networkId.slice("eip155:".length));
			if (actualChainId !== expectedChainId) throw new EvmError(`EVM provider chain mismatch for ${networkId}`);
			this.validatedNetworks.add(networkId);
		}
		const result = responses.find((item) => item.id === callId);
		if (result?.error) throw new EvmError(`EVM JSON-RPC error ${result.error.code ?? "unknown"}: ${result.error.message || "unknown error"}`, 502, true);
		if (!result || result.result === undefined) throw new EvmError("EVM node returned no result");
		return result.result;
	}
}
