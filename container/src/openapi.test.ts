import { READ_RPC_METHODS } from "./evm";
import { describe, expect, test } from "bun:test";
import { openApiDocument } from "./openapi";

describe("OpenAPI Vault contract", () => {
	test("uses OpenAPI 3 requestBody semantics required by pioneer-client", () => {
		const document = openApiDocument("http://127.0.0.1:12000/spec/swagger.json") as any;
		expect(document.openapi).toBe("3.0.0");
		expect(document.servers).toEqual([{ url: "http://127.0.0.1:12000/api/v1" }]);
		expect(document.paths["/market/info"].post.requestBody.content["application/json"].schema.type).toBe("array");
		expect(document.paths["/market/info"].post.parameters).toBeUndefined();
	});

	test("exposes the EVM operations Desktop calls by operationId, method, and v3 path", () => {
		const document = openApiDocument("http://127.0.0.1:12000/spec/swagger.json") as any;
		const operation = (path: string, method: string) => document.paths[path]?.[method];
		expect(operation("/evm/rpc", "post").operationId).toBe("EvmReadRpc");
		expect(operation("/evm/rpc", "post").requestBody.content["application/json"].schema.properties.method.enum).toEqual([...READ_RPC_METHODS]);
		expect(operation("/evm/lookup/{networkId}/{txid}", "get").operationId).toBe("LookupTx");
		expect(operation("/evm/token/lookup", "post").operationId).toBe("LookupTokenMetadata");
		const allowance = operation("/evm/token/allowance/{networkId}/{contractAddress}/{ownerAddress}/{spenderAddress}", "get");
		expect(allowance.operationId).toBe("GetTokenAllowance");
		expect(allowance.parameters.map((parameter: any) => parameter.name)).toEqual(["networkId", "contractAddress", "ownerAddress", "spenderAddress"]);
	});

	test("UpdatePendingSwap is a PUT on the pending swap path with a body", () => {
		const document = openApiDocument("http://127.0.0.1:12000/spec/swagger.json") as any;
		const update = document.paths["/swaps/pending/{txHash}"].put;
		expect(update.operationId).toBe("UpdatePendingSwap");
		expect(update.parameters.map((parameter: any) => parameter.name)).toEqual(["txHash"]);
		expect(update.requestBody.content["application/json"].schema.required).toEqual(["relayData"]);
	});
});
