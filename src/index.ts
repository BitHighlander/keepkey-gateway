import { Container, getContainer } from "@cloudflare/containers";
import { DurableObject } from "cloudflare:workers";
import { containerEnv, type ContainerRuntimeEnv } from "./container-env";
import { MemoryRateLimiter, requestRateLimits } from "./rate-limit";
import { publicOpenApiResponse } from "./public-openapi";
import { armPaymentMonitor, runPaymentMonitor, changesDurablePaymentWatches, isInternalRealtimePath, type BackgroundTickResult } from "./realtime-scheduler";

interface Env extends ContainerRuntimeEnv {
	PIONEER_CONTAINER: DurableObjectNamespace<PioneerContainer>;
	REALTIME_WATCHDOG: DurableObjectNamespace<RealtimeWatchdog>;
}

const MAIN_INSTANCE_ID = "pioneer-main-recovery-20261003";
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

async function readyContainer(env: Env) {
	const container = getContainer(env.PIONEER_CONTAINER, MAIN_INSTANCE_ID);
	await container.startAndWaitForPorts({
		ports: [12000],
		cancellationOptions: { instanceGetTimeoutMS: 120_000, portReadyTimeoutMS: 120_000, waitInterval: 500 },
		startOptions: {
			envVars: containerEnv(env), enableInternet: true,
			labels: { service: "keepkey-gateway", instance: MAIN_INSTANCE_ID },
		},
	});
	return container;
}

// Separate from the Container's own lifecycle alarms. This object survives all
// client disconnects and wakes the container while durable wallet watches exist.
export class RealtimeWatchdog extends DurableObject<Env> {
	async arm(): Promise<void> { await armPaymentMonitor(this.ctx.storage); }

	async alarm(): Promise<void> {
		try {
			const result = await runPaymentMonitor(this.ctx.storage, async () => {
				if (!this.env.REALTIME_SCHEDULER_SECRET) throw new Error("Scheduler is not configured");
				const container = await readyContainer(this.env);
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
			for (const limit of requestRateLimits(request)) {
				const result = rateLimiter.take(limit.scope, limit.policy);
				if (!result.allowed) {
					status = 429;
					return Response.json(
						{ error: { code: "rate_limited", message: "Too many requests" }, requestId },
						{ status: 429, headers: { "Retry-After": String(result.retryAfterSeconds) } },
					);
				}
			}

			const container = await readyContainer(env);
			startupMs = Math.round(performance.now() - startedAt);
			const response = await publicOpenApiResponse(request, await container.fetch(request));
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
} satisfies ExportedHandler<Env>;
