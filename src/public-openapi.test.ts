import { expect, test } from "bun:test";
import { publicOpenApiResponse } from "./public-openapi";

for (const origin of ["https://oracles.cc", "https://api-blue.keepkey.info", "https://api.keepkey.info"]) {
test(`advertises ${origin} despite internal HTTP forwarding`, async () => {
	const request = new Request(`${origin}/spec/swagger.json`);
	const response = await publicOpenApiResponse(request, Response.json({
		servers: [{ url: "http://oracles.cc/api/v1" }],
		paths: { "/portfolio/balances": { post: { operationId: "GetPortfolioBalances" } } },
	}, { headers: { ETag: "internal-spec" } }));
	const spec = await response.json() as any;
	expect(spec.servers).toEqual([{ url: `${origin}/api/v1` }]);
	expect(spec.paths["/portfolio/balances"].post.operationId).toBe("GetPortfolioBalances");
	expect(response.headers.has("etag")).toBe(false);
	expect(response.headers.get("cache-control")).toBe("no-store");
});
}

test("preserves local development origins and non-spec responses", async () => {
	const response = await publicOpenApiResponse(new Request("http://localhost:8787/spec/swagger.json"), Response.json({ servers: [] }));
	expect((await response.json() as any).servers).toEqual([{ url: "http://localhost:8787/api/v1" }]);
	const failure = Response.json({ error: "unavailable" }, { status: 503 });
	expect(await publicOpenApiResponse(new Request("https://oracles.cc/spec/swagger.json"), failure)).toBe(failure);
	const portfolio = Response.json({ balances: [] });
	expect(await publicOpenApiResponse(new Request("https://oracles.cc/api/v1/portfolio/balances", { method: "POST" }), portfolio)).toBe(portfolio);
});


test('legacy SDK balance and history schemas advertise the gateway refresh contract without losing fields', async () => {
 const document = { openapi: '3.0.0', components: { schemas: { HistoryRequest: { type: 'object', properties: { queries: { type: 'array' } } } } }, paths: {
  '/portfolio': { post: { operationId: 'GetPortfolioBalances', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { pubkeys: { type: 'array' } } } } } } } },
  '/tx/history': { post: { operationId: 'GetTransactionHistory', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/HistoryRequest' } } } } } },
 } };
 const response = await publicOpenApiResponse(new Request('https://api.keepkey.info/spec/swagger.json'), Response.json(document));
 const spec = await response.json() as any;
 const balance = spec.paths['/portfolio'].post.requestBody.content['application/json'].schema;
 expect(balance.properties.pubkeys).toEqual({type:'array'});
 expect(balance.properties.providerRefreshPolicy.enum).toEqual(['cache-only','on-demand']);
 const history = spec.components.schemas.HistoryRequest;
 expect(history.properties.queries).toEqual({type:'array'});
 expect(history.properties.providerRefreshPolicy.enum).toEqual(['cache-only','on-demand']);
 expect(history.properties.refreshReason.enum).toContain('automatic');
});
