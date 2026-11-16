import { describe, expect, test } from "bun:test";
import type { PersistentCache } from "./cache";
import { HiveClient, HiveError, verifyHiveAttestation } from "./hive";
import { PrivateKey, Signature, Transaction, type TransactionType } from "hive-tx";
import { Wallet } from "ethers";
import { createApp } from "./http";
import type { Database } from "./database";
import type { AppConfig } from "./config";
import { createHash } from "node:crypto";

class TestCache implements PersistentCache {
	private values = new Map<string, unknown>();
	async getFresh<T>(namespace: string, key: string): Promise<T | null> { return (this.values.get(`${namespace}:${key}`) as T) ?? null; }
	async getStale<T>(): Promise<T | null> { return null; }
	async set(namespace: string, key: string, value: unknown): Promise<void> { this.values.set(`${namespace}:${key}`, value); }
	async runExclusive<T>(_key: string, task: () => Promise<T>): Promise<T> { return task(); }
}

describe("demand-driven Hive", () => {
	test("does no work until requested and returns the Vault account shape", async () => {
		let calls = 0;
		const publicKey = `STM${"1".repeat(50)}`;
		const client = new HiveClient(new TestCache(), (async (_input: string | URL | Request, init?: RequestInit) => {
			calls++;
			const request = JSON.parse(String(init?.body));
			if (request.method === "condenser_api.get_key_references") return Response.json({ result: [["keepkey"]] });
			if (request.method === "condenser_api.get_accounts") return Response.json({ result: [{ name: "keepkey", balance: "1.234 HIVE", hbd_balance: "2.000 HBD", savings_balance: "0.100 HIVE", savings_hbd_balance: "0.200 HBD", reward_hive_balance: "0.010 HIVE", reward_hbd_balance: "0.020 HBD", vesting_shares: "1000.000000 VESTS", reward_vesting_balance: "10.000000 VESTS", delegated_vesting_shares: "100.000000 VESTS", received_vesting_shares: "50.000000 VESTS", vesting_withdraw_rate: "0.000000 VESTS" }] });
			if (request.method === "rc_api.find_rc_accounts") return Response.json({ result: { rc_accounts: [{ rc_manabar: { current_mana: "50" }, max_rc: "100" }] } });
			return Response.json({ result: { total_vesting_fund_hive: "1000.000 HIVE", total_vesting_shares: "10000.000000 VESTS" } });
		}) as unknown as typeof fetch);
		expect(calls).toBe(0);
		expect(await client.account(publicKey)).toEqual({ success: true, account: expect.objectContaining({ name: "keepkey", hive: "1.234", hp: "100.000", rcPercent: 50, poweringDown: false }) });
		expect(calls).toBe(4);
		await client.account(publicKey);
		expect(calls).toBe(4);
	});

	test("rejects invalid reads and broadcasts without upstream work", async () => {
		let calls = 0;
		const client = new HiveClient(new TestCache(), (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch);
		expect(await client.account("not-a-key")).toEqual({ success: false, error: "Invalid Hive public key (expected STM-prefixed base58)" });
		expect(await client.usernameAvailable("Bad--Name")).toEqual({ success: true, available: false, reason: expect.any(String) });
		await expect(client.broadcast({})).rejects.toBeInstanceOf(HiveError);
		await expect(client.broadcastOps({ operations: [], signature: "00" })).rejects.toBeInstanceOf(HiveError);
		expect(calls).toBe(0);
	});

	test("derives signing parameters from one live properties request", async () => {
		const client = new HiveClient(new TestCache(), (async () => Response.json({ result: { head_block_number: 65537, head_block_id: "0000000101020304" + "00".repeat(12), total_vesting_fund_hive: "1.000 HIVE", total_vesting_shares: "2.000000 VESTS" } })) as unknown as typeof fetch);
		const result = await client.txParams();
		expect(result).toMatchObject({ success: true, refBlockNum: 1, refBlockPrefix: 67305985, chainId: expect.stringMatching(/^beeab0de0{56}$/) });
	});
});

async function onboardingFixture(options: { enabled?: boolean; cash?: boolean; tokens?: number; fee?: string; balance?: string; failBroadcast?: boolean; failFinalize?: boolean; wrongSponsorKey?: boolean } = {}) {
	const sponsorKey = new PrivateKey(new Uint8Array(32).fill(19));
	const owner = new PrivateKey(new Uint8Array(32).fill(23));
	const roles = [owner, 29, 31, 37].map(value => typeof value === "number" ? new PrivateKey(new Uint8Array(32).fill(value)) : value);
	const keys = roles.map(key => key.createPublic().toString());
	const username = "audit-alice", sponsor = "keepkey";
	const eth = new Wallet("0x" + "02".repeat(32));
	const string = (value: string) => Buffer.concat([Buffer.from([Buffer.byteLength(value)]), Buffer.from(value)]);
	const authority = (key: PrivateKey) => Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 1]), Buffer.from(key.createPublic().key), Buffer.from([1, 0])]);
	const raw = Buffer.concat([Buffer.alloc(10), Buffer.from([1, 9]), Buffer.alloc(8), Buffer.from([3]), Buffer.from("HIVE\0\0\0"), string(sponsor), string(username), ...roles.slice(0, 3).map(authority), Buffer.from(roles[3].createPublic().key), Buffer.from([0, 0])]);
	const attest = (bytes: Buffer) => ({ serializedTx: bytes.toString("hex"), signature: owner.sign(new Uint8Array(createHash("sha256").update(Buffer.concat([Buffer.from("beeab0de" + "00".repeat(28), "hex"), bytes])).digest())).customToString() });
	const body = { username, ownerKey: keys[0], activeKey: keys[1], postingKey: keys[2], memoKey: keys[3], attestation: attest(raw), ethAddress: eth.address, ethSignature: await eth.signMessage(`KeepKey Hive onboarding\nusername:${username}\nowner:${keys[0]}`) };
	const auth = (key: string) => ({ weight_threshold: 1, account_auths: [], key_auths: [[key, 1]] });
	const createdAccount = { name: username, owner: auth(keys[0]), active: auth(keys[1]), posting: auth(keys[2]), memo_key: keys[3] };
	const claims = new Map<string, { username: string; txid: string | null; status: string }>();
	const broadcasts: TransactionType[] = [];
	const observed = { released: 0, funded: true, failMark: false, existing: undefined as typeof createdAccount | undefined };
	let serial = Promise.resolve();
	const database = {
		async getHiveClaim(address: string) { return claims.get(address) || null; },
		async reserveHiveClaim(_client: string, address: string, name: string) { if (claims.has(address)) return false; claims.set(address, { username: name, txid: null, status: "reserving" }); return true; },
		async markHiveClaimSubmitted(address: string, txid: string) { if (observed.failMark) throw new Error("storage unavailable"); claims.get(address)!.txid = txid; },
		async completeHiveClaim(address: string) { if (options.failFinalize) throw new Error("storage unavailable"); claims.get(address)!.status = "created"; },
		async releaseHiveClaim(address: string) { observed.released++; if (!claims.get(address)?.txid) claims.delete(address); },
		async runExclusive<T>(_key: string, task: () => Promise<T>): Promise<T> { const prior = serial; let release!: () => void; serial = new Promise<void>(resolve => { release = resolve; }); await prior; try { return await task(); } finally { release(); } },
		async authenticate() { return { id: "audit-client", username: "audit" }; }, async ping() {},
	} as unknown as Database;
	const fetcher = (async (_input: unknown, init?: RequestInit) => {
		const request = JSON.parse(String(init?.body));
		let result: unknown;
		if (request.method === "condenser_api.get_accounts") result = request.params[0][0] === sponsor ? [{ name: sponsor, active: auth(options.wrongSponsorKey ? keys[0] : sponsorKey.createPublic().toString()), pending_claimed_accounts: options.tokens ?? 0, balance: options.balance ?? "12.000 HIVE", vesting_shares: "10.000000 VESTS" }] : observed.existing ? [observed.existing] : [];
		else if (request.method === "condenser_api.get_chain_properties") result = { account_creation_fee: options.fee ?? "3.000 HIVE" };
		else if (request.method === "condenser_api.get_dynamic_global_properties") result = { head_block_number: 65537, head_block_id: "0000000101020304" + "00".repeat(12), total_vesting_fund_hive: "100.000 HIVE", total_vesting_shares: "1000.000000 VESTS" };
		else if (request.method === "rc_api.find_rc_accounts") result = { rc_accounts: [{ rc_manabar: { current_mana: "50" }, max_rc: "100" }] };
		else if (request.method === "condenser_api.broadcast_transaction_synchronous") {
			const signed = request.params[0] as TransactionType;
			broadcasts.push(signed);
			const digest = new Transaction({ transaction: signed }).digest();
			expect(Signature.from(signed.signatures[0]).getPublicKey(digest.digest).toString()).toBe(sponsorKey.createPublic().toString());
			if (options.failBroadcast) throw new Error("response lost after dispatch");
			observed.existing = createdAccount;
			result = { id: digest.txId, block_num: 65538, trx_num: 0 };
		} else throw new Error(`Unexpected RPC: ${request.method}`);
		return Response.json({ result });
	}) as typeof fetch;
	const hive = new HiveClient(new TestCache(), fetcher, { enabled: options.enabled ?? true, account: sponsor, activeWif: sponsorKey.toString(), allowCashFee: options.cash ?? true, database, evm: { getBalance: async () => ({ balance: observed.funded ? "0.01" : "0" }) } });
	const app = createApp({ config: {} as AppConfig, database, hive });
	return { hive, app, body, raw, attest, observed, broadcasts, claims, createdAccount, address: eth.address.toLowerCase() };
}

