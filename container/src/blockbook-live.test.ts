import { describe, expect, test } from "bun:test";
import { BlockbookLiveFeed, type LiveSocket } from "./blockbook-live";
const NETWORK="bip122:12a765e31ffd4059bada1e25190f6e98", account={networkId:NETWORK,address:"Mtub-public-fixture"};
class FakeSocket implements LiveSocket {
 readyState=0; sent:any[]=[]; closed=false; listeners=new Map<string,Array<(e:any)=>void>>();
 addEventListener(type:string,fn:(e:any)=>void){const list=this.listeners.get(type)||[];list.push(fn);this.listeners.set(type,list)}
 send(frame:string){this.sent.push(JSON.parse(frame))}
 close(){this.closed=true;this.readyState=3;this.emit("close",{})}
 emit(type:string,event:any){for(const fn of this.listeners.get(type)||[])fn(event)}
 open(){this.readyState=1;this.emit("open",{})}
 message(data:any){this.emit("message",{data:JSON.stringify(data)})}
 ack(){this.message({id:this.sent.find(s=>s.method==='subscribeAddresses').id,data:{subscribed:true}})}
}
describe("active Blockbook push feed",()=>{
 test("is idle until watched, expands xpubs and maps leaf notifications only to their original leases",async()=>{
  const sockets:FakeSocket[]=[],events:any[]=[],syncs:any[]=[];let reads=0;
  const feed=new BlockbookLiveFeed({getPubkeyInfo:async()=>{reads++;return{tokens:[{name:"Mleaf-fixture"}]}},websocketEndpoint:()=>"wss://fixture.invalid/redacted"},
   {change:(...args)=>events.push(args),sync:(...args)=>syncs.push(args)}, {socket:()=>{const s=new FakeSocket();sockets.push(s);return s}});
  expect(reads).toBe(0);expect(sockets).toHaveLength(0);
  feed.replace([account]);await Bun.sleep(1);expect(reads).toBe(1);expect(sockets).toHaveLength(1);
  const s=sockets[0];s.open();expect(s.sent.find(f=>f.method==='subscribeAddresses').params.addresses).toEqual(["Mleaf-fixture"]);
  expect(s.sent.find(f=>f.method==='subscribeNewBlock')).toBeDefined();expect(feed.covers(account)).toBe(false);
  s.ack();expect(feed.covers(account)).toBe(true);
  const id=s.sent.find(f=>f.method==='subscribeAddresses').id;
  s.message({id,data:{address:"unknown-leaf",tx:{txid:"a".repeat(64)}}});expect(events).toHaveLength(0);
  s.message({id,data:{address:"Mleaf-fixture",tx:{txid:"a".repeat(64),confirmations:2}}});
  expect(events).toEqual([[account,"a".repeat(64),true]]);expect(syncs[0]).toEqual([NETWORK,"upstream_reconnected"]);
  const block=s.sent.find(f=>f.method==='subscribeNewBlock').id;s.message({id:block,data:{height:100}});expect(syncs.at(-1)).toEqual([NETWORK,"new_block"]);
  feed.close();expect(s.closed).toBe(true);expect(feed.covers(account)).toBe(false);
 });
 test("reconnects and requests catchup only while consumers exist",async()=>{
  const sockets:FakeSocket[]=[],syncs:any[]=[];
  const feed=new BlockbookLiveFeed({getPubkeyInfo:async()=>({tokens:[{name:"Mleaf"}]}),websocketEndpoint:()=>"wss://fixture.invalid"},
   {change:()=>{},sync:(...a)=>syncs.push(a)},{retryMs:5,socket:()=>{const s=new FakeSocket();sockets.push(s);return s}});
  feed.replace([account]);await Bun.sleep(1);sockets[0].open();sockets[0].ack();sockets[0].close();
  await Bun.sleep(10);expect(sockets).toHaveLength(2);sockets[1].open();sockets[1].ack();expect(syncs).toHaveLength(2);
  feed.replace([]);await Bun.sleep(15);expect(sockets[1].closed).toBe(true);expect(sockets).toHaveLength(2);
 });
 test("an unavailable or unresolved account remains eligible for polling and does not create an idle socket",async()=>{
  let opens=0;const feed=new BlockbookLiveFeed({getPubkeyInfo:async()=>{throw new Error('offline')},websocketEndpoint:()=>null},{change:()=>{},sync:()=>{}},{socket:()=>{opens++;return new FakeSocket()}});
  feed.replace([account]);await Bun.sleep(1);expect(feed.covers(account)).toBe(false);expect(opens).toBe(0);feed.close();
 });
 test("discarded async expansion cannot resurrect a removed wallet watch",async()=>{
  let done!:(v:any)=>void,opens=0;
  const pending=new Promise(resolve=>{done=resolve});
  const feed=new BlockbookLiveFeed({getPubkeyInfo:async()=>pending,websocketEndpoint:()=>"wss://fixture.invalid"},{change:()=>{},sync:()=>{}},{socket:()=>{opens++;return new FakeSocket()}});
  feed.replace([account]);feed.close();done({tokens:[{name:"Mleaf"}]});await Bun.sleep(1);expect(opens).toBe(0);
 });
});
