import { describe, expect, test } from "bun:test";
import { sanitizeVaultTelemetry } from "./telemetry";

describe("Vault telemetry", () => {
	test("accepts only bounded timing metadata and derives network time", () => {
		const [record] = sanitizeVaultTelemetry([{ traceId: "x".repeat(100), clientTotalMs: 4200.4, serverMs: 1200.2, outcome: "slow", degraded: false, appVersion: "1.2.3", platform: "desktop-mac", at: 1_800_000_000_000, address: "must-not-survive" }]);
		expect(record).toMatchObject({ clientTotalMs: 4200, serverMs: 1200, networkMs: 3000, outcome: "slow", degraded: false });
		expect(String(record.traceId).length).toBe(64);
		expect(record).not.toHaveProperty("address");
	});

	test("caps batches and clamps hostile numeric input", () => {
		const records = sanitizeVaultTelemetry(Array.from({ length: 150 }, () => ({ clientTotalMs: Number.POSITIVE_INFINITY, serverMs: 900_000, outcome: "invented" })));
		expect(records).toHaveLength(100);
		expect(records[0]).toMatchObject({ clientTotalMs: 0, serverMs: 600000, networkMs: 0, outcome: "unknown" });
	});
});