describe("sponsored Hive account migration", () => {
	test("spends the live cash fee with a valid sponsor signature when the ACT pool is empty", async () => {
		const f = await onboardingFixture();
		expect(await f.hive.createAccount("audit-client", f.body)).toMatchObject({ success: true, username: f.body.username, txid: expect.stringMatching(/^[a-f0-9]{40}$/) });
		expect(f.broadcasts).toHaveLength(1);
		expect(f.broadcasts[0].operations[0]).toEqual(["account_create", expect.objectContaining({ fee: "3.000 HIVE", creator: "keepkey", new_account_name: f.body.username, memo_key: f.body.memoKey })]);
		expect(f.claims.get(f.address)?.status).toBe("created");
	});
	test("prefers ACTs without a liquid-HIVE fee even when cash spending is disabled", async () => {
		const f = await onboardingFixture({ tokens: 1, cash: false, balance: "0.000 HIVE" });
		await f.hive.createAccount("audit-client", f.body);
		expect(f.broadcasts[0].operations[0][0]).toBe("create_claimed_account");
		expect(f.broadcasts[0].operations[0][1]).not.toHaveProperty("fee");
	});
	test("reports sponsor capacity from tokens and bounded cash fees", async () => {
		const f = await onboardingFixture({ tokens: 2 });
		const response = await f.app.fetch(new Request("http://gateway/api/v1/hive/sponsor-info"));
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ success: true, account: "keepkey", actPool: 2, creatable: 6, rcPercent: 50, hivePower: "1.000", onboardingEnabled: true, creationFee: "3.000 HIVE" });
	});
	test("disabled onboarding is visible in health and returns Vault-compatible errors", async () => {
		const f = await onboardingFixture({ enabled: false });
		const response = await f.app.fetch(new Request("http://gateway/api/v1/hive/create-account", { method: "POST", headers: { Authorization: "audit", "Content-Type": "application/json" }, body: JSON.stringify(f.body) }));
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ success: false, code: "hive_error", error: "Hive onboarding is disabled" });
		expect(await (await f.app.fetch(new Request("http://gateway/api/v1/health"))).json()).toMatchObject({ hive: "enabled", hiveOnboarding: "disabled" });
		expect(await f.hive.sponsorInfo()).toMatchObject({ onboardingEnabled: false, creatable: 0 });
	});
	test("rejects missing ETH proof, unfunded addresses, and mismatched attestations before spending", async () => {
		const f = await onboardingFixture();
		await expect(f.hive.createAccount("audit-client", { ...f.body, ethSignature: "" })).rejects.toMatchObject({ status: 400 });
		await expect(f.hive.createAccount("audit-client", { ...f.body, username: "mallory" })).rejects.toMatchObject({ status: 400 });
		f.observed.funded = false;
		await expect(f.hive.createAccount("audit-client", f.body)).rejects.toMatchObject({ status: 403 });
		expect(f.broadcasts).toHaveLength(0);
		expect(f.claims.size).toBe(0);
	});
	test("rejects malformed signed operation counts and authority thresholds", async () => {
		const f = await onboardingFixture();
		for (const bytes of [Buffer.from(f.raw), Buffer.concat([f.raw, Buffer.from([0])])]) {
			if (bytes.length === f.raw.length) bytes[10] = 2;
			await expect(f.hive.createAccount("audit-client", { ...f.body, attestation: f.attest(bytes) })).rejects.toMatchObject({ status: 400 });
		}
		expect(f.broadcasts).toHaveLength(0);
	});
	for (const options of [{ cash: false }, { fee: "4.000 HIVE" }, { fee: "0.000 HIVE" }, { fee: "3.000 HBD" }, { balance: "2.999 HIVE" }, { wrongSponsorKey: true }]) {
		test(`does not spend when sponsor preparation fails: ${JSON.stringify(options)}`, async () => {
			const f = await onboardingFixture(options);
			await expect(f.hive.createAccount("audit-client", f.body)).rejects.toMatchObject({ status: 503 });
			expect(f.broadcasts).toHaveLength(0);
			expect(f.claims.size).toBe(0);
		});
	}
	test("does not broadcast unless the transaction intent was durably recorded", async () => {
		const f = await onboardingFixture(); f.observed.failMark = true;
		await expect(f.hive.createAccount("audit-client", f.body)).rejects.toMatchObject({ status: 503 });
		expect(f.broadcasts).toHaveLength(0);
		expect(f.claims.size).toBe(0);
	});
	test("retains a claim across unknown broadcast results and reconciles a retry from chain", async () => {
		const f = await onboardingFixture({ failBroadcast: true });
		await expect(f.hive.createAccount("audit-client", f.body)).rejects.toMatchObject({ status: 503, retryAfter: 10 });
		const attempts = f.broadcasts.length;
		expect(f.claims.get(f.address)?.txid).toMatch(/^[a-f0-9]{40}$/);
		expect(f.observed.released).toBe(0);
		await expect(f.hive.createAccount("audit-client", f.body)).rejects.toMatchObject({ status: 503 });
		expect(f.broadcasts).toHaveLength(attempts);
		f.observed.existing = f.createdAccount;
		expect(await f.hive.createAccount("audit-client", f.body)).toMatchObject({ success: true });
		expect(f.broadcasts).toHaveLength(attempts);
	});
	test("keeps the reservation and success result if database finalization fails after broadcast", async () => {
		const f = await onboardingFixture({ failFinalize: true });
		expect(await f.hive.createAccount("audit-client", f.body)).toMatchObject({ success: true });
		expect(f.observed.released).toBe(0);
		expect(await f.hive.createAccount("audit-client", f.body)).toMatchObject({ success: true });
		expect(f.broadcasts).toHaveLength(1);
	});
	test("serializes concurrent identical requests and only funds one account", async () => {
		const f = await onboardingFixture();
		const results = await Promise.all([f.hive.createAccount("audit-client", f.body), f.hive.createAccount("audit-client", f.body)]);
		expect(results[0]).toEqual(results[1]);
		expect(f.broadcasts).toHaveLength(1);
	});
	test("preserves imported legacy ETH claims and returns the proper conflict text", async () => {
		const f = await onboardingFixture(); f.claims.set(f.address, { username: "legacy-user", txid: "ab".repeat(20), status: "created" });
		await expect(f.hive.createAccount("audit-client", f.body)).rejects.toMatchObject({ status: 409, message: "This ETH address already has a sponsored Hive account" });
		expect(f.broadcasts).toHaveLength(0);
	});
});

