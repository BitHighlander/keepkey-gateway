import { describe, expect, test } from "bun:test";
import { MemoryRateLimiter, requestRateLimits } from "./rate-limit";

describe("Worker memory rate limiter", () => {
	test("limits a bucket and reports when it can retry", () => {
		const limiter = new MemoryRateLimiter();
		const policy = { capacity: 2, refillPerSecond: 1 };
		expect(limiter.take("client", policy, 0).allowed).toBe(true);
		expect(limiter.take("client", policy, 0).allowed).toBe(true);
		expect(limiter.take("client", policy, 0)).toEqual({ allowed: false, retryAfterSeconds: 1 });
		expect(limiter.take("client", policy, 1_000).allowed).toBe(true);
	});

	test("uses stricter registration and expensive-route scopes", () => {
		const registration = requestRateLimits(new Request("https://gateway/api/v1/user/register", {
			method: "POST", headers: { "cf-connecting-ip": "192.0.2.1" },
		}));
		const quote = requestRateLimits(new Request("https://gateway/api/v1/quote", {
			headers: { authorization: "test-key", "cf-connecting-ip": "192.0.2.2" },
		}));
		expect(registration[0].scope).toBe("registration:192.0.2.1");
		expect(registration[0].policy.capacity).toBe(5);
		expect(quote.map((limit) => limit.scope)).toEqual([
			"expensive:ip:192.0.2.2",
			"expensive:key:test-key",
		]);
		expect(quote[0].policy.capacity).toBe(30);
	});

	test("gives transaction history its own wallet-sync-sized bucket", () => {
		const history = requestRateLimits(new Request("https://gateway/api/v1/tx/history", {
			method: "POST", headers: { authorization: "test-key", "cf-connecting-ip": "192.0.2.3" },
		}));
		expect(history.map((limit) => limit.scope)).toEqual(["history:ip:192.0.2.3", "history:key:test-key"]);
		const limiter = new MemoryRateLimiter();
		const allowed = Array.from({ length: 60 }, () => limiter.take(history[0].scope, history[0].policy, 0).allowed);
		expect(allowed.every(Boolean)).toBe(true);
	});

	test("evicts within its configured memory bound", () => {
		const limiter = new MemoryRateLimiter(1);
		const policy = { capacity: 1, refillPerSecond: 1 };
		limiter.take("first", policy, 0);
		expect(limiter.take("second", policy, 1).allowed).toBe(true);
		expect(limiter.take("first", policy, 1).allowed).toBe(true);
	});
});
