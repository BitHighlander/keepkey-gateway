import { expect, test } from "bun:test";
import { createApp } from "./http";
import type { Database } from "./database";
import type { AppConfig } from "./config";
import { ProviderMetrics, type ProviderUsage } from "./provider-metrics";
import { ZerionClient } from "./zerion";

test("HTTP metrics use the authenticated client and do not attribute unauthenticated requests", async () => {
 const rows: ProviderUsage[] = [];
 const metrics = new ProviderMetrics(async values => { rows.push(...values); }, () => {});
 const zerion = new ZerionClient({ apiKey: "private-fixture-key", metrics, fetch: (async (_input: string | URL | Request) => Response.json({ data: [] })) as typeof fetch });
 const app = createApp({ config: {} as AppConfig, database: { authenticate: async key => key === "registered" ? { id: "trusted-client", username: "fixture" } : null } as Database, zerion });
 const path = "http://fixture.invalid/api/v1/zerion/positions/0x1111111111111111111111111111111111111111";
 expect((await app.fetch(new Request(path, { headers: { Authorization: "unregistered" } }))).status).toBe(401);
 await metrics.flush(); expect(rows).toHaveLength(0);
 expect((await app.fetch(new Request(path, { headers: { Authorization: "registered", "x-client-id": "spoofed-client" } }))).status).toBe(200);
 await metrics.flush();
 expect(rows).toHaveLength(2);
 expect(rows.every(row => row.source === "http" && row.clientId === "trusted-client")).toBe(true);
});
