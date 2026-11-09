/** In-flight request cap. Above it the container answers 503 + `x-gateway-overloaded: 1`
 * before doing any work, so the Worker can safely retry the request (even a POST) on
 * another instance. This is the scale-out signal: Cloudflare Containers have no
 * utilization autoscaling yet. Health stays exempt so a busy instance isn't restarted.
 * `max <= 0` disables the cap. SSE handlers return their Response immediately, so a
 * long-lived stream does not hold a slot. */
export function overloadGuard(max: number, handle: (request: Request) => Response | Promise<Response>) {
	let inflight = 0;
	return async (request: Request): Promise<Response> => {
		if (max > 0 && inflight >= max && new URL(request.url).pathname !== "/api/v1/health") {
			return Response.json({ error: { code: "overloaded", message: "Instance is at capacity; retry" } },
				{ status: 503, headers: { "x-gateway-overloaded": "1", "Retry-After": "1" } });
		}
		inflight++;
		try { return await handle(request); } finally { inflight--; }
	};
}
