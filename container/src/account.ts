import type { PersistentCache } from "./cache";
import { DemandCache } from "./demand-cache";

const READ_TIMEOUT_MS = 8_000;
const COSMOS_ENDPOINTS: Readonly<Record<string, readonly string[]>> = {
	cosmos: ["https://rest.cosmos.directory/cosmoshub", "https://lcd-cosmoshub.keplr.app", "https://cosmos-rest.publicnode.com"],
	thorchain: ["https://rest.cosmos.directory/thorchain", "https://gateway.liquify.com/chain/thorchain_api"],
	mayachain: ["https://mayanode.mayachain.info", "https://rest.cosmos.directory/mayachain", "https://api-maya.liquify.com"],
	osmosis: ["https://lcd-osmosis.keplr.app", "https://rest.cosmos.directory/osmosis", "https://osmosis-rest.publicnode.com"],
};

interface AccountClientOptions {
	apiKey: string;
	cache: PersistentCache;
	fetch?: typeof fetch;
	cosmosEndpoints?: Readonly<Record<string, readonly string[]>>;
	xrpEndpoint?: string;
}

export class AccountError extends Error {
	constructor(message: string, public readonly status = 502) {
		super(message);
	}
}

function record(value: unknown): Record<string, any> {
	return value && typeof value === "object" ? value as Record<string, any> : {};
}

function findBaseAccount(value: unknown, depth = 0): Record<string, any> | null {
	if (depth > 8 || !value || typeof value !== "object") return null;
	const current = value as Record<string, any>;
	if (current.account_number !== undefined && current.sequence !== undefined) return current;
	for (const key of ["account", "base_account", "baseAccount", "base_vesting_account", "baseVestingAccount", "value", "result"]) {
		const found = findBaseAccount(current[key], depth + 1);
		if (found) return found;
	}
	return null;
}

export class AccountClient {
	private readonly fetcher: typeof fetch;
	private readonly cache: DemandCache;
	private readonly cosmosEndpoints: Readonly<Record<string, readonly string[]>>;
	private readonly xrpEndpoint: string;

	constructor(private readonly options: AccountClientOptions) {
		this.fetcher = options.fetch || fetch;
		this.cache = new DemandCache(options.cache, 1_000);
		this.cosmosEndpoints = options.cosmosEndpoints || COSMOS_ENDPOINTS;
		this.xrpEndpoint = options.xrpEndpoint || "https://xrp.nownodes.io/";
	}

	async getAccountInfo(network: string, address: string): Promise<Record<string, unknown>> {
		const normalizedNetwork = network.trim().toLowerCase();
		const normalizedAddress = address.trim();
		if (!normalizedAddress || normalizedAddress.length > 128) throw new AccountError("Invalid account address", 400);
		if (normalizedNetwork === "ripple" || normalizedNetwork === "xrp") return this.getXrpAccount(normalizedAddress);
		if (!this.cosmosEndpoints[normalizedNetwork]) throw new AccountError(`Unsupported account-info network: ${network}`, 422);
		const expectedPrefix = normalizedNetwork === "cosmos" ? "cosmos1" : normalizedNetwork === "thorchain" ? "thor1" : normalizedNetwork === "mayachain" ? "maya1" : "osmo1";
		if (!normalizedAddress.startsWith(expectedPrefix)) throw new AccountError(`Invalid ${normalizedNetwork} address`, 400);

		return this.cache.get({ namespace: "account_info", key: `${normalizedNetwork}:${normalizedAddress}`, freshForMs: 2_000, staleForMs: 2_000, source: "chain-rest" }, async () => {
			let lastError: unknown;
			let notFound = 0;
			for (const endpoint of this.cosmosEndpoints[normalizedNetwork]) {
				try {
					const response = await this.fetcher(`${endpoint.replace(/\/$/, "")}/cosmos/auth/v1beta1/accounts/${encodeURIComponent(normalizedAddress)}`, {
						headers: { Accept: "application/json" },
						signal: AbortSignal.timeout(READ_TIMEOUT_MS),
					});
					if (response.status === 404) {
						notFound++;
						continue;
					}
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const body = await response.json();
					const base = findBaseAccount(body);
					if (!base) throw new Error("response omitted account_number or sequence");
					return { account: { ...base, account_number: String(base.account_number), sequence: String(base.sequence), address: String(base.address || normalizedAddress) } };
				} catch (error) {
					lastError = error;
				}
			}
			if (notFound === this.cosmosEndpoints[normalizedNetwork].length) {
				return { account: { address: normalizedAddress, account_number: "0", sequence: "0", pub_key: null } };
			}
			throw new AccountError(`All ${normalizedNetwork} account endpoints failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
		});
	}

	private async getXrpAccount(address: string): Promise<Record<string, unknown>> {
		if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(address)) throw new AccountError("Invalid XRP address", 400);
		return this.cache.get({ namespace: "account_info", key: `ripple:${address}`, freshForMs: 2_000, staleForMs: 2_000, source: "nownodes-xrp" }, async () => {
			const body = await this.xrpRequest("account_info", [{ account: address, ledger_index: "current", queue: false }]);
			const result = record(body.result);
			if (result.error === "actNotFound") {
				const ledger = record((await this.xrpRequest("ledger_current", [{}])).result);
				return { Account: address, Balance: "0", Sequence: 0, ledger_index_current: Number(ledger.ledger_current_index || 0) };
			}
			if (result.error) throw new AccountError(`XRP account_info failed: ${String(result.error_message || result.error)}`);
			const account = record(result.account_data);
			if (!account.Account || account.Sequence === undefined || account.Balance === undefined) throw new AccountError("XRP account_info returned an invalid account");
			return { ...account, ledger_index_current: Number(result.ledger_current_index || result.ledger_index || 0) };
		});
	}

	private async xrpRequest(method: string, params: unknown[]): Promise<Record<string, any>> {
		let response: Response;
		try {
			response = await this.fetcher(this.xrpEndpoint, {
				method: "POST",
				headers: { Accept: "application/json", "Content-Type": "application/json", "api-key": this.options.apiKey },
				body: JSON.stringify({ method, params }),
				signal: AbortSignal.timeout(READ_TIMEOUT_MS),
			});
		} catch (error) {
			throw new AccountError(`XRP node request failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!response.ok) throw new AccountError(`XRP node request failed (${response.status})`);
		return record(await response.json());
	}
}
