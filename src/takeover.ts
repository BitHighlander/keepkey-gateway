/** api.keepkey.info takeover: the gateway answers what it owns; everything else
 * (extension paths, keyless calls, logos the bucket lacks, the full v3 spec) goes
 * to legacy Pioneer exactly as before. Pure so it runs under `bun test`.
 *
 * A same-zone fetch() goes to the zone's DNS origin (the DO load balancer) and
 * skips Worker routes (no global_fetch_strictly_public flag), so the legacy
 * replay cannot loop back here.
 * ponytail: fallback is by status code; port the legacy-only paths, then drop it. */

export const TAKEOVER_HOST = "api.keepkey.info";
export const SPACES_COINS = "https://keepkey.sfo3.cdn.digitaloceanspaces.com/coins/";
const FALLBACK_STATUS = new Set([401, 404, 405]);

export interface CoinObject { body: ReadableStream | ArrayBuffer | string | null; httpEtag?: string }
export interface TakeoverDeps {
	coin(name: string): Promise<CoinObject | null>;
	gateway(request: Request): Promise<Response>;
	legacy(request: Request): Promise<Response>;
}

export const isTakeoverHost = (url: string) => new URL(url).hostname.toLowerCase() === TAKEOVER_HOST;

function served(response: Response, by: "gateway" | "green" | "r2"): Response {
	if (response.status === 101 || (response as Response & { webSocket?: unknown }).webSocket) return response;
	const tagged = new Response(response.body, response);
	tagged.headers.set("x-kk-served-by", by);
	return tagged;
}

export async function serveTakeover(request: Request, deps: TakeoverDeps): Promise<Response> {
	const url = new URL(request.url);
	const read = request.method === "GET" || request.method === "HEAD";

	if (read && url.pathname.startsWith("/coins/")) {
		const name = url.pathname.slice("/coins/".length);
		const object = name && !name.includes("/") ? await deps.coin(name) : null;
		if (!object) return served(Response.redirect(SPACES_COINS + name, 302), "green");
		const headers = { "content-type": "image/png", "cache-control": "public, max-age=86400", ...(object.httpEtag ? { etag: object.httpEtag } : {}) };
		return served(new Response(request.method === "HEAD" ? null : object.body, { headers }), "r2");
	}

	const body = read ? undefined : await request.arrayBuffer();
	const copy = () => new Request(request.url, { method: request.method, headers: request.headers, body: body?.slice(0), redirect: "manual" });
	const toLegacy = async () => served(await deps.legacy(copy()), "green");

	// The v3 spec is a superset the SDK builds its client from. SSE and socket upgrades
	// go to the gateway first too (Desktop's query key lives there); a 401/404 is
	// decided before any stream starts, so replaying them is safe.
	if (url.pathname.startsWith("/spec/")) return toLegacy();

	let response: Response;
	try { response = await deps.gateway(copy()); }
	catch (error) {
		// A transport error after dispatch is ambiguous for a write: don't replay it.
		if (read) return toLegacy();
		throw error;
	}
	if (!FALLBACK_STATUS.has(response.status)) return served(response, "gateway");
	await response.body?.cancel();
	return toLegacy();
}
