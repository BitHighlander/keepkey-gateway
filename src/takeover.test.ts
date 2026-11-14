import { describe, expect, test } from "bun:test";
import { isTakeoverHost, serveTakeover, SPACES_COINS, type TakeoverDeps } from "./takeover";

function deps(gateway: () => Response | Promise<Response>, coins: Record<string, string> = {}) {
	const seen = { gateway: [] as string[], legacy: [] as string[], legacyBodies: [] as string[] };
	const d: TakeoverDeps = {
		async coin(name) { return name in coins ? { body: coins[name], httpEtag: '"e"' } : null; },
		async gateway(r) { seen.gateway.push(r.url); return gateway(); },
		async legacy(r) { seen.legacy.push(r.url); seen.legacyBodies.push(await r.text()); return new Response("green", { status: 200 }); },
	};
	return { d, seen };
}
const at = (path: string, init?: RequestInit) => new Request(`https://api.keepkey.info${path}`, init);

describe("api.keepkey.info takeover", () => {
	test("host gating: only api.keepkey.info", () => {
		expect(isTakeoverHost("https://api.keepkey.info/x")).toBe(true);
		expect(isTakeoverHost("https://API.keepkey.info/x")).toBe(true);
		expect(isTakeoverHost("https://api-blue.keepkey.info/x")).toBe(false);
		expect(isTakeoverHost("https://oracles.cc/x")).toBe(false);
	});

	test("coin hit served from R2", async () => {
		const { d, seen } = deps(() => new Response("never"), { "a.png": "PNG" });
		const r = await serveTakeover(at("/coins/a.png"), d);
		expect([r.status, r.headers.get("content-type"), r.headers.get("x-kk-served-by"), await r.text()]).toEqual([200, "image/png", "r2", "PNG"]);
		expect(seen.gateway.length + seen.legacy.length).toBe(0);
	});

	test("coin miss redirects to Spaces like green", async () => {
		const r = await serveTakeover(at("/coins/missing.png"), deps(() => new Response("never")).d);
		expect([r.status, r.headers.get("location")]).toEqual([302, `${SPACES_COINS}missing.png`]);
	});

	test("gateway answer is kept", async () => {
		const { d, seen } = deps(() => Response.json({ ok: true }));
		const r = await serveTakeover(at("/api/v1/health"), d);
		expect([r.status, r.headers.get("x-kk-served-by")]).toEqual([200, "gateway"]);
		expect(seen.legacy).toEqual([]);
	});

	for (const status of [401, 404, 405]) test(`gateway ${status} falls back to green`, async () => {
		const { d, seen } = deps(() => new Response("no", { status }));
		const r = await serveTakeover(at("/api/v1/portfolio?x=1"), d);
		expect([r.status, r.headers.get("x-kk-served-by"), await r.text()]).toEqual([200, "green", "green"]);
		expect(seen.legacy).toEqual(["https://api.keepkey.info/api/v1/portfolio?x=1"]);
	});

	test("gateway 500 is not replayed (a write may have happened)", async () => {
		const { d, seen } = deps(() => new Response("boom", { status: 500 }));
		const r = await serveTakeover(at("/api/v1/x", { method: "POST", body: "{}" }), d);
		expect(r.status).toBe(500);
		expect(seen.legacy).toEqual([]);
	});

	test("POST body is replayed to green", async () => {
		const { d, seen } = deps(() => new Response("no", { status: 404 }));
		await serveTakeover(at("/api/v1/buildTx", { method: "POST", body: '{"a":1}', headers: { "content-type": "application/json" } }), d);
		expect(seen.legacyBodies).toEqual(['{"a":1}']);
	});

	test("gateway failure falls back to green", async () => {
		const r = await serveTakeover(at("/api/v1/health"), deps(() => { throw new Error("down"); }).d);
		expect(r.headers.get("x-kk-served-by")).toBe("green");
	});

	test("v3 spec always from green", async () => {
		const { d, seen } = deps(() => new Response("gateway spec"));
		await serveTakeover(at("/spec/swagger.json"), d);
		expect([seen.gateway.length, seen.legacy.length]).toEqual([0, 1]);
	});
});
