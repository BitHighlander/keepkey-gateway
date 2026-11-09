import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { createDatabase, type Database } from "./database";
import { loadConfig } from "./config";
import { ProviderMetrics, providerContext } from "./provider-metrics";

const url = process.env.CACHE_TEST_DATABASE_URL || process.env.REALTIME_TEST_DATABASE_URL;
const integrationTest = url ? test : test.skip;
let database: Database, sql: SQL;
const clientId = crypto.randomUUID();
beforeAll(async () => {
 if (!url) return;
 database = createDatabase(loadConfig({ DATABASE_URL: url }));
 await database.migrate();
 sql = new SQL(url, { max: 1 });
});
afterAll(async () => {
 if (!sql) return;
 await sql`DELETE FROM provider_usage_minute WHERE client_id = ${clientId}`;
 await database.close(); await sql.close();
});

integrationTest("minute totals survive repeated snapshots and multiple gateway processes without double counting", async () => {
 const first = new ProviderMetrics(async rows => { try { await database.recordProviderUsage(rows); } catch (error) { console.error(error); throw error; } }, () => {});
 const second = new ProviderMetrics(async rows => { try { await database.recordProviderUsage(rows); } catch (error) { console.error(error); throw error; } }, () => {});
 await providerContext.run({ source: "http", clientId }, async () => {
  first.record("transactions", "upstream_ok", { status: 200, durationMs: 10 });
  await first.flush(); await first.flush();
  first.record("transactions", "upstream_ok", { status: 200, durationMs: 20 });
  second.record("transactions", "upstream_http_error", { status: 429, durationMs: 5 });
  await first.close(); await second.close();
 });
 const [row] = await sql`SELECT sum(count)::int AS attempts, sum(duration_ms)::int AS duration FROM provider_usage_minute WHERE client_id = ${clientId}`;
 expect(row).toMatchObject({ attempts: 3, duration: 35 });
});
