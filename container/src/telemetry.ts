import type { Database } from "./database";

const OUTCOMES = new Set(["ok", "slow", "timeout", "error", "degraded"]);

export function sanitizeVaultTelemetry(raw: unknown): Record<string, unknown>[] {
	if (!Array.isArray(raw)) return [];
	return raw.slice(0, 100).map((value) => {
		const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
		const clientTotalMs = numeric(record.clientTotalMs, 0, 600_000) ?? 0;
		const serverMs = numeric(record.serverMs, 0, 600_000);
		const phases = record.phases && typeof record.phases === "object" && !Array.isArray(record.phases) ? {
			networkMs: numeric(record.phases.networkMs, 0, 600_000),
			parseMs: numeric(record.phases.parseMs, 0, 600_000),
			renderMs: numeric(record.phases.renderMs, 0, 600_000),
		} : null;
		return {
			traceId: text(record.traceId, 64),
			serverMs,
			clientTotalMs,
			networkMs: serverMs === null ? null : Math.max(0, clientTotalMs - serverMs),
			outcome: OUTCOMES.has(record.outcome) ? record.outcome : "unknown",
			degraded: record.degraded === true,
			phases,
			appVersion: text(record.appVersion, 32),
			platform: text(record.platform, 32),
			at: numeric(record.at, 0, 4_102_444_800_000),
		};
	});
}

export class VaultTelemetry {
	constructor(private readonly database: Database) {}

	async recordBatch(clientId: string, raw: unknown): Promise<{ accepted: number }> {
		try {
			const records = sanitizeVaultTelemetry(raw);
			return { accepted: await this.database.recordVaultTelemetry(clientId, records) };
		} catch (error) {
			console.warn(JSON.stringify({ event: "vault_telemetry_write_failed", error: error instanceof Error ? error.message : String(error) }));
			return { accepted: 0 };
		}
	}
}

function numeric(value: unknown, min: number, max: number): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return Math.round(Math.min(max, Math.max(min, value)));
}

function text(value: unknown, max: number): string | null {
	return typeof value === "string" ? value.slice(0, max) : null;
}
