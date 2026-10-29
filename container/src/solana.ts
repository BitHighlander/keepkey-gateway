import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";

const RPC_TIMEOUT_MS = 12_000;
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const U64_MAX = (1n << 64n) - 1n;

interface SolanaClientOptions {
	apiKey: string;
	fetch?: typeof fetch;
	endpoint?: string;
}

interface SolanaTransferRequest {
	from: string;
	to: string;
	amount: string;
	memo?: string;
}

interface SolanaTokenTransferRequest extends SolanaTransferRequest {
	token: string;
	decimals: number;
}

interface JsonRpcResponse {
	id?: number;
	result?: any;
	error?: { code?: number; message?: string };
}

export class SolanaError extends Error {
	constructor(message: string, public readonly status = 502) {
		super(message);
	}
}

function publicKey(value: string, label: string): PublicKey {
	try {
		const key = new PublicKey(value);
		if (key.toBase58() !== value) throw new Error();
		return key;
	} catch {
		throw new SolanaError(`Invalid Solana ${label}`, 400);
	}
}

function unsignedAmount(value: string, label: string): bigint {
	if (!/^\d+$/.test(value)) throw new SolanaError(`${label} must be an unsigned base-unit integer`, 400);
	const amount = BigInt(value);
	if (amount <= 0n || amount > U64_MAX) throw new SolanaError(`${label} must be between 1 and 2^64-1`, 400);
	return amount;
}

function memoInstruction(signer: PublicKey, memo?: string): TransactionInstruction | null {
	if (!memo) return null;
	const data = Buffer.from(memo, "utf8");
	if (data.length > 512) throw new SolanaError("Solana memo must be at most 512 UTF-8 bytes", 400);
	return new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [{ pubkey: signer, isSigner: true, isWritable: false }], data });
}

function serializeForKeepKey(transaction: Transaction): string {
	const message = transaction.serializeMessage();
	const signedFormat = Buffer.alloc(65 + message.length);
	signedFormat[0] = 1;
	message.copy(signedFormat, 65);
	return signedFormat.toString("base64");
}

export class SolanaClient {
	private readonly fetcher: typeof fetch;
	private readonly endpoint: string;
	private requestId = 0;

	constructor(private readonly options: SolanaClientOptions) {
		this.fetcher = options.fetch || fetch;
		this.endpoint = options.endpoint || `https://sol.nownodes.io/${encodeURIComponent(options.apiKey)}`;
	}

