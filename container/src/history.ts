import type { UtxoClient } from "./utxo";
import type { ZerionClient } from "./zerion";
import type { ChainHistoryClient } from "./chain-history";
import type { HiveClient } from "./hive";

const MAX_QUERIES = 100;
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const HIVE_PUBKEY = /^STM[1-9A-HJ-NP-Za-km-z]{48,52}$/;

export interface HistoryQuery {
	caip: string;
	pubkey: string;
}

export interface HistoryRequest {
	queries: HistoryQuery[];
	page?: number;
}

export class HistoryError extends Error {
	constructor(message: string, public readonly status = 400) {
		super(message);
	}
}

export class HistoryClient {
	constructor(private readonly dependencies: {
		utxo?: Pick<UtxoClient, "getTransactionHistory">;
		zerion?: Pick<ZerionClient, "getTransactions">;
		multichain?: Pick<ChainHistoryClient, "getTransactionHistory">;
		hive?: Pick<HiveClient, "account" | "history">;
	}) {}

	async getTransactionHistory(body: HistoryRequest): Promise<Record<string, unknown>> {
		this.validate(body);
		const fetchedAt = Date.now();
		const fetchedAtISO = new Date(fetchedAt).toISOString();
		const page = body.page || 1;
		const queries = body.queries.map((query) => ({ caip: query.caip.trim(), pubkey: query.pubkey.trim(), networkId: query.caip.trim().split("/")[0] }));
		const evmAddresses = [...new Set(queries.filter((query) => query.networkId.startsWith("eip155:")).map((query) => query.pubkey.toLowerCase()))];
		const evmTransactions = new Map<string, ReturnType<NonNullable<typeof this.dependencies.zerion>["getTransactions"]>>();
		for (const address of evmAddresses) {
			if (!this.dependencies.zerion) break;
			const pending = this.dependencies.zerion.getTransactions(address);
			pending.catch(() => {}); // Observed per query below; avoid an unhandled rejection meanwhile.
			evmTransactions.set(address, pending);
		}

		// One failing chain must not fail the whole batch: each query reports its
		// own error, and transactions is omitted rather than presented as empty.
		const histories = await Promise.all(queries.map(async (query) => {
			try {
				const transactions = await this.queryTransactions(query, page, evmTransactions);
				return { caip: query.caip, pubkey: query.pubkey, transactions, fetchedAt, fetchedAtISO, page, cached: false, fresh: true, loading: false };
			} catch (error) {
				return { caip: query.caip, pubkey: query.pubkey, failure: error, fetchedAt, fetchedAtISO, page, cached: false, fresh: false, loading: false };
			}
		}));

		// Nothing succeeded: surface the first real error with its own status.
		if (histories.every((history) => "failure" in history)) throw (histories[0] as { failure: unknown }).failure;
		return { success: true, histories: histories.map(({ failure, ...history }: any) => failure === undefined ? history : { ...history, error: describeFailure(failure) }) };
	}

	private async queryTransactions(query: { caip: string; pubkey: string; networkId: string }, page: number, evmTransactions: Map<string, Promise<any[]>>): Promise<any[]> {
		if (query.networkId.startsWith("bip122:")) {
			if (!this.dependencies.utxo) throw new HistoryError("UTXO transaction history is not configured", 503);
			return (await this.dependencies.utxo.getTransactionHistory(query.networkId, query.pubkey)).map((transaction) => ({ ...transaction, caip: query.caip, networkId: query.networkId }));
		}
		if (query.networkId.startsWith("eip155:")) {
			if (!this.dependencies.zerion) throw new HistoryError("EVM transaction history is not configured", 503);
			return (await evmTransactions.get(query.pubkey.toLowerCase())!)
				.filter((transaction) => transaction.networkId === query.networkId)
				.map((transaction) => ({ ...transaction, caip: query.caip }));
		}
		if (query.networkId.startsWith("hive:")) {
			if (!this.dependencies.hive) throw new HistoryError("Hive transaction history is not configured", 503);
			const resolved = await this.dependencies.hive.account(query.pubkey) as any;
			if (resolved?.success !== true) throw new HistoryError(String(resolved?.error || "Hive account lookup failed"), 502);
			if (resolved.noAccount) return [];
			const accountName = String(resolved?.account?.name || "");
			if (!accountName) throw new HistoryError("Hive account lookup returned no account name", 502);
			const response = await this.dependencies.hive.history(accountName) as any;
			return (Array.isArray(response?.transfers) ? response.transfers : []).map((transfer: any) => normalizeHiveHistory(accountName, query.networkId, transfer));
		}
		if (!this.dependencies.multichain) throw new HistoryError("Multichain transaction history is not configured", 503);
		return (await this.dependencies.multichain.getTransactionHistory(query.caip, query.pubkey, page)).map((transaction) => ({ ...transaction, caip: query.caip }));
	}

	private validate(body: HistoryRequest): void {
		if (!body || !Array.isArray(body.queries) || body.queries.length === 0 || body.queries.length > MAX_QUERIES) {
			throw new HistoryError(`queries must contain between 1 and ${MAX_QUERIES} entries`);
		}
		if (body.page !== undefined && (!Number.isInteger(body.page) || body.page < 1)) throw new HistoryError("page must be a positive integer");
		for (const query of body.queries) {
			if (!query || typeof query.caip !== "string" || !query.caip.includes("/") || typeof query.pubkey !== "string" || !query.pubkey.trim() || query.pubkey.length > 512) {
				throw new HistoryError("Each history query requires a valid caip and pubkey");
			}
			if (query.caip.startsWith("eip155:") && !EVM_ADDRESS.test(query.pubkey)) throw new HistoryError(`Invalid EVM address for ${query.caip}`);
			if (query.caip.startsWith("hive:") && !HIVE_PUBKEY.test(query.pubkey.trim())) throw new HistoryError(`Invalid Hive public key for ${query.caip} (expected STM-prefixed base58)`);
		}
	}
}

function describeFailure(error: unknown): { status: number; message: string } {
	const status = (error as { status?: unknown })?.status;
	if (typeof status === "number" && error instanceof Error) return { status, message: error.message };
	console.error(JSON.stringify({ event: "history_query_failed", error: error instanceof Error ? error.message : String(error) }));
	return { status: 500, message: "Internal server error" };
}

function normalizeHiveHistory(account: string, networkId: string, transfer: any): Record<string, unknown> {
	const from = String(transfer?.from || "");
	const to = String(transfer?.to || "");
	const amount = String(transfer?.amount || "0").split(" ")[0];
	return {
		txid: String(transfer?.txid || ""),
		networkId,
		direction: from === account ? (to === account ? "self" : "sent") : "received",
		type: String(transfer?.type || "transfer"),
		status: "confirmed",
		blockHeight: Number(transfer?.blockNum || 0),
		timestamp: Math.floor(Date.parse(String(transfer?.timestamp || "")) / 1000) || 0,
		from: from ? [from] : [],
		to: to ? [to] : [],
		value: /^\d+(?:\.\d+)?$/.test(amount) ? amount : "0",
	};
}
