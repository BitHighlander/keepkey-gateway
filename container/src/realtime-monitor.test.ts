import { describe, expect, test } from "bun:test";
import { RealtimeMonitor } from "./realtime-monitor";
import { RealtimeHub } from "./realtime";
import { createApp } from "./http";
import type { AppConfig } from "./config";
import type { Database } from "./database";
import type { DurableRealtimeStore, DurableWatch, DurableEvent } from "./realtime-store";
const watch={networkId:"bip122:12a765e31ffd4059bada1e25190f6e98",address:"Mtub-public-fixture"};
function storeFixture(){const rows:DurableWatch[]=[],events:DurableEvent[]=[],acked=new Set<string>();let seq=0;
 const store:DurableRealtimeStore={
  replaceWatches:async(clientId,walletScope,watches,o)=>{for(let i=rows.length-1;i>=0;i--)if(rows[i].clientId===clientId&&rows[i].walletScope===walletScope)rows.splice(i,1);if(o.enabled)rows.push(...watches.map(w=>({...w,clientId,walletScope,since:o.since??Date.now()})))},
  removeWallet:async(c,s)=>{await store.replaceWatches(c,s,[],{enabled:false})},listActiveWatches:async()=>[...rows],
  enqueueEvents:async(incoming)=>{const created:DurableEvent[]=[];for(const e of incoming)if(rows.some(w=>w.clientId===e.clientId&&w.walletScope===e.walletScope&&w.address===e.payload.watchAddress&&w.networkId===e.payload.networkId)&&!events.some(x=>x.clientId===e.clientId&&x.walletScope===e.walletScope&&x.eventId===e.eventId)){const row={...e,id:String(++seq),createdAt:Date.now()};events.push(row);created.push(row)}return created},
  replay:async(clientId,o)=>{const found=events.filter(e=>e.clientId===clientId&&e.walletScope===o.walletScope&&BigInt(e.id)>BigInt(o.after??0)&&!acked.has(e.id));return{events:found,cursor:found.at(-1)?.id||String(o.after??0)}},
  ack:async(c,o)=>{for(const e of events)if(e.clientId===c&&e.walletScope===o.walletScope&&(o.eventIds?.includes(e.eventId)||o.cursor&&BigInt(e.id)<=BigInt(o.cursor)))acked.add(e.id)},prune:async()=>0,
 };return{store,rows,events};}
describe('durable monitor and replay integration',()=>{
 test('queues activity with no connected Vault and deduplicates across monitor restarts until acknowledged',async()=>{
  const f=storeFixture();let confirmed=false;const delivered:any[]=[];
  const history:any={getTransactionHistory:async(_b:any,o:any)=>{expect(o.forceRefresh).toBe(true);return{histories:[{transactions:[{txid:'a'.repeat(64),timestamp:Date.now(),status:confirmed?'confirmed':'pending',value:'whole-tx-value-untrusted'}]}]}}};
  const monitor=new RealtimeMonitor(history,f.store,(...e)=>delivered.push(e));
  await monitor.register('owner',{walletScope:'wallet-one',addresses:[watch],enabled:true});
  expect(await monitor.tick()).toEqual({watches:1,queued:1,failures:0});confirmed=true;
  expect(await monitor.tick()).toEqual({watches:1,queued:1,failures:0});
  const restarted=new RealtimeMonitor(history,f.store,()=>{});expect((await restarted.tick()).queued).toBe(0);
  const replay=await f.store.replay('owner',{walletScope:'wallet-one'});expect(replay.events).toHaveLength(2);
  expect(replay.events[0].payload).toMatchObject({watchAddress:watch.address,networkId:watch.networkId,refreshHint:true});
  expect(replay.events[0].payload.value).toBeUndefined();expect(replay.events[0].payload.caip).toBeUndefined();
  expect((await f.store.replay('other',{walletScope:'wallet-one'})).events).toHaveLength(0);
  await f.store.ack('owner',{walletScope:'wallet-one',cursor:replay.cursor});expect((await f.store.replay('owner',{walletScope:'wallet-one'})).events).toHaveLength(0);
 });
 test('does not replay old pre-registration history and cannot enqueue after a wallet is removed mid-read',async()=>{
  const f=storeFixture();let release!:(v:any)=>void;const pending=new Promise(resolve=>{release=resolve});
  const monitor=new RealtimeMonitor({getTransactionHistory:async()=>pending} as any,f.store,()=>{});
  await monitor.register('owner',{walletScope:'wallet-one',addresses:[watch],enabled:true});const running=monitor.tick();await Bun.sleep(1);
  await monitor.register('owner',{walletScope:'wallet-one',enabled:false});release({histories:[{transactions:[{txid:'a'.repeat(64),status:'confirmed',timestamp:Date.now()}]}]});
  expect((await running).queued).toBe(0);expect(f.events).toHaveLength(0);
  await monitor.register('owner',{walletScope:'wallet-one',addresses:[watch],enabled:true});
  expect((await new RealtimeMonitor({getTransactionHistory:async()=>({histories:[{transactions:[{txid:'old',timestamp:Date.now()-60000,status:'confirmed'}]}]})} as any,f.store,()=>{}).tick()).queued).toBe(0);
 });
 test('scheduler authentication and explicit durable registration remain separate from generic portfolio/auth use',async()=>{
  const f=storeFixture(),monitor=new RealtimeMonitor({getTransactionHistory:async()=>({histories:[]})} as any,f.store,()=>{}),hub=new RealtimeHub({getTransactionHistory:async()=>({histories:[]})} as any);
  const app=createApp({config:{realtimeSchedulerSecret:'scheduler-test-secret'} as AppConfig,database:{authenticate:async()=>({id:'owner',username:'fixture'})} as unknown as Database,realtime:hub,realtimeMonitor:monitor});
  const call=(path:string,body?:any,headers:any={Authorization:'user-test'})=>app.fetch(new Request('http://fixture.invalid/api/v1'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})}));
  expect((await call('/internal/realtime/tick',{})).status).toBe(401);expect(f.rows).toHaveLength(0);
  expect((await call('/events/watches',{walletScope:'wallet-one',enabled:true,addresses:[watch]})).status).toBe(200);expect(f.rows).toHaveLength(1);
  const tick=await call('/internal/realtime/tick',{}, {'x-realtime-scheduler-secret':'scheduler-test-secret'});expect(tick.status).toBe(200);expect(await tick.json()).toEqual({watches:1,queued:0,failures:1});
  expect((await call('/events/replay')).status).toBe(400);hub.close();
 });
});

test('durable pending transactions without a block timestamp remain refresh hints and truncation is explicit', async () => {
 const f=storeFixture();
 const txs=[{txid:'pending-zero-time',timestamp:0,status:'pending'},...Array.from({length:49},(_,i)=>({txid:`confirmed-old-${i}`,timestamp:Date.now()-60000,status:'confirmed'}))];
 const monitor=new RealtimeMonitor({getTransactionHistory:async()=>({histories:[{transactions:txs}]})} as any,f.store,()=>{});
 await monitor.register('owner',{walletScope:'wallet-one',addresses:[watch],enabled:true});
 const result:any=await monitor.tick(); expect(result.queued).toBe(1); expect(result.diagnostics).toMatchObject({historyCoverage:'latest-provider-page',possiblyTruncated:1});
 expect(f.events[0].payload).toMatchObject({timestampEstimated:true,refreshHint:true}); expect(f.events[0].payload.value).toBeUndefined();
});
