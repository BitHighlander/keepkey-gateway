import type { PersistentCache } from "./cache";
import { DemandCache } from "./demand-cache";
import { createHash } from "node:crypto";
import { getAddress, verifyMessage } from "ethers";
import { PrivateKey, PublicKey, Signature, Transaction, config as hiveConfig } from "hive-tx";
import type { Database } from "./database";
import type { EvmClient } from "./evm";

const NODES = ["https://api.hive.blog", "https://api.deathwing.me", "https://hive-api.arcange.eu"];
const CHAIN_ID = "beeab0de00000000000000000000000000000000000000000000000000000000";

export class HiveError extends Error {
	constructor(message: string, public readonly status = 502) { super(message); }
}

export class HiveClient {
	private readonly cache: DemandCache;
	private requestId = 0;
	constructor(cache: PersistentCache, private readonly fetcher: typeof fetch = fetch, private readonly sponsor?: {
		enabled: boolean;
		account?: string;
		activeWif?: string;
		database: Pick<Database, "reserveHiveClaim" | "completeHiveClaim" | "releaseHiveClaim" | "runExclusive">;
		evm?: Pick<EvmClient, "getBalance">;
	}) { this.cache = new DemandCache(cache, 1_000); }

	async account(pubkey: string): Promise<Record<string, unknown>> {
		if (!/^STM[1-9A-HJ-NP-Za-km-z]{48,52}$/.test(pubkey)) return { success: false, error: "Invalid Hive public key (expected STM-prefixed base58)" };
		return this.cache.get({ namespace: "hive_account", key: pubkey, freshForMs: 8_000, staleForMs: 60_000, source: "hive-rpc" }, async () => {
			const refs = await this.rpc("condenser_api.get_key_references", [[pubkey]]);
			const names = Array.isArray(refs?.[0]) ? refs[0].filter((name: unknown) => typeof name === "string") : [];
			if (names.length === 0) return { success: true, noAccount: true };
			const [accounts, rcResult, props] = await Promise.all([
				this.rpc("condenser_api.get_accounts", [names]),
				this.rpc("rc_api.find_rc_accounts", { accounts: names }).catch(() => null),
				this.rpc("condenser_api.get_dynamic_global_properties", []).catch(() => null),
			]);
			const account = accounts?.[0];
			if (!account) throw new HiveError("Hive account lookup returned no account");
			const rc = rcResult?.rc_accounts?.[0];
			const rcCurrent = String(rc?.rc_manabar?.current_mana ?? "0");
			const rcMax = String(rc?.max_rc ?? "1");
			const rcPercent = Math.min(100, Math.max(0, Math.round(Number(rcCurrent) / Number(rcMax) * 100) || 0));
			const hp = (value: unknown): string => vestsToHp(value, props);
			const poweringDown = Number.parseFloat(String(account.vesting_withdraw_rate || "0")) > 0;
			return { success: true, account: {
				name: account.name,
				hive: amount(account.balance), hbd: amount(account.hbd_balance),
				hp: hp(account.vesting_shares),
				hiveSavings: amount(account.savings_balance), hbdSavings: amount(account.savings_hbd_balance),
				pendingHive: amount(account.reward_hive_balance), pendingHbd: amount(account.reward_hbd_balance),
				pendingHp: hp(account.reward_vesting_balance),
				hpDelegatedOut: hp(account.delegated_vesting_shares), hpDelegatedIn: hp(account.received_vesting_shares),
				rcPercent, rcCurrent, rcMax,
				poweringDown, powerDownWeeklyHp: poweringDown ? hp(account.vesting_withdraw_rate) : "0.000",
			} };
		});
	}

	async usernameAvailable(name: string): Promise<Record<string, unknown>> {
		const reason = usernameReason(name);
		if (reason) return { success: true, available: false, reason };
		const accounts = await this.rpc("condenser_api.get_accounts", [[name]]);
		return Array.isArray(accounts) && accounts.length > 0 ? { success: true, available: false, reason: "Already registered" } : { success: true, available: true };
	}

	async txParams(): Promise<Record<string, unknown>> {
		const props = await this.rpc("condenser_api.get_dynamic_global_properties", []);
		const blockNumber = Number(props?.head_block_number);
		const blockId = String(props?.head_block_id || "");
		if (!Number.isSafeInteger(blockNumber) || !/^[a-fA-F0-9]{40}$/.test(blockId)) throw new HiveError("Hive dynamic properties are invalid");
		const refBlockPrefix = Buffer.from(blockId, "hex").readUInt32LE(4);
		const expirationUnix = Math.floor(Date.now() / 1000) + 60;
		return { success: true, refBlockNum: blockNumber & 0xffff, refBlockPrefix, expirationUnix, expirationIso: new Date(expirationUnix * 1000).toISOString().replace(".000Z", ""), chainId: CHAIN_ID, totalVestingFundHive: props.total_vesting_fund_hive, totalVestingShares: props.total_vesting_shares };
	}

