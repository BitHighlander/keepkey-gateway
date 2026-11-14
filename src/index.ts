import { Container, getContainer } from "@cloudflare/containers";
import { DurableObject } from "cloudflare:workers";
import { containerEnv, type ContainerRuntimeEnv } from "./container-env";
import { MemoryRateLimiter, requestRateLimits } from "./rate-limit";
import { publicOpenApiResponse } from "./public-openapi";
import { armPaymentMonitor, runPaymentMonitor, changesDurablePaymentWatches, isInternalRealtimePath, type BackgroundTickResult } from "./realtime-scheduler";
import { ContainerStartError, prodInstanceId, prodPolicy, serveProd, type PoolEnv } from "./pool";
import { isTakeoverHost, R2_COINS, serveTakeover } from "./takeover";

interface Env extends ContainerRuntimeEnv, PoolEnv {
	PIONEER_CONTAINER: DurableObjectNamespace<PioneerContainer>;
	PROD_CONTAINER: DurableObjectNamespace<ProdGatewayContainer>;
	REALTIME_WATCHDOG: DurableObjectNamespace<RealtimeWatchdog>;
}

// Blue/test hosts: one instance that scales to zero.
const MAIN_INSTANCE_ID = "pioneer-main-recovery-20261003";
// A request waits this long for a prod instance before moving on (cron warms with 120s).
const PROD_REQUEST_START_MS = 30_000;
const KEEP_WARM_KEY = "keep-warm";
const rateLimiter = new MemoryRateLimiter();

// Wraps the pioneer container image (see ./container). One Durable Object
// instance == one running container; Cloudflare handles start-on-fetch and
// scale-to-zero via `sleepAfter`, and forwards WebSocket upgrades through
// `.fetch()` automatically. Pattern taken from DegenQuest's proven Cloudflare
// Containers cutover (projects/game/deploy/core-container).
export class PioneerContainer extends Container<Env> {
	defaultPort = 12000;
	requiredPorts = [12000];
	pingEndpoint = "localhost/api/v1/health";
	sleepAfter = "10m";
	enableInternet = true;
}

// Production pool member. Warm-floor instances (flagged by the cron) never sleep;
// burst instances keep the inherited 10m scale-to-zero.
export class ProdGatewayContainer extends PioneerContainer {
	async keepWarm(on: boolean): Promise<void> { await this.ctx.storage.put(KEEP_WARM_KEY, on); }

	override async onActivityExpired(): Promise<void> {
		if (await this.ctx.storage.get<boolean>(KEEP_WARM_KEY)) { this.renewActivityTimeout(); return; }
		await this.stop();
	}
}

async function readyContainer<T extends PioneerContainer>(env: Env, namespace: DurableObjectNamespace<T>, instance: string, timeoutMs = 120_000) {
	const container = getContainer(namespace, instance);
	await container.startAndWaitForPorts({
		ports: [12000],
		cancellationOptions: { instanceGetTimeoutMS: timeoutMs, portReadyTimeoutMS: timeoutMs, waitInterval: 500 },
		startOptions: {
			envVars: containerEnv(env), enableInternet: true,
			labels: { service: "keepkey-gateway", instance },
		},
	});
	return container;
}

// Durable payment watches are shared in the database, so one pool runs the ticks:
// prod once it has hosts, so blue can actually reach zero.
const monitorContainer = (env: Env) => prodPolicy(env).hosts.size > 0
	? readyContainer(env, env.PROD_CONTAINER, prodInstanceId(0))
	: readyContainer(env, env.PIONEER_CONTAINER, MAIN_INSTANCE_ID);

// Separate from the Container's own lifecycle alarms. This object survives all
// client disconnects and wakes the container while durable wallet watches exist.
export class RealtimeWatchdog extends DurableObject<Env> {
	async arm(): Promise<void> { await armPaymentMonitor(this.ctx.storage); }

