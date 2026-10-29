const COSMOS_ENDPOINTS: Readonly<Record<string, readonly string[]>> = {
	"cosmos:cosmoshub-4": ["https://rest.cosmos.directory/cosmoshub", "https://lcd-cosmoshub.keplr.app", "https://cosmos-rest.publicnode.com"],
	"cosmos:thorchain-1": ["https://rest.cosmos.directory/thorchain", "https://gateway.liquify.com/chain/thorchain_api"],
	"cosmos:thorchain-mainnet-v1": ["https://rest.cosmos.directory/thorchain", "https://gateway.liquify.com/chain/thorchain_api"],
	"cosmos:mayachain-mainnet-v1": ["https://mayanode.mayachain.info", "https://rest.cosmos.directory/mayachain", "https://api-maya.liquify.com"],
	"cosmos:osmosis-1": ["https://lcd-osmosis.keplr.app", "https://rest.cosmos.directory/osmosis", "https://osmosis-rest.publicnode.com"],
};

export class MultichainBroadcastError extends Error {
	constructor(message: string, public readonly status = 502) { super(message); }
}

/** Stateless, demand-only relay for signed payloads produced by Vault. */
export class MultichainBroadcastClient {
	constructor(private readonly options: { apiKey: string; fetch?: typeof fetch }) {}

	async broadcast(networkId: string, serialized: string): Promise<Record<string, unknown>> {
		if (COSMOS_ENDPOINTS[networkId]) return this.cosmos(networkId, serialized);
		if (networkId === "ripple:4109c6f2045fc7eff4cde8f9905d19c2" || networkId === "ripple:xrp-mainnet") return this.xrp(serialized);
		throw new MultichainBroadcastError(`Unsupported multichain broadcast network: ${networkId}`, 422);
	}

	private async cosmos(networkId: string, serialized: string): Promise<Record<string, unknown>> {
		const txBytes = strictBase64(serialized, 32, 256_000, "Cosmos transaction");
		let last: unknown;
		for (const endpoint of COSMOS_ENDPOINTS[networkId]) {
			try {
				const response = await this.fetcher(`${endpoint}/cosmos/tx/v1beta1/txs`, {
					method: "POST",
					headers: { Accept: "application/json", "Content-Type": "application/json", ...(endpoint.includes("liquify.com") ? { "x-client-id": "keepkey-gateway" } : {}) },
					body: JSON.stringify({ tx_bytes: txBytes.toString("base64"), mode: "BROADCAST_MODE_SYNC" }),
					signal: AbortSignal.timeout(15_000),
				});
				const body = await response.json().catch(() => null) as any;
				if (!response.ok || !body?.tx_response) throw new Error(`HTTP ${response.status}`);
				const raw = body.tx_response;
				const txid = String(raw.txhash || "").toUpperCase();
				const code = Number(raw.code || 0);
				if (!/^[A-F0-9]{64}$/.test(txid)) throw new Error("node returned no transaction hash");
				return { success: code === 0, txid, provider: endpoint, results: { raw: body }, ...(code === 0 ? {} : { error: String(raw.raw_log || raw.codespace || `CheckTx code ${code}`) }) };
			} catch (error) { last = error; }
		}
		throw new MultichainBroadcastError(`All ${networkId} broadcast endpoints failed: ${message(last)}`);
	}

	private async xrp(serialized: string): Promise<Record<string, unknown>> {
		const bytes = strictBase64(serialized, 16, 256_000, "XRP transaction");
		const response = await this.fetcher("https://xrp.nownodes.io/", {
			method: "POST",
			headers: { Accept: "application/json", "Content-Type": "application/json", "api-key": this.options.apiKey },
			body: JSON.stringify({ method: "submit", id: 1, command: "submit", fail_hard: true, params: [{ tx_blob: bytes.toString("hex") }] }),
			signal: AbortSignal.timeout(15_000),
		});
		const body = await response.json().catch(() => null) as any;
		if (!response.ok || body?.error) throw new MultichainBroadcastError(`XRP broadcast failed (${response.status}): ${body?.error?.message || body?.error || "invalid response"}`);
		const result = body?.result || {};
		const txid = String(result?.tx_json?.hash || result?.tx_json?.hashes?.[0] || "").toUpperCase();
		const engineResult = String(result?.engine_result || "");
		const success = engineResult === "tesSUCCESS" && Number(result?.engine_result_code || 0) === 0 && /^[A-F0-9]{64}$/.test(txid);
		return { success, ...(txid ? { txid } : {}), provider: "nownodes", engineResult, engineResultCode: Number(result?.engine_result_code || 0), engineResultMessage: String(result?.engine_result_message || ""), results: { raw: body }, ...(success ? {} : { error: String(result?.engine_result_message || engineResult || "XRP transaction was rejected") }) };
	}

	private get fetcher(): typeof fetch { return this.options.fetch || fetch; }
}

function strictBase64(value: string, minBytes: number, maxBytes: number, label: string): Buffer {
	const trimmed = value.trim();
	if (!trimmed || trimmed.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) throw new MultichainBroadcastError(`${label} must be canonical base64`, 400);
	const bytes = Buffer.from(trimmed, "base64");
	if (bytes.length < minBytes || bytes.length > maxBytes || bytes.toString("base64") !== trimmed) throw new MultichainBroadcastError(`${label} has an invalid encoded length`, 400);
	return bytes;
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
