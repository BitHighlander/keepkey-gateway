import { expect, test } from "bun:test";
import { publicOpenApiResponse } from "./public-openapi";

test("advertises the public HTTPS origin despite internal HTTP forwarding", async () => {
	const request = new Request("https://oracles.cc/spec/swagger.json");
	const response = await publicOpenApiResponse(request, Response.json({
		servers: [{ url: "http://oracles.cc/api/v1" }],
		paths: { "/portfolio/balances": { post: { operationId: "GetPortfolioBalances" } } },
	}, { headers: { ETag: "internal-spec" } }));
	const spec = await response.json() as any;
	expect(spec.servers).toEqual([{ url: "https://oracles.cc/api/v1" }]);
	expect(spec.paths["/portfolio/balances"].post.operationId).toBe("GetPortfolioBalances");
	expect(response.headers.has("etag")).toBe(false);
	expect(response.headers.get("cache-control")).toBe("no-store");
});

test("preserves local development origins and non-spec responses", async () => {
	const response = await publicOpenApiResponse(new Request("http://localhost:8787/spec/swagger.json"), Response.json({ servers: [] }));
	expect((await response.json() as any).servers).toEqual([{ url: "http://localhost:8787/api/v1" }]);
	const failure = Response.json({ error: "unavailable" }, { status: 503 });
	expect(await publicOpenApiResponse(new Request("https://oracles.cc/spec/swagger.json"), failure)).toBe(failure);
	const portfolio = Response.json({ balances: [] });
	expect(await publicOpenApiResponse(new Request("https://oracles.cc/api/v1/portfolio/balances", { method: "POST" }), portfolio)).toBe(portfolio);
});
