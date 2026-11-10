import { expect, test } from "bun:test";
import { createApp } from "./http";
import type { Database } from "./database";
import type { AppConfig } from "./config";
import { ProviderMetrics, type ProviderUsage } from "./provider-metrics";
import { ZerionClient } from "./zerion";

test('provider budget status is authenticated and never fetches paid data',async()=>{
 const app=createApp({config:{} as AppConfig,database:{authenticate:async key=>key==='valid'?{id:'fixture',username:'fixture'}:null,getProviderUsage:async()=>({provider:'zerion',state:'warning',windows:[{kind:'day',used:800,limit:1000}]})} as any});
 expect((await app.fetch(new Request('http://fixture/api/v1/provider/usage'))).status).toBe(401);
 const response=await app.fetch(new Request('http://fixture/api/v1/provider/usage',{headers:{Authorization:'valid'}}));
 expect(response.status).toBe(200);expect((await response.json() as any).state).toBe('warning');
});

test("HTTP metrics use the authenticated client and do not attribute unauthenticated requests", async () => {
 const rows: ProviderUsage[] = [];
 const metrics = new ProviderMetrics(async values => { rows.push(...values); }, () => {});
 const zerion = new ZerionClient({ apiKey: "private-fixture-key", metrics, fetch: (async (_input: string | URL | Request) => Response.json({ data: [] })) as typeof fetch });
 const app = createApp({ config: {} as AppConfig, database: { authenticate: async key => key === "registered" ? { id: "trusted-client", username: "fixture" } : null } as Database, zerion });
 const path = "http://fixture.invalid/api/v1/zerion/positions/0x1111111111111111111111111111111111111111";
 expect((await app.fetch(new Request(path, { headers: { Authorization: "unregistered" } }))).status).toBe(401);
 await metrics.flush(); expect(rows.filter(row=>row.count>0)).toHaveLength(0);
 expect((await app.fetch(new Request(path, { headers: { Authorization: "registered", "x-client-id": "spoofed-client" } }))).status).toBe(200);
 await metrics.flush();
 expect(rows.filter(row=>row.count>0)).toHaveLength(2);
 expect(rows.filter(row=>row.count>0).every(row => row.source === "http" && row.clientId === "trusted-client")).toBe(true);
});