	async history(account: string): Promise<Record<string, unknown>> {
		const reason = usernameReason(account);
		if (reason) throw new HiveError(`Invalid Hive account: ${reason}`, 400);
		return this.cache.get({ namespace: "hive_history", key: account, freshForMs: 8_000, staleForMs: 60_000, source: "hive-rpc" }, async () => {
			const result = await this.rpc("account_history_api.get_account_history", { account, start: -1, limit: 100, operation_filter_low: 4 });
			const entries = Array.isArray(result?.history) ? result.history : [];
			const transfers = entries.map((entry: unknown) => normalizeHistory(entry)).filter(Boolean).reverse();
			return { success: true, account, transfers };
		});
	}

	async broadcast(body: Record<string, unknown>): Promise<Record<string, unknown>> {
		for (const field of ["from", "to", "amount", "signature", "expiration"] as const) if (typeof body[field] !== "string" || !body[field]) throw new HiveError(`Missing ${field}`, 400);
		if (!/^\d+(\.\d{3}) HIVE$/.test(String(body.amount)) || !/^[a-fA-F0-9]{130}$/.test(String(body.signature))) throw new HiveError("Invalid Hive amount or compact signature", 400);
		const tx = { ref_block_num: number(body.ref_block_num, "ref_block_num"), ref_block_prefix: number(body.ref_block_prefix, "ref_block_prefix"), expiration: iso(body.expiration), operations: [["transfer", { from: body.from, to: body.to, amount: body.amount, memo: typeof body.memo === "string" ? body.memo : "" }]], extensions: [], signatures: [body.signature] };
		const result = await this.rpc("condenser_api.broadcast_transaction_synchronous", [tx], 20_000);
		if (!result?.id) throw new HiveError("Hive broadcast returned no transaction id");
		return { success: true, txid: result.id, blockNum: result.block_num, trxNum: result.trx_num };
	}

	async broadcastOps(body: Record<string, unknown>): Promise<Record<string, unknown>> {
		if (typeof body.signature !== "string" || !/^[a-fA-F0-9]{130}$/.test(body.signature)) throw new HiveError("Invalid compact signature", 400);
		if (!Array.isArray(body.operations) || body.operations.length < 1 || body.operations.length > 10) throw new HiveError("operations must contain 1–10 operations", 400);
		for (const operation of body.operations) {
			if (!Array.isArray(operation) || operation.length !== 2 || typeof operation[0] !== "string" || !operation[1] || typeof operation[1] !== "object" || Array.isArray(operation[1])) {
				throw new HiveError("Malformed operation; expected [name, params] tuples", 400);
			}
		}
		const tx = { ref_block_num: number(body.ref_block_num, "ref_block_num"), ref_block_prefix: number(body.ref_block_prefix, "ref_block_prefix"), expiration: iso(body.expiration), operations: body.operations, extensions: [], signatures: [body.signature] };
		const result = await this.rpc("condenser_api.broadcast_transaction_synchronous", [tx], 20_000);
		if (!result?.id) throw new HiveError("Hive broadcast returned no transaction id");
		return { success: true, txid: result.id, blockNum: result.block_num, trxNum: result.trx_num };
	}

