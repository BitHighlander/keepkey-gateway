import { describe, expect, test } from "bun:test";
import { Transaction } from "@solana/web3.js";
import { SolanaClient, SolanaError } from "./solana";

const FROM = "2hYvcUnojGD5JfBtb3hStqFtU8GzFh2mToyxboPVu9MQ";
const TO = "11111111111111111111111111111111";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BLOCKHASH = "11111111111111111111111111111111";

function decodeTransaction(serialized: string): Transaction {
	const bytes = Buffer.from(serialized, "base64");
	expect(bytes[0]).toBe(1);
	expect(bytes.subarray(1, 65).every((value) => value === 0)).toBe(true);
	return Transaction.from(bytes);
}

describe("SolanaClient", () => {
	test("does not call RPC until a transaction is built", () => {
		let calls = 0;
		new SolanaClient({ apiKey: "test", fetch: (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch });
		expect(calls).toBe(0);
	});

	test("builds KeepKey signed-wire format for native transfers and memos", async () => {
		let calls = 0;
		const client = new SolanaClient({
			apiKey: "test",
			fetch: (async (_input, init) => {
				calls++;
				const request = JSON.parse(String(init?.body));
				expect(request.method).toBe("getLatestBlockhash");
				return Response.json({ jsonrpc: "2.0", id: request.id, result: { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 123 } } });
			}) as typeof fetch,
		});
		const response: any = await client.buildTransfer({ from: FROM, to: TO, amount: "5000", memo: "=:ETH.ETH:0xfixture" });
		expect(response).toMatchObject({ success: true, blockhash: BLOCKHASH, lastValidBlockHeight: 123 });
		const transaction = decodeTransaction(response.serialized);
		expect(transaction.instructions).toHaveLength(2);
		expect(transaction.instructions[0].programId.toBase58()).toBe(TO);
		expect(transaction.instructions[1].programId.toBase58()).toBe("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
		expect(calls).toBe(1);
	});

	test("uses one RPC batch and adds idempotent ATA creation for SPL transfers", async () => {
		let calls = 0;
		const client = new SolanaClient({
			apiKey: "test",
			fetch: (async (_input, init) => {
				calls++;
				const requests = JSON.parse(String(init?.body));
				expect(requests.map((request: any) => request.method)).toEqual(["getLatestBlockhash", "getAccountInfo"]);
				return Response.json([
					{ jsonrpc: "2.0", id: requests[0].id, result: { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 456 } } },
					{ jsonrpc: "2.0", id: requests[1].id, result: { value: null } },
				]);
			}) as typeof fetch,
		});
		const response: any = await client.buildTokenTransfer({ from: FROM, to: TO, token: MINT, amount: "2500000", decimals: 6, memo: "swap" });
		expect(response.needsCreateAta).toBe(true);
		const transaction = decodeTransaction(response.serialized);
		expect(transaction.instructions.map((instruction) => instruction.programId.toBase58())).toEqual([
			"ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
			"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
			"MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
		]);
		expect(transaction.instructions[1].data.readBigUInt64LE(1)).toBe(2_500_000n);
		expect(transaction.instructions[1].data[9]).toBe(6);
		expect(calls).toBe(1);
	});

	test("rejects floating-point amounts before RPC", () => {
		const client = new SolanaClient({ apiKey: "test" });
		expect(client.buildTransfer({ from: FROM, to: TO, amount: "0.1" })).rejects.toBeInstanceOf(SolanaError);
	});
});
