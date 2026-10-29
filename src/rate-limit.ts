interface Bucket {
	tokens: number;
	updatedAt: number;
	lastSeenAt: number;
}

export interface RateLimitPolicy {
	capacity: number;
	refillPerSecond: number;
}

export interface RateLimitResult {
	allowed: boolean;
	retryAfterSeconds: number;
}

/**
 * Bounded, process-local token buckets for inexpensive abuse resistance at the
 * Worker boundary. Cloudflare isolates do not share this state, so these limits
 * are deliberately approximate rather than a billing or correctness boundary.
 */
export class MemoryRateLimiter {
	private readonly buckets = new Map<string, Bucket>();

	constructor(private readonly maxEntries = 10_000) {}

	take(key: string, policy: RateLimitPolicy, now = Date.now()): RateLimitResult {
		const existing = this.buckets.get(key);
		const elapsedSeconds = existing ? Math.max(0, now - existing.updatedAt) / 1_000 : 0;
		const tokens = existing
			? Math.min(policy.capacity, existing.tokens + elapsedSeconds * policy.refillPerSecond)
			: policy.capacity;

		if (!existing && this.buckets.size >= this.maxEntries) this.evictOldest();

		if (tokens < 1) {
			this.buckets.set(key, { tokens, updatedAt: now, lastSeenAt: now });
			return {
				allowed: false,
				retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / policy.refillPerSecond)),
			};
		}

		this.buckets.set(key, { tokens: tokens - 1, updatedAt: now, lastSeenAt: now });
		return { allowed: true, retryAfterSeconds: 0 };
	}

	private evictOldest(): void {
		let oldestKey: string | undefined;
		let oldest = Infinity;
		for (const [key, bucket] of this.buckets) {
			if (bucket.lastSeenAt < oldest) {
				oldest = bucket.lastSeenAt;
				oldestKey = key;
			}
		}
		if (oldestKey) this.buckets.delete(oldestKey);
	}
}

const REGISTRATION: RateLimitPolicy = { capacity: 5, refillPerSecond: 5 / 60 };
const EXPENSIVE: RateLimitPolicy = { capacity: 30, refillPerSecond: 30 / 60 };
// A wallet sync issues one history call per chain (Vault: ~30 at startup), and
// history is served from a 15s demand cache, so it gets its own larger bucket.
const HISTORY: RateLimitPolicy = { capacity: 120, refillPerSecond: 2 };
const GENERAL: RateLimitPolicy = { capacity: 120, refillPerSecond: 120 / 60 };

export function requestRateLimits(request: Request): Array<{ scope: string; policy: RateLimitPolicy }> {
	const url = new URL(request.url);
	const ip = request.headers.get("cf-connecting-ip") || "unknown";
	if (request.method === "POST" && url.pathname === "/api/v1/user/register") {
		return [{ scope: `registration:${ip}`, policy: REGISTRATION }];
	}

	const credential = request.headers.get("authorization") || request.headers.get("x-api-key");
	const history = url.pathname === "/api/v1/tx/history";
	const expensive = /\/(quote|portfolio|broadcast|telemetry)(\/|$)/.test(url.pathname);
	const kind = history ? "history" : expensive ? "expensive" : "general";
	const policy = history ? HISTORY : expensive ? EXPENSIVE : GENERAL;
	const limits = [{ scope: `${kind}:ip:${ip}`, policy }];
	if (credential) limits.push({ scope: `${kind}:key:${credential}`, policy });
	return limits;
}
