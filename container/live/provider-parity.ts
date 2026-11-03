/** Deployment gate: public quote fixtures only, with no signing or broadcast.
 * Usage: bun container/live/provider-parity.ts https://oracles.cc
 * Quotes can allocate unused provider deposit addresses.
 */
import { bech32 } from "@scure/base";
import { VersionedTransaction } from "@solana/web3.js";

const ETH = "eip155:1/slip44:60";
const LTC = "bip122:12a765e31ffd4059bada1e25190f6e98/slip44:2";
const BTC = "bip122:000000000019d6689c085ae165831e93/slip44:0";
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501";
const publicHash = Uint8Array.from(Buffer.from("751e76e8199196d454941c45d1b3a323f1433bd6", "hex"));
const addresses: Record<string, string> = {
	[ETH]: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
	[LTC]: bech32.encode("ltc", [0, ...bech32.toWords(publicHash)]),
	[BTC]: bech32.encode("bc", [0, ...bech32.toWords(publicHash)]),
	[SOL]: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
};
export interface ProviderFixture {
	name: string;
	sellAsset: string;
	buyAsset: string;
	sellAmount: string;
	memoless?: boolean;
	requiredIntegration?: string;
}
export const providerFixtures: ProviderFixture[] = [
	{ name: "ETH to LTC", sellAsset: ETH, buyAsset: LTC, sellAmount: "0.021319", requiredIntegration: "nearIntents" },
	{ name: "ETH to LTC native precision", sellAsset: ETH, buyAsset: LTC, sellAmount: "0.012345678912345678", requiredIntegration: "nearIntents" },
	{ name: "LTC to ETH", sellAsset: LTC, buyAsset: ETH, sellAmount: "1", requiredIntegration: "nearIntents" },
	{ name: "SOL to ETH", sellAsset: SOL, buyAsset: ETH, sellAmount: "0.25" },
	{ name: "BTC to LTC memoless", sellAsset: BTC, buyAsset: LTC, sellAmount: "0.001", memoless: true },
];

function positiveDecimal(value: unknown): boolean {
	return typeof value === "string" && /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value) && /[1-9]/.test(value);
}

/** An HTTP 200 alone must not satisfy the provider deployment gate. */
export function assertProviderQuotes(fixture: ProviderFixture, body: any): string[] {
	const unwrapped = body?.data?.data || body?.data || body;
	const entries = Array.isArray(unwrapped) ? unwrapped : unwrapped?.quotes;
	if (!Array.isArray(entries) || !entries.length) throw new Error("No quote returned");
	if (fixture.requiredIntegration && !entries.some(entry => entry.integration === fixture.requiredIntegration)) {
		throw new Error(`Missing direct ${fixture.requiredIntegration} route`);
	}
	for (const entry of entries) {
		const quote = entry.quote || entry;
		if (!positiveDecimal(quote.amountOut) || !positiveDecimal(quote.amountOutMin)) throw new Error("Quote has no positive output and minimum");
		if (!Array.isArray(quote.txs) || !quote.txs.length) throw new Error("Quote has no source transaction");
		for (const tx of quote.txs) {
			const params = tx.txParams;
			if (!params || tx.chain !== fixture.sellAsset.split("/")[0]) throw new Error("Transaction is not bound to the requested source chain");
			if (fixture.memoless && (params.memo || tx.memo)) throw new Error("Memoless request returned a memo");
			if (tx.type === "EVM") {
				const direct = /^0x[0-9a-f]{40}$/i.test(params.to || "") && /^0x(?:[0-9a-f]{2})*$/i.test(params.data || "")
					&& /^\d+$/.test(String(params.value)) && BigInt(params.value) > 0n;
				const protocol = /^0x[0-9a-f]{40}$/i.test(params.recipientAddress || "") && typeof params.memo === "string"
					&& params.memo.length > 0 && positiveDecimal(params.amount);
				if (!direct && !protocol) throw new Error("EVM quote has no executable native deposit");
			} else if (tx.type === "SOLANA" && params.serializedTx) {
				const wire = Buffer.from(params.serializedTx, "base64");
				const transaction = VersionedTransaction.deserialize(wire);
				if (wire.length > 1232 || transaction.message.header.numRequiredSignatures !== 1) throw new Error("Solana transaction exceeds wallet bounds");
			} else if (!["transfer", "SOLANA"].includes(tx.type) || !params.recipientAddress || !positiveDecimal(params.amount)) {
				throw new Error("Quote has no executable transfer deposit");
			}
		}
	}
	return entries.map(entry => String(entry.integration || (entry.quote || entry).source));
}

export async function checkProviderParity(origin: string, fetcher: typeof fetch = fetch): Promise<Record<string, unknown>> {
	const queryKey = `vault:provider-smoke:${crypto.randomUUID()}:${crypto.randomUUID()}`;
	const request = async (path: string, body: unknown) => {
		const response = await fetcher(`${origin.replace(/\/$/, "")}/api/v1${path}`, {
			method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: queryKey },
			body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
		});
		const payload = await response.json().catch(() => null) as any;
		if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${String(payload?.error?.message || payload?.message || "request failed").slice(0, 500)}`);
		return payload;
	};
	// The response includes API credentials; never log or retain it.
	await request("/user/register", { username: `provider-smoke-${crypto.randomUUID()}`, queryKey });
	const observations: Array<Record<string, unknown>> = [];
	for (const fixture of providerFixtures) {
		const started = Date.now();
		try {
			const payload = await request("/quote", {
				sellAsset: fixture.sellAsset, buyAsset: fixture.buyAsset, sellAmount: fixture.sellAmount,
				senderAddress: addresses[fixture.sellAsset], recipientAddress: addresses[fixture.buyAsset], slippage: 3,
				...(fixture.memoless ? { memoless: true } : {}),
			});
			observations.push({ case: fixture.name, success: true, integrations: assertProviderQuotes(fixture, payload), elapsedMs: Date.now() - started });
		} catch (error) {
			observations.push({ case: fixture.name, success: false, error: error instanceof Error ? error.message : String(error), elapsedMs: Date.now() - started });
		}
	}
	return { origin, checkedAt: new Date().toISOString(), publicFixturesOnly: true, signed: false, broadcast: false,
		success: observations.every(row => row.success), observations };
}

if (import.meta.main) {
	const origin = process.argv[2];
	if (!origin || !/^https?:\/\//.test(origin)) throw new Error("Provide the gateway HTTP(S) origin");
	const report = await checkProviderParity(origin);
	console.log(JSON.stringify(report, null, 2));
	if (!report.success) process.exitCode = 1;
}
