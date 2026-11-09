import { expect, test } from "bun:test";
import { overloadGuard } from "./overload";

test("rejects above the in-flight cap with the spill signal, but never health; frees slots", async () => {
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => { release = resolve; });
	const guard = overloadGuard(1, async () => { await blocked; return new Response("ok"); });
	const first = guard(new Request("http://c/api/v1/portfolio"));
	const second = await guard(new Request("http://c/api/v1/portfolio"));
	expect([second.status, second.headers.get("x-gateway-overloaded")]).toEqual([503, "1"]);
	const health = guard(new Request("http://c/api/v1/health")); // exempt, queues behind the handler
	release();
	expect((await first).status).toBe(200);
	expect((await health).status).toBe(200);
	expect((await guard(new Request("http://c/api/v1/portfolio"))).status).toBe(200); // slot freed
});