describe("Hive onboarding attestation", () => {
	test("binds the device signature to sponsor, username, and all role keys", () => {
		const sponsor = "kk-sponsor";
		const owner = new PrivateKey(new Uint8Array(32).fill(3));
		const active = new PrivateKey(new Uint8Array(32).fill(5));
		const posting = new PrivateKey(new Uint8Array(32).fill(7));
		const memo = new PrivateKey(new Uint8Array(32).fill(11));
		const variable = (value: number) => { const result: number[] = []; do { let byte = value & 0x7f; value >>>= 7; if (value) byte |= 0x80; result.push(byte); } while (value); return Buffer.from(result); };
		const string = (value: string) => Buffer.concat([variable(Buffer.byteLength(value)), Buffer.from(value)]);
		const authority = (key: Uint8Array) => { const threshold = Buffer.alloc(4); threshold.writeUInt32LE(1); const weight = Buffer.alloc(2); weight.writeUInt16LE(1); return Buffer.concat([threshold, variable(0), variable(1), Buffer.from(key), weight]); };
		const header = Buffer.alloc(10);
		const fee = Buffer.concat([Buffer.alloc(8), Buffer.from([3]), Buffer.from("HIVE\0\0\0", "latin1")]);
		const tx = Buffer.concat([header, variable(1), variable(9), fee, string(sponsor), string("alice"), authority(owner.createPublic().key), authority(active.createPublic().key), authority(posting.createPublic().key), Buffer.from(memo.createPublic().key), variable(0), variable(0)]);
		const digest = createHash("sha256").update(Buffer.concat([Buffer.from("beeab0de" + "00".repeat(28), "hex"), tx])).digest();
		const input = { serializedTx: tx.toString("hex"), signature: owner.sign(new Uint8Array(digest)).customToString(), ownerKey: owner.createPublic().toString(), activeKey: active.createPublic().toString(), postingKey: posting.createPublic().toString(), memoKey: memo.createPublic().toString(), newAccountName: "alice" };
		expect(verifyHiveAttestation(input, sponsor)).toEqual({ ok: true });
		expect(verifyHiveAttestation({ ...input, newAccountName: "mallory" }, sponsor)).toMatchObject({ ok: false, code: 400 });
		expect(verifyHiveAttestation(input, "wrong-sponsor")).toMatchObject({ ok: false, code: 400 });
	});
});
