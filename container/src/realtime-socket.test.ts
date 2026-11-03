import { describe, expect, test } from "bun:test";
import { RealtimeHub } from "./realtime";
import { RealtimeSocketSession } from "./realtime-socket";
const watch={networkId:"eip155:1",address:"0x1111111111111111111111111111111111111111"};
function fixture(){const hub=new RealtimeHub({getTransactionHistory:async()=>({histories:[{transactions:[]}]})} as any,60000);const events:any[]=[];let closed=0;
 const session=new RealtimeSocketSession('socket-a',hub,async key=>key==='good'?{id:'owner',username:'alice'}:null,(...event)=>events.push(event),()=>{closed++});
 return{hub,session,events,closed:()=>closed};}
describe('authenticated Socket.IO watch contract',()=>{
 test('authentication alone stays idle; explicit subscribe owns its watches and sends the legacy ack',async()=>{
  const f=fixture();await f.session.receive('authenticate',{queryKey:'good'});expect(f.hub.activeAddressCount()).toBe(0);
  expect(f.events.find(e=>e[0]==='authenticated')[1]).toEqual({success:true,username:'alice'});
  expect(JSON.parse(f.events.find(e=>e[0]==='subscribedToUsername')[1]).username).toBe('alice');
  await f.session.receive('subscribe',{addresses:[watch]});expect(f.hub.activeAddressCount()).toBe(1);
  f.hub.upstreamChange(watch,'a'.repeat(64));expect(f.events.some(e=>e[0]==='transaction:incoming'&&e[1].refreshHint===true)).toBe(true);
  await f.session.receive('unsubscribe',{});expect(f.hub.activeAddressCount()).toBe(0);f.session.close();
 });
 test('join accepts only the username established by its query key',async()=>{
  const f=fixture();await f.session.receive('join',{queryKey:'good',username:'other'});expect(f.closed()).toBe(1);expect(f.hub.activeAddressCount()).toBe(0);
  const good=fixture();await good.session.receive('join',{queryKey:'good',username:'alice'});expect(good.events.some(e=>e[0]==='subscribedToUsername')).toBe(true);good.session.close();
 });
 test('REST portfolio chunks feed only connected legacy clients and explicit leases block late wallet inventory',async()=>{
  const f=fixture();f.hub.rememberPortfolio('owner',[{caip:'eip155:1/slip44:60',pubkey:watch.address}]);expect(f.hub.activeAddressCount()).toBe(0);
  await f.session.receive('authenticate',{queryKey:'good'});expect(f.hub.activeAddressCount()).toBe(1);
  const replacement={...watch,address:'0x2222222222222222222222222222222222222222'};
  const stream=f.hub.createSse('owner',[replacement],undefined);expect(f.hub.activeAddressCount()).toBe(1);
  f.hub.rememberPortfolio('owner',[{caip:'eip155:1/slip44:60',pubkey:watch.address}]);expect(f.hub.activeAddressCount()).toBe(1);
  f.events.length=0;f.hub.upstreamChange(watch,'a'.repeat(64));expect(f.events).toHaveLength(0);
  await stream.body!.cancel();expect(f.hub.activeAddressCount()).toBe(0);f.session.close();
 });
 test('disconnect during authentication cannot resurrect an active watch',async()=>{
  let done!:(v:any)=>void;const auth=new Promise<any>(resolve=>{done=resolve});const f=fixture();
  const session=new RealtimeSocketSession('late',f.hub,()=>auth,()=>{},()=>{});const pending=session.receive('authenticate',{queryKey:'good'});session.close();done({id:'owner',username:'alice'});await pending;
  expect(f.hub.activeSubscriptionCount()).toBe(0);f.session.close();
 });
});