	async createAccount(clientId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
		const sponsor = this.sponsor;
		if (!sponsor?.enabled) throw new HiveError("Hive onboarding is disabled", 503);
		if (!sponsor.account || !sponsor.activeWif || !sponsor.evm) throw new HiveError("Hive onboarding is not fully configured", 503);
		const username = String(body.username || "");
		const reason = usernameReason(username);
		if (reason) throw new HiveError(reason, 400);
		const keys = {
			ownerKey: String(body.ownerKey || ""), activeKey: String(body.activeKey || ""),
			postingKey: String(body.postingKey || ""), memoKey: String(body.memoKey || ""),
		};
		for (const [role, key] of Object.entries(keys)) {
			try { PublicKey.fromString(key); } catch { throw new HiveError(`Invalid ${role}`, 400); }
		}
		const attestation = body.attestation && typeof body.attestation === "object" ? body.attestation as Record<string, unknown> : {};
		const verified = verifyHiveAttestation({ serializedTx: String(attestation.serializedTx || ""), signature: String(attestation.signature || ""), ...keys, newAccountName: username }, sponsor.account);
		if (!verified.ok) throw new HiveError(verified.error || "Invalid Hive attestation", verified.code || 400);

		const ethAddress = String(body.ethAddress || "");
		const ethSignature = String(body.ethSignature || "");
		if (!ethAddress || !ethSignature) throw new HiveError("ETH ownership proof is required", 400);
		let canonicalEth: string;
		try {
			canonicalEth = getAddress(ethAddress);
			const message = `KeepKey Hive onboarding\nusername:${username}\nowner:${keys.ownerKey}`;
			if (getAddress(verifyMessage(message, ethSignature)) !== canonicalEth) throw new Error("signature mismatch");
		} catch (error) { throw new HiveError(`Invalid ETH ownership proof: ${error instanceof Error ? error.message : String(error)}`, 401); }
		const ethBalance = await sponsor.evm.getBalance("eip155:1", canonicalEth);
		if (!(Number(ethBalance.balance) > 0)) throw new HiveError("ETH address must hold mainnet ETH to claim a sponsored account", 403);

		const existing = await this.rpc("condenser_api.get_accounts", [[username]]);
		if (Array.isArray(existing) && existing.length > 0) throw new HiveError("Username already registered", 409);
		const reservation = canonicalEth.toLowerCase();
		if (!await sponsor.database.reserveHiveClaim(clientId, reservation, username)) throw new HiveError("This ETH address or client has already claimed a sponsored Hive account", 409);
		try {
			const txid = await sponsor.database.runExclusive("hive:sponsor-account-create", async () => {
				// Re-check under the cross-container PostgreSQL lock. If the ACT pool is
				// empty, mint exactly one with Resource Credits as part of this demand.
				const sponsorAccounts = await this.rpc("condenser_api.get_accounts", [[sponsor.account]]);
				const actPool = Number(sponsorAccounts?.[0]?.pending_claimed_accounts || 0);
				if (!Number.isSafeInteger(actPool) || actPool < 0) throw new Error("Sponsor ACT pool is invalid");
				hiveConfig.nodes = [...NODES];
				const activeKey = PrivateKey.fromString(sponsor.activeWif!);
				if (actPool === 0) {
					const claim = new Transaction();
					await claim.addOperation("claim_account", { creator: sponsor.account!, fee: "0.000 HIVE", extensions: [] });
					claim.sign(activeKey);
					await claim.broadcast(true);
				}
				const transaction = new Transaction();
				const authority = (key: string) => ({ weight_threshold: 1, account_auths: [] as [string, number][], key_auths: [[key, 1]] as [string, number][] });
				await transaction.addOperation("create_claimed_account", { creator: sponsor.account!, new_account_name: username, owner: authority(keys.ownerKey), active: authority(keys.activeKey), posting: authority(keys.postingKey), memo_key: keys.memoKey, json_metadata: "", extensions: [] });
				transaction.sign(activeKey);
				const result = await transaction.broadcast(true);
				return String((result as any)?.tx_id || (result as any)?.id || "");
			});
			if (!/^[a-fA-F0-9]{40}$/.test(txid)) throw new Error("Hive broadcast returned no transaction id");
			await sponsor.database.completeHiveClaim(reservation, txid);
			return { success: true, txid, username };
		} catch (error) {
			await sponsor.database.releaseHiveClaim(reservation).catch(() => {});
			throw new HiveError(`Hive account creation failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async rpc(method: string, params: unknown, timeout = 10_000): Promise<any> {
		let last: unknown;
		for (const node of NODES) {
			try {
				const response = await this.fetcher(node, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++this.requestId, method, params }), signal: AbortSignal.timeout(timeout) });
				const body = await response.json().catch(() => null) as any;
				if (!response.ok || body?.error) throw new Error(body?.error?.message || `HTTP ${response.status}`);
				return body?.result;
			} catch (error) { last = error; }
		}
		throw new HiveError(`All Hive nodes failed: ${last instanceof Error ? last.message : String(last)}`);
	}
}

function amount(raw: unknown): string { return String(raw || "0.000").split(" ")[0]; }
function number(raw: unknown, field: string): number { const value = Number(raw); if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new HiveError(`Invalid ${field}`, 400); return value; }
function iso(raw: unknown): string { const value = String(raw || ""); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z?$/.test(value) || !Number.isFinite(Date.parse(value.endsWith("Z") ? value : `${value}Z`))) throw new HiveError("Invalid expiration", 400); return value; }
function vestsToHp(raw: unknown, props: any): string {
	const vests = Number.parseFloat(String(raw || "0"));
	const totalFund = Number.parseFloat(String(props?.total_vesting_fund_hive || "0"));
	const totalShares = Number.parseFloat(String(props?.total_vesting_shares || "0"));
	return Number.isFinite(vests) && Number.isFinite(totalFund) && totalShares > 0 ? (vests * totalFund / totalShares).toFixed(3) : "0.000";
}
function normalizeHistory(entry: unknown): Record<string, unknown> | null {
	if (!Array.isArray(entry) || !entry[1] || typeof entry[1] !== "object") return null;
	const meta = entry[1] as any;
	const op = meta.op || {};
	const type = String(op.type || op[0] || "").replace(/_operation$/, "");
	const value = op.value || op[1] || {};
	const rawAmount = value.amount;
	let transferAmount: string | undefined;
	if (typeof rawAmount === "string") transferAmount = rawAmount;
	else if (rawAmount && typeof rawAmount === "object" && Number.isFinite(Number(rawAmount.amount)) && Number.isInteger(Number(rawAmount.precision))) {
		transferAmount = `${(Number(rawAmount.amount) / 10 ** Number(rawAmount.precision)).toFixed(Number(rawAmount.precision))} ${rawAmount.nai === "@@000000013" ? "HBD" : "HIVE"}`;
	}
	return { txid: String(meta.trx_id || ""), blockNum: Number(meta.block || 0), timestamp: String(meta.timestamp || ""), type, ...(typeof value.from === "string" ? { from: value.from } : {}), ...(typeof value.to === "string" ? { to: value.to } : {}), ...(transferAmount ? { amount: transferAmount } : {}), ...(typeof value.memo === "string" ? { memo: value.memo } : {}) };
}
function usernameReason(name: string): string | null {
	if (name.length < 3 || name.length > 16) return "Must be 3–16 characters";
	if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(name) || name.includes("--")) return "Must start with a letter and contain lowercase letters, numbers, or single hyphens";
	return null;
}

interface HiveAttestationInput { serializedTx: string; signature: string; ownerKey: string; activeKey: string; postingKey: string; memoKey: string; newAccountName: string }
export function verifyHiveAttestation(input: HiveAttestationInput, sponsorAccount: string): { ok: boolean; code?: 400 | 401; error?: string } {
	try {
		if (!/^[a-fA-F0-9]+$/.test(input.serializedTx) || input.serializedTx.length % 2 !== 0 || input.serializedTx.length > 8192) return { ok: false, code: 400, error: "Invalid serialized attestation" };
		if (!/^[a-fA-F0-9]{130}$/.test(input.signature)) return { ok: false, code: 400, error: "signature must be 65 bytes" };
		const tx = Buffer.from(input.serializedTx, "hex");
		const digest = createHash("sha256").update(Buffer.concat([Buffer.from(CHAIN_ID, "hex"), tx])).digest();
		if (Signature.from(input.signature).getPublicKey(new Uint8Array(digest)).toString() !== PublicKey.fromString(input.ownerKey).toString()) return { ok: false, code: 401, error: "signature does not recover to ownerKey" };
		const reader = new TxReader(tx);
		reader.u16(); reader.u32(); reader.u32(); reader.varint();
		if (reader.varint() !== 9) return { ok: false, code: 400, error: "attestation is not account_create" };
		reader.bytes(8); reader.u8(); reader.bytes(7);
		const creator = reader.string();
		const name = reader.string();
		const ownerKey = hivePublic(readAuthority(reader));
		const activeKey = hivePublic(readAuthority(reader));
		const postingKey = hivePublic(readAuthority(reader));
		const memoKey = hivePublic(reader.bytes(33));
		if (creator !== sponsorAccount) return { ok: false, code: 400, error: "creator is not the configured sponsor" };
		if (name !== input.newAccountName) return { ok: false, code: 400, error: "new account name mismatch" };
		if (ownerKey !== input.ownerKey || activeKey !== input.activeKey || postingKey !== input.postingKey || memoKey !== input.memoKey) return { ok: false, code: 400, error: "attested keys do not match request" };
		return { ok: true };
	} catch (error) { return { ok: false, code: 400, error: `attestation parse failed: ${error instanceof Error ? error.message : String(error)}` }; }
}

class TxReader {
	private position = 0;
	constructor(private readonly buffer: Buffer) {}
	u8(): number { if (this.position >= this.buffer.length) throw new Error("unexpected end"); return this.buffer[this.position++]; }
	u16(): number { const value = this.buffer.readUInt16LE(this.position); this.position += 2; return value; }
	u32(): number { const value = this.buffer.readUInt32LE(this.position); this.position += 4; return value; }
	varint(): number { let shift = 0, result = 0, byte = 0; do { if (shift > 28) throw new Error("varint overflow"); byte = this.u8(); result |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80); return result >>> 0; }
	bytes(length: number): Buffer { if (length < 0 || this.position + length > this.buffer.length) throw new Error("unexpected end"); const result = this.buffer.subarray(this.position, this.position + length); this.position += length; return result; }
	string(): string { return this.bytes(this.varint()).toString("utf8"); }
}
function readAuthority(reader: TxReader): Buffer { reader.u32(); const accounts = reader.varint(); if (accounts !== 0) throw new Error("account authorities are not allowed"); const keys = reader.varint(); if (keys !== 1) throw new Error("exactly one key authority is required"); const key = reader.bytes(33); reader.u16(); return key; }
function hivePublic(bytes: Buffer): string { return new PublicKey(new Uint8Array(bytes)).toString(); }
