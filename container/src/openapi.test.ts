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
});
