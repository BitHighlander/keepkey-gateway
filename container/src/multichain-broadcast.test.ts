import { describe, expect, test } from "bun:test";
import { MultichainBroadcastClient, MultichainBroadcastError } from "./multichain-broadcast";

const SERIALIZED = Buffer.alloc(64, 7).toString("base64");
const HASH = "A".repeat(64);

describe("stateless multichain broadcast", () => {
	test("does no work until requested and submits Cosmos protobuf bytes in sync mode", async () => {
		let calls = 0;
		const client = new MultichainBroadcastClient({ apiKey: "key", fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
			calls++;
			expect(JSON.parse(String(init?.body))).toEqual({ tx_bytes: SERIALIZED, mode: "BROADCAST_MODE_SYNC" });
			return Response.json({ tx_response: { txhash: HASH, code: 0 } });
		}) as unknown as typeof fetch });
		expect(calls).toBe(0);
		expect(await client.broadcast("cosmos:thorchain-1", SERIALIZED)).toEqual(expect.objectContaining({ success: true, txid: HASH }));
		expect(calls).toBe(1);
	});

	test("preserves Cosmos CheckTx rejection truth instead of returning false success", async () => {
		const client = new MultichainBroadcastClient({ apiKey: "key", fetch: (async () => Response.json({ tx_response: { txhash: HASH, code: 5, raw_log: "bad sequence" } })) as unknown as typeof fetch });
		expect(await client.broadcast("cosmos:cosmoshub-4", SERIALIZED)).toEqual(expect.objectContaining({ success: false, txid: HASH, error: "bad sequence" }));
	});

	test("decodes Vault XRP base64 into the submit tx_blob", async () => {
		const client = new MultichainBroadcastClient({ apiKey: "key", fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			expect(body.params[0].tx_blob).toBe(Buffer.from(SERIALIZED, "base64").toString("hex"));
			return Response.json({ result: { engine_result: "tesSUCCESS", engine_result_code: 0, tx_json: { hash: HASH } } });
		}) as unknown as typeof fetch });
		expect(await client.broadcast("ripple:4109c6f2045fc7eff4cde8f9905d19c2", SERIALIZED)).toEqual(expect.objectContaining({ success: true, txid: HASH, engineResult: "tesSUCCESS" }));
	});

	test("rejects malformed payloads before any upstream call", async () => {
		let calls = 0;
		const client = new MultichainBroadcastClient({ apiKey: "key", fetch: (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch });
		await expect(client.broadcast("cosmos:osmosis-1", "not base64")).rejects.toBeInstanceOf(MultichainBroadcastError);
		expect(calls).toBe(0);
	});
});
