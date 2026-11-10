import { expect, test } from "bun:test";
import { ProviderMetrics, providerContext, type ProviderUsage } from "./provider-metrics";
import { ZerionClient } from "./zerion";

const ADDRESS = `0x${"1".repeat(40)}`;
const chains = { data: [{ id: "ethereum", attributes: { external_id: "0x1" } }] };

test("Zerion blocks paid fetches from background contexts while on-demand reads still work", async () => {
 let fetches=0;
 const writes:ProviderUsage[][]=[];
 const metrics=new ProviderMetrics(async rows=>{writes.push(rows)},()=>{});
 const client=new ZerionClient({apiKey:'fixture',metrics,fetch:(async url=>{
  fetches++;return Response.json(String(url).endsWith('/chains/')?chains:{data:[]});
 }) as typeof fetch});
 const reads:Array<()=>Promise<unknown>>=[()=>client.getTransactions(ADDRESS,{forceRefresh:true}),()=>client.getWalletPositions(ADDRESS,{forceRefresh:true}),()=>client.getDefiPositions(ADDRESS)];
 for(const source of ['background_monitor','realtime_poll'] as const){
  for(const read of reads){
   await expect(providerContext.run({source},read)).rejects.toThrow('on-demand');
  }
 }
 expect(fetches).toBe(0);
 await providerContext.run({source:'http',clientId:'wallet-open'},()=>client.getTransactions(ADDRESS,{forceRefresh:true}));
 expect(fetches).toBe(2);
 await metrics.flush();
 expect(writes[0].filter(row=>row.outcome.startsWith('upstream_')).reduce((n,row)=>n+row.count,0)).toBe(2);
 expect(writes[0].some(row=>row.outcome==='policy_blocked')).toBe(true);
});

test("counts physical fetches separately from joined and warm reads with isolated caller attribution", async () => {
 const writes: ProviderUsage[][] = [], logs: Record<string, unknown>[] = [];
 const metrics = new ProviderMetrics(async rows => { writes.push(rows); }, record => { logs.push(record); });
 let calls = 0;
 const client = new ZerionClient({ apiKey: "secret-fixture", metrics, fetch: (async url => {
  calls++; await Bun.sleep(1);
  return Response.json(String(url).endsWith("/chains/") ? chains : { data: [] });
 }) as typeof fetch });
 await Promise.all([
  providerContext.run({ source: "http", clientId: "client-one" }, () => client.getTransactions(ADDRESS)),
  providerContext.run({ source: "http", clientId: "client-two" }, () => client.getTransactions(ADDRESS)),
 ]);
 await client.getTransactions(ADDRESS);
 await providerContext.run({ source: "http", clientId: "client-one" }, () => client.getTransactions(ADDRESS, { forceRefresh: true }));
 await metrics.flush();
 expect(calls).toBe(3); // chains, normal history, forced history
 const rows = writes[0];
 expect(rows.filter(row => row.outcome.startsWith("upstream_")).reduce((sum, row) => sum + row.count, 0)).toBe(calls);
 expect(rows.find(row => row.outcome === "cache_join")).toMatchObject({ clientId: "client-two", count: 1 });
 expect(rows.find(row => row.outcome === "cache_memory")).toMatchObject({ source: "unknown", count: 1 });
 expect(rows.find(row => row.forced)).toMatchObject({ operation: "transactions", source: "http", status: 200 });
 expect(JSON.stringify({ writes, logs })).not.toContain(ADDRESS);
 expect(JSON.stringify({ writes, logs })).not.toContain("secret-fixture");
});

test("records 429, network and decode failures once per attempt without exposing provider errors", async () => {
 const writes: ProviderUsage[][] = [];
 const metrics = new ProviderMetrics(async rows => { writes.push(rows); }, () => {});
 let mode = "429";
 const client = new ZerionClient({ apiKey: "fixture", metrics, fetch: (async url => {
  if (String(url).endsWith("/chains/")) return Response.json(chains);
  if (mode === "429") return new Response(null, { status: 429 });
  if (mode === "network") throw new Error(`private provider URL ${ADDRESS}`);
  return new Response("invalid JSON");
 }) as typeof fetch });
 for (const next of ["429", "network", "decode"]) {
  mode = next; await expect(client.getTransactions(ADDRESS, { forceRefresh: true })).rejects.toThrow();
 }
 await metrics.flush();
 const rows = writes[0].filter(row => row.operation === "transactions");
 expect(rows.map(row => [row.outcome, row.status, row.count])).toEqual([
  ["upstream_http_error", 429, 1], ["upstream_network_error", 0, 1], ["upstream_decode_error", 200, 1],
 ]);
 expect(JSON.stringify(writes)).not.toContain(ADDRESS);
});

test("failed persistence retains cumulative snapshots and records calls arriving during a flush", async () => {
 let now = Date.now(), fail = true, release!: () => void;
 const writes: ProviderUsage[][] = [];
 const metrics = new ProviderMetrics(async rows => {
  writes.push(rows);
  if (fail) throw new Error("database unavailable");
  await new Promise<void>(resolve => { release = resolve; });
 }, () => {}, () => now);
 metrics.record("transactions", "upstream_ok");
 await metrics.flush();
 fail = false;
 const running = metrics.flush();
 metrics.record("transactions", "upstream_ok"); release(); await running;
 const final = metrics.flush(); expect(writes.at(-1)![0].count).toBe(2); release(); await final;
 now += 180_000;
 const expired = metrics.flush(); release(); await expired;
 const prior = writes.length; await metrics.flush(); expect(writes).toHaveLength(prior);
});

test("broken metrics storage and logger do not fail successful provider reads", async () => {
 const metrics = new ProviderMetrics(async () => { throw new Error("offline"); }, () => { throw new Error("broken logger"); });
 const client = new ZerionClient({ apiKey: "fixture", metrics, fetch: (async url => Response.json(String(url).endsWith("/chains/") ? chains : { data: [] })) as typeof fetch });
 expect(await client.getWalletPositions(ADDRESS)).toEqual([]);
 await metrics.close();
});