	async buildTransfer(body: SolanaTransferRequest): Promise<Record<string, unknown>> {
		const from = publicKey(body.from, "sender address");
		const to = publicKey(body.to, "recipient address");
		const amount = unsignedAmount(body.amount, "amount");
		const latest = await this.latestBlockhash();
		const transaction = new Transaction({ feePayer: from, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight });
		transaction.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: amount }));
		const memo = memoInstruction(from, body.memo);
		if (memo) transaction.add(memo);
		return { success: true, serialized: serializeForKeepKey(transaction), blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight };
	}

	async buildTokenTransfer(body: SolanaTokenTransferRequest): Promise<Record<string, unknown>> {
		const from = publicKey(body.from, "sender address");
		const to = publicKey(body.to, "recipient address");
		const mint = publicKey(body.token, "token mint");
		const amount = unsignedAmount(body.amount, "amount");
		if (!Number.isInteger(body.decimals) || body.decimals < 0 || body.decimals > 255) throw new SolanaError("Token decimals must be an integer from 0 to 255", 400);
		const [senderAta] = PublicKey.findProgramAddressSync([from.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID);
		const [recipientAta] = PublicKey.findProgramAddressSync([to.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID);
		const latestId = ++this.requestId;
		const accountId = ++this.requestId;
		const responses = await this.rpc([
			{ jsonrpc: "2.0", id: latestId, method: "getLatestBlockhash", params: [{ commitment: "confirmed" }] },
			{ jsonrpc: "2.0", id: accountId, method: "getAccountInfo", params: [recipientAta.toBase58(), { encoding: "base64", commitment: "confirmed" }] },
		]);
		const latestResponse = responses.find((response) => response.id === latestId);
		const accountResponse = responses.find((response) => response.id === accountId);
		this.requireRpcSuccess(latestResponse, "getLatestBlockhash");
		this.requireRpcSuccess(accountResponse, "getAccountInfo");
		const latest = latestResponse!.result?.value;
		if (typeof latest?.blockhash !== "string" || !Number.isInteger(latest?.lastValidBlockHeight)) throw new SolanaError("Solana RPC returned an invalid blockhash");
		const needsCreateAta = accountResponse!.result?.value == null;
		const transaction = new Transaction({ feePayer: from, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight });
		if (needsCreateAta) {
			transaction.add(new TransactionInstruction({
				programId: ASSOCIATED_TOKEN_PROGRAM_ID,
				keys: [
					{ pubkey: from, isSigner: true, isWritable: true },
					{ pubkey: recipientAta, isSigner: false, isWritable: true },
					{ pubkey: to, isSigner: false, isWritable: false },
					{ pubkey: mint, isSigner: false, isWritable: false },
					{ pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
					{ pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
				],
				data: Buffer.from([1]),
			}));
		}
		const transferData = Buffer.alloc(10);
		transferData[0] = 12;
		transferData.writeBigUInt64LE(amount, 1);
		transferData[9] = body.decimals;
		transaction.add(new TransactionInstruction({
			programId: TOKEN_PROGRAM_ID,
			keys: [
				{ pubkey: senderAta, isSigner: false, isWritable: true },
				{ pubkey: mint, isSigner: false, isWritable: false },
				{ pubkey: recipientAta, isSigner: false, isWritable: true },
				{ pubkey: from, isSigner: true, isWritable: false },
			],
			data: transferData,
		}));
		const memo = memoInstruction(from, body.memo);
		if (memo) transaction.add(memo);
		return { success: true, serialized: serializeForKeepKey(transaction), blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight, needsCreateAta };
	}

	async broadcast(serialized: string): Promise<{ success: true; txid: string }> {
		if (!/^[A-Za-z0-9+/]+={0,2}$/.test(serialized) || serialized.length > 4_000) throw new SolanaError("Invalid base64 Solana transaction", 400);
		const id = ++this.requestId;
		const responses = await this.rpc({ jsonrpc: "2.0", id, method: "sendTransaction", params: [serialized, { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed" }] });
		const response = responses.find((item) => item.id === id);
		this.requireRpcSuccess(response, "sendTransaction");
		if (typeof response!.result !== "string" || response!.result.length < 80 || response!.result.length > 90) throw new SolanaError("Solana broadcast returned no signature");
		return { success: true, txid: response!.result };
	}

	private async latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
		const id = ++this.requestId;
		const responses = await this.rpc({ jsonrpc: "2.0", id, method: "getLatestBlockhash", params: [{ commitment: "confirmed" }] });
		const response = responses.find((item) => item.id === id);
		this.requireRpcSuccess(response, "getLatestBlockhash");
		const value = response!.result?.value;
		if (typeof value?.blockhash !== "string" || !Number.isInteger(value?.lastValidBlockHeight)) throw new SolanaError("Solana RPC returned an invalid blockhash");
		return value;
	}

	private requireRpcSuccess(response: JsonRpcResponse | undefined, method: string): void {
		if (response?.error) throw new SolanaError(`Solana ${method} error ${response.error.code ?? "unknown"}: ${response.error.message || "unknown error"}`);
		if (!response || response.result === undefined) throw new SolanaError(`Solana ${method} returned no result`);
	}

	private async rpc(payload: Record<string, unknown> | Record<string, unknown>[]): Promise<JsonRpcResponse[]> {
		let response: Response;
		try {
			response = await this.fetcher(this.endpoint, {
				method: "POST",
				headers: { Accept: "application/json", "Content-Type": "application/json", "api-key": this.options.apiKey },
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
			});
		} catch (error) {
			throw new SolanaError(`Solana RPC request failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!response.ok) throw new SolanaError(`Solana RPC request failed (${response.status})`);
		const body = await response.json() as JsonRpcResponse | JsonRpcResponse[];
		return Array.isArray(body) ? body : [body];
	}
}
