import { describe, expect, test } from "bun:test";
import { ContainerStartError, instanceOrder, prodPolicy, serveProd, type ProdDeps } from "./pool";

const policy = prodPolicy({ PROD_HOSTS: "api.keepkey.com", PROD_MIN_INSTANCES: "2", PROD_MAX_INSTANCES: "4" });
const overloaded = () => Response.json({ error: { code: "overloaded" } }, { status: 503, headers: { "x-gateway-overloaded": "1" } });

/** Records which instances were tried; `answers[i]` decides what instance i does. */
function deps(answers: Record<number, () => Response | Promise<Response>>, legacy = () => new Response("legacy")) {
	const tried: number[] = [], legacyUrls: string[] = [], bodies: string[] = [];
	const d: ProdDeps = {
		async instance(index, request) {
			tried.push(index); bodies.push(await request.clone().text());
			const answer = answers[index];
			if (!answer) throw new ContainerStartError("failed to start");
			return answer();
		},
		async fetch(request) { legacyUrls.push(request.url); return legacy(); },
	};
	return { d, tried, legacyUrls, bodies };
}
const req = (method = "GET", body?: string) => new Request("https://api.keepkey.com/api/v1/health?x=1", { method, body, headers: { "cf-connecting-ip": "203.0.113.7" } });

describe("prod pool", () => {
	test("policy parses hosts and caps, defaults to gateway upstream", () => {
		expect([...policy.hosts]).toEqual(["api.keepkey.com"]);
		expect([policy.min, policy.max, policy.upstream, policy.legacyOrigin]).toEqual([2, 4, "gateway", "https://api.keepkey.info"]);
		expect(prodPolicy({ PROD_MIN_INSTANCES: "3", PROD_MAX_INSTANCES: "1" }).max).toBe(3); // max never below min
		expect(prodPolicy({ PROD_UPSTREAM: "legacy" }).upstream).toBe("legacy");
	});

	test("order is sticky per client: warm home first, other warm, then bursts low-first", () => {
		const a = instanceOrder("203.0.113.7", 2, 4);
		expect(instanceOrder("203.0.113.7", 2, 4)).toEqual(a);
		expect(a.slice(0, 2).sort()).toEqual([0, 1]);
		expect(a.slice(2)).toEqual([2, 3]);
	});

	test("healthy home instance serves and is tagged", async () => {
		const home = instanceOrder("203.0.113.7", 2, 4)[0];
		const { d, tried } = deps({ [home]: () => new Response("ok") });
		const res = await serveProd(req(), policy, d);
		expect([await res.text(), res.headers.get("x-keepkey-upstream"), tried]).toEqual(["ok", `gateway:${home}`, [home]]);
	});

	test("overload spills a POST (body replayed) to the next instance", async () => {
		const [home, next] = instanceOrder("203.0.113.7", 2, 4);
		const { d, tried, bodies } = deps({ [home]: overloaded, [next]: () => new Response("served") });
		const res = await serveProd(req("POST", '{"tx":"ab"}'), policy, d);
		expect([await res.text(), tried, bodies]).toEqual(["served", [home, next], ['{"tx":"ab"}', '{"tx":"ab"}']]);
	});

	test("a POST that got a real 503 is NOT retried (it may have taken effect)", async () => {
		const [home] = instanceOrder("203.0.113.7", 2, 4);
		const { d, tried } = deps({ [home]: () => new Response("upstream down", { status: 503 }) });
		const res = await serveProd(req("POST", "{}"), policy, d);
		expect([res.status, tried]).toEqual([503, [home]]);
	});

	test("whole pool down fails over to legacy with path + query", async () => {
		const { d, tried, legacyUrls } = deps({});
		const res = await serveProd(req(), policy, d);
		expect([await res.text(), res.headers.get("x-keepkey-upstream"), tried.length]).toEqual(["legacy", "legacy", 4]);
		expect(legacyUrls).toEqual(["https://api.keepkey.info/api/v1/health?x=1"]);
	});

	test("PROD_UPSTREAM=legacy skips the pool entirely", async () => {
		const { d, tried, legacyUrls } = deps({ 0: () => new Response("gw"), 1: () => new Response("gw") });
		await serveProd(req(), { ...policy, upstream: "legacy" }, d);
		expect([tried, legacyUrls.length]).toEqual([[], 1]);
	});

	test("websocket upgrade tries only the home instance, then legacy", async () => {
		const { d, tried, legacyUrls } = deps({});
		await serveProd(new Request("https://api.keepkey.com/socket.io/?EIO=4&transport=websocket", { headers: { upgrade: "websocket", "cf-connecting-ip": "203.0.113.7" } }), policy, d);
		expect([tried.length, legacyUrls.length]).toEqual([1, 1]);
	});
});

 test("a POST transport failure cannot replay a possibly accepted mutation", async () => {
  const [home] = instanceOrder("203.0.113.7", 2, 4);
  const { d, tried, legacyUrls } = deps({ [home]: () => { throw new Error("connection reset after dispatch"); } });
  const response = await serveProd(req("POST", '{"signedTx":"fixture"}'), policy, d);
  expect(response.status).toBe(503);
  expect((await response.json() as any).error.code).toBe("delivery_unknown");
  expect(tried).toEqual([home]); expect(legacyUrls).toEqual([]);
 });
 test("a known pre-dispatch startup failure may retry a mutation", async () => {
  const [home, next] = instanceOrder("203.0.113.7", 2, 4);
  const { d, tried } = deps({ [next]: () => new Response("accepted") });
  expect((await serveProd(req("POST", "{}"), policy, d)).status).toBe(200);
  expect(tried).toEqual([home, next]);
 });
