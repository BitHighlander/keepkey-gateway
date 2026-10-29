import { pathToFileURL } from "node:url";

const baseUrl = (process.argv.find((arg) => arg.startsWith("--url="))?.slice(6) || "http://127.0.0.1:12000").replace(/\/$/, "");
const modulePath = process.env.VAULT_PIONEER_CLIENT_PATH
	|| "/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault/node_modules/@pioneer-platform/pioneer-client/lib/index.js";
const { default: Pioneer } = await import(pathToFileURL(modulePath).href);
const queryKey = `gateway:portfolio-probe:${crypto.randomUUID()}:${crypto.randomUUID()}`;
const nativeFetch = globalThis.fetch;
const observations = [];
const legacyHttp = process.argv.includes("--legacy-http");
globalThis.fetch = async (input, init) => {
	const request = new Request(input, init);
	const startedAt = performance.now();
	console.log(JSON.stringify({ event: "probe_request", method: request.method, protocol: new URL(request.url).protocol, path: new URL(request.url).pathname }));
	const response = await nativeFetch(request);
	const url = new URL(request.url);
	observations.push({ method: request.method, protocol: url.protocol, path: url.pathname, status: response.status, redirected: response.redirected, durationMs: Math.round(performance.now() - startedAt) });
	if (legacyHttp && url.pathname === "/spec/swagger.json" && response.ok) {
		// Emulate the old server URL retained by an already-initialized SDK.
		const document = await response.json();
		document.servers = [{ url: `${baseUrl.replace(/^https:/, "http:")}/api/v1` }];
		return Response.json(document);
	}
	return response;
};

const registered = await fetch(`${baseUrl}/api/v1/user/register`, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({ username: "gateway-portfolio-probe", queryKey }),
});
if (!registered.ok) throw new Error(`Registration failed (${registered.status})`);
const client = new Pioneer(`${baseUrl}/spec/swagger.json`, { queryKey, overrideHost: new URL(baseUrl).host });
const pioneer = await client.init();
// Use a public fixture address; never read the user's wallet or credentials.
const chunkCount = process.argv.includes("--concurrent") ? 8 : 1;
const results = await Promise.all(Array.from({ length: chunkCount }, () => pioneer.GetPortfolioBalances({
	pubkeys: [{ caip: "eip155:100/slip44:60", pubkey: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }],
	includeDefi: false,
}, { forceRefresh: true })));
if (results.some((result) => !Array.isArray(result?.data?.balances))) throw new Error("Invalid portfolio response");
const portfolioRequests = observations.filter((entry) => entry.path === "/api/v1/portfolio/balances");
if (!portfolioRequests.length || portfolioRequests.some((entry) => entry.method !== "POST" || entry.status !== 200 || entry.redirected !== legacyHttp)) {
	throw new Error(`Portfolio routing failed: ${JSON.stringify(portfolioRequests)}`);
}
console.log(JSON.stringify({ requests: observations, chunks: results.length, balances: results.map((result) => result.data.balances.length), degraded: results.some((result) => result.data.meta?.degraded), failures: results.flatMap((result) => result.data.meta?.failures || []) }));
