import { describe, expect, test } from "bun:test";
import type { PersistentCache } from "./cache";
import { HiveClient, HiveError, verifyHiveAttestation } from "./hive";
import { PrivateKey } from "hive-tx";
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
