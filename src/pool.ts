/** Production hosts (api.keepkey.com) run on their own capped container pool with a
 * warm floor, overload spill-over to burst instances, and failover to legacy Pioneer.
 * Everything else (api-blue, oracles.cc) keeps the single scale-to-zero instance.
 * Pure so it runs under `bun test`; src/index.ts wires the Cloudflare bindings in. */

export interface PoolEnv {
	PROD_HOSTS?: string;
	PROD_MIN_INSTANCES?: string;
	PROD_MAX_INSTANCES?: string;
	PROD_UPSTREAM?: string;
	LEGACY_ORIGIN?: string;
}

export interface ProdPolicy {
	hosts: Set<string>;
	min: number;
	max: number;
	upstream: "gateway" | "legacy";
	legacyOrigin: string;
}

export function prodPolicy(env: PoolEnv): ProdPolicy {
	const int = (raw: string | undefined, fallback: number) => {
		const n = Number.parseInt(raw ?? "", 10);
		return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
	};
	const min = Math.max(1, int(env.PROD_MIN_INSTANCES, 2));
	return {
		hosts: new Set((env.PROD_HOSTS || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)),
		min,
		// The hard cap is the container app's max_instances; this is the routing cap.
		max: Math.max(min, int(env.PROD_MAX_INSTANCES, min)),
		upstream: env.PROD_UPSTREAM?.trim() === "legacy" ? "legacy" : "gateway",
		legacyOrigin: (env.LEGACY_ORIGIN || "https://api.keepkey.info").replace(/\/$/, ""),
	};
}

export const prodInstanceId = (index: number) => `prod-${index}`;

function fnv1a(text: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
	return hash;
}

/** Sticky attempt order: the client's warm home first (its realtime state lives in that
 * instance's memory), the other warm instances, then burst instances lowest-first so
 * overflow packs onto as few extra instances as possible and the rest stay asleep. */
export function instanceOrder(clientKey: string, min: number, max: number): number[] {
	const home = fnv1a(clientKey) % min;
	const warm = Array.from({ length: min }, (_, i) => (home + i) % min);
	const burst = Array.from({ length: max - min }, (_, i) => min + i);
	return [...warm, ...burst];
}

/** Only thrown by the readiness adapter before it dispatches a request. A fetch
 * transport error is ambiguous: a mutation may already have reached the app. */
export class ContainerStartError extends Error {}

export interface ProdDeps {
	/** Start (if needed) and fetch from prod instance `index`; throws if it can't serve. */
	instance(index: number, request: Request): Promise<Response>;
	/** Plain fetch, used for the legacy upstream. */
	fetch(request: Request): Promise<Response>;
}

const isUpgrade = (request: Request) => request.headers.get("upgrade")?.toLowerCase() === "websocket";
const idempotent = (method: string) => method === "GET" || method === "HEAD";

function tag(response: Response, upstream: string): Response {
	if (response.status === 101 || (response as Response & { webSocket?: unknown }).webSocket) return response;
	const tagged = new Response(response.body, response);
	tagged.headers.set("x-keepkey-upstream", upstream);
	return tagged;
}

export async function serveProd(request: Request, policy: ProdPolicy, deps: ProdDeps): Promise<Response> {
	const url = new URL(request.url);
	// Bodies are small JSON; buffer once so a POST can be replayed on another instance.
	const body = idempotent(request.method) ? undefined : await request.arrayBuffer();
	const copy = (target: string) => new Request(target, { method: request.method, headers: request.headers, body: body?.slice(0), redirect: "manual" });

	if (policy.upstream === "gateway") {
		const clientKey = request.headers.get("cf-connecting-ip") || request.headers.get("authorization") || "anonymous";
		// A socket can't be replayed mid-handshake: home instance only, then legacy.
		const order = instanceOrder(clientKey, policy.min, policy.max).slice(0, isUpgrade(request) ? 1 : undefined);
		for (const index of order) {
			try {
				const response = await deps.instance(index, copy(request.url));
				// Overload is answered before any work, so any method may move on. Other
				// gateway 5xx only retry reads: a POST may already have taken effect.
				const overloaded = response.headers.get("x-gateway-overloaded") === "1";
				const transient = idempotent(request.method) && [502, 503, 504].includes(response.status);
				if (!overloaded && !transient) return tag(response, `gateway:${index}`);
				await response.body?.cancel();
			} catch (error) {
				if (!idempotent(request.method) && !(error instanceof ContainerStartError)) {
					return Response.json({ error: { code: "delivery_unknown", message: "Request delivery could not be confirmed. Check its status before retrying." } },
						{ status: 503, headers: { "x-keepkey-upstream": `gateway:${index}` } });
				}
			}
		}
	}
	const legacy = copy(`${policy.legacyOrigin}${url.pathname}${url.search}`);
	legacy.headers.delete("host");
	return tag(await deps.fetch(legacy), "legacy");
}
