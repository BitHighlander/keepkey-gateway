import { expect, test } from "bun:test";
import { inspectContract, inspectOrigin } from "./migration-readiness";
import { openApiDocument } from "../src/openapi";

test("the gateway advertises every SDK operation called by the current Vault at its selected HTTPS origin", () => {
 const origin = "https://api.keepkey.com";
 const document = openApiDocument(`${origin}/spec/swagger.json`);
 // The container sees HTTP internally; the Worker supplies the public origin.
 document.servers = [{ url: `${origin}/api/v1` }];
 expect(inspectContract(origin, document)).toMatchObject({ requiredOperations: 30, missingOperations: [], contractAvailable: true });
});

test("a stale advertised host or missing wallet operation fails contract preflight", () => {
 const document = { servers: [{ url: "http://wrong-origin.invalid/api/v1" }], paths: {} };
 const result = inspectContract("https://api.keepkey.com", document);
 expect(result.contractAvailable).toBe(false);
 expect(result.missingOperations).toContain("GetPendingSwap");
 expect(result.missingOperations).toContain("Broadcast");
});

test("unreachable specifications fail explicitly without echoing transport error contents", async () => {
 const result = await inspectOrigin("https://api.keepkey.com", (async (_url: string | URL | Request) => { throw new Error("private connection details"); }) as unknown as typeof fetch);
 expect(result).toEqual({ origin: "https://api.keepkey.com", contractAvailable: false, failure: "unreachable_or_invalid_specification" });
});
