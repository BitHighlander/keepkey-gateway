import { expect, test } from "bun:test";
import { createApp } from "./http";
import type { Database } from "./database";
import type { AppConfig } from "./config";
import { ProviderMetrics, type ProviderUsage } from "./provider-metrics";
import { ZerionClient } from "./zerion";
import {HistoryClient} from './history';

test('automatic history refreshes cannot force another paid fetch or claim fresh cache data',async()=>{
 let calls=0;
 const zerion=new ZerionClient({apiKey:'fixture',fetch:(async(input:string|URL|Request)=>{
  calls++;return Response.json(String(input).endsWith('/chains/')?{data:[{id:'ethereum',attributes:{external_id:'0x1'}}]}:{data:[]});
 }) as typeof fetch});
 const app=createApp({config:{} as AppConfig,database:{authenticate:async()=>({id:'fixture',username:'fixture'})} as any,history:new HistoryClient({zerion})});
 const read=(reason:string)=>app.fetch(new Request('http://fixture/api/v1/tx/history?forceRefresh=true',{method:'POST',headers:{Authorization:'fixture','Content-Type':'application/json'},body:JSON.stringify({queries:[{caip:'eip155:1/slip44:60',pubkey:'0x'+'1'.repeat(40)}],refreshReason:reason})}));
 expect((await read('wallet-open')).status).toBe(200);expect(calls).toBe(2);
 const automatic:any=await(await read('automatic')).json();
 expect(automatic.histories[0]).toMatchObject({fresh:false,cached:true,fetchedAt:0});expect(calls).toBe(2);
 expect((await read('manual')).status).toBe(200);expect(calls).toBe(3);
});

test('provider budget status is authenticated and never fetches paid data',async()=>{
 const app=createApp({config:{} as AppConfig,database:{authenticate:async(key:string)=>key==='valid'?{id:'fixture',username:'fixture'}:null,getProviderUsage:async()=>({provider:'zerion',state:'warning',windows:[{kind:'day',used:800,limit:1000}]})} as any});
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