	async alarm(): Promise<void> {
		try {
			const result = await runPaymentMonitor(this.ctx.storage, async () => {
				if (!this.env.REALTIME_SCHEDULER_SECRET) throw new Error("Scheduler is not configured");
				const container = await monitorContainer(this.env);
				const response = await container.fetch(new Request("http://container/api/v1/internal/realtime/tick", {
					method: "POST", headers: { "x-realtime-scheduler-secret": this.env.REALTIME_SCHEDULER_SECRET },
				}));
				if (!response.ok) throw new Error(`Monitor returned HTTP ${response.status}`);
				return await response.json() as BackgroundTickResult;
			});
			console.log(JSON.stringify({ event: "background_payment_monitor", ...result }));
		} catch {
			// A storage failure may precede re-arming. Preserve platform retries
			// as well as the scheduled retry; both paths are idempotent.
			console.error(JSON.stringify({ event: "background_payment_monitor", error: "tick_failed" }));
			throw new Error("Background payment monitor tick failed");
		}
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const startedAt = performance.now();
		let startupMs = 0;
		let status: number | undefined;
		let errorName: string | undefined;
		let errorCode: string | undefined;
		let errorReason: string | undefined;
		const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
		try {
			if (isInternalRealtimePath(new URL(request.url).pathname)) {
				status = 404;
				return new Response("Not found", { status: 404 });
			}
			// Logos: a wallet loads hundreds at startup and green never limited them.
			const takeoverCoin = isTakeoverHost(request.url) && new URL(request.url).pathname.startsWith("/coins/");
			for (const limit of takeoverCoin ? [] : requestRateLimits(request)) {
				const result = rateLimiter.take(limit.scope, limit.policy);
				if (!result.allowed) {
					status = 429;
					return Response.json(
						{ error: { code: "rate_limited", message: "Too many requests" }, requestId },
						{ status: 429, headers: { "Retry-After": String(result.retryAfterSeconds) } },
					);
				}
			}

			const policy = prodPolicy(env);
			const upstream = isTakeoverHost(request.url)
				? await serveTakeover(request, {
					coin: (name) => fetch(R2_COINS + name, { cf: { cacheEverything: true, cacheTtl: 86400 } }).catch(() => new Response(null, { status: 502 })),
					gateway: async (forwarded) => (await readyContainer(env, env.PIONEER_CONTAINER, MAIN_INSTANCE_ID)).fetch(forwarded),
					legacy: (forwarded) => fetch(forwarded),
				})
				: policy.hosts.has(new URL(request.url).hostname.toLowerCase())
				? await serveProd(request, policy, {
					instance: async (index, forwarded) => {
						let container;
						try { container = await readyContainer(env, env.PROD_CONTAINER, prodInstanceId(index), PROD_REQUEST_START_MS); }
						catch { throw new ContainerStartError("Container was unavailable before dispatch"); }
						return container.fetch(forwarded);
					},
					fetch: (forwarded) => fetch(forwarded),
				})
				: await (await readyContainer(env, env.PIONEER_CONTAINER, MAIN_INSTANCE_ID)).fetch(request);
			startupMs = Math.round(performance.now() - startedAt);
			const response = await publicOpenApiResponse(request, upstream);
			status = response.status;
			if (response.ok && changesDurablePaymentWatches(request)) {
				try {
					await env.REALTIME_WATCHDOG.getByName(MAIN_INSTANCE_ID).arm();
				} catch {
					status = 503;
					return Response.json({ error: { code: "realtime_unavailable", message: "Background monitoring could not be scheduled. Retry watch registration." } }, { status: 503 });
				}
			}
			if (status >= 400 && response.headers.get("content-type")?.includes("application/json")) {
				try {
					const body = await response.clone().json() as { error?: { code?: unknown; message?: unknown } };
					const code = body.error?.code;
					if (typeof code === "string" && /^[a-z_]{1,64}$/.test(code)) errorCode = code;
					if (code === "realtime_error" && typeof body.error?.message === "string") {
						const message = body.error.message;
						if (message.startsWith("addresses must contain between")) errorReason = "invalid_address_count";
						else if (message === "Each address requires a supported networkId and non-empty address") errorReason = "unsupported_network_or_invalid_address";
						else if (message.startsWith("Unsupported event:")) errorReason = "unsupported_event";
					}
					// Upstream failures are only diagnosable with the message; strip anything key-shaped.
					if (status >= 500 && typeof body.error?.message === "string") errorReason = body.error.message.replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]").slice(0, 200);
				} catch { /* Diagnostics must not change the response. */ }
			}
			return response;
		} catch (error) {
			errorName = error instanceof Error ? error.name : "UnknownError";
			throw error;
		} finally {
			const record = JSON.stringify({
				event: "gateway_request", requestId, method: request.method,
				path: new URL(request.url).pathname, status, startupMs,
				durationMs: Math.round(performance.now() - startedAt), errorName, errorCode, errorReason,
			});
			if (errorName || (status !== undefined && status >= 500)) console.error(record);
			else if (status !== undefined && status >= 400) console.warn(record);
			else console.log(record);
		}
	},

	// Every minute: hold the prod warm floor up (restarting any that died) and release
	// everything above it to scale to zero. No prod hosts configured = nothing warm.
	async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		const policy = prodPolicy(env);
		ctx.waitUntil(Promise.allSettled(Array.from({ length: policy.max }, async (_, index) => {
			const warm = policy.hosts.size > 0 && index < policy.min;
			await getContainer(env.PROD_CONTAINER, prodInstanceId(index)).keepWarm(warm);
			if (warm) await readyContainer(env, env.PROD_CONTAINER, prodInstanceId(index));
		})).then((results) => {
			const failed = results.flatMap((result, index) => result.status === "rejected" ? [prodInstanceId(index)] : []);
			if (failed.length) console.error(JSON.stringify({ event: "prod_warm_floor", failed }));
		}));
	},
} satisfies ExportedHandler<Env>;
