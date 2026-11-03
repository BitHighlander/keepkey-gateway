import { describe, expect, test } from 'bun:test';
import { base58, bech32 } from '@scure/base';
import { getBytes, sha256, AbiCoder } from 'ethers';
import { validateSwapAddress } from './swap-addresses';
import { SwapAssetResolver } from './swap-assets';
import { QuoteRouter } from './swap';
const eth='eip155:1/slip44:60',btc='bip122:000000000019d6689c085ae165831e93/slip44:0',ltc='bip122:12a765e31ffd4059bada1e25190f6e98/slip44:2';
const owner='0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const hash=Uint8Array.from({length:20},(_,i)=>i+1);
const bc=bech32.encode('bc',[0,...bech32.toWords(hash)]),lc=bech32.encode('ltc',[0,...bech32.toWords(hash)]);
const req={sellAsset:eth,buyAsset:ltc,sellAmount:'0.01',senderAddress:owner,recipientAddress:lc};
describe('swap request parity',()=>{
 test('leaves valid high precision amounts for the asset adapter to validate',async()=>{
  const amount='0.000000000000000000000001';let received='';
  const router=new QuoteRouter([{key:'fixture',eligible:()=>true,quote:async(request)=>{received=request.sellAmount;return {amountOut:'1'};}}]);
  await router.quote({...req,sellAmount:amount});expect(received).toBe(amount);
 });
 test('validates chain and checksum before any provider request',async()=>{
  let calls=0;const router=new QuoteRouter([{key:'fixture',eligible:()=>true,quote:async()=>{calls++;return {amountOut:'1'};}}]);
  await expect(router.quote({...req,recipientAddress:owner})).rejects.toThrow('recipientAddress');
  await expect(router.quote({...req,recipientAddress:lc.slice(0,-1)+(lc.endsWith('q')?'p':'q')})).rejects.toThrow('recipientAddress');
  expect(calls).toBe(0);expect(validateSwapAddress(btc,bc)).toBeNull();expect(validateSwapAddress(ltc,lc)).toBeNull();expect(validateSwapAddress(ltc,bc)).not.toBeNull();
  const payload=Uint8Array.from([28,184,...hash]),checksum=getBytes(sha256(getBytes(sha256(payload)))).slice(0,4);
  expect(validateSwapAddress('bip122:00040fe8ec8471911baa1db1266ea15d/slip44:133',base58.encode(Uint8Array.from([...payload,...checksum])))).toBeNull();
 });
 test('memoless requests skip memo providers and reject false memoless responses',async()=>{
  let thor=0;const router=new QuoteRouter([
   {key:'thorchain',eligible:()=>true,quote:async()=>{thor++;return {amountOut:'2',txs:[{txParams:{memo:'=:LTC.LTC'}}]};}},
   {key:'bad',memoless:true,eligible:()=>true,quote:async()=>({amountOut:'3',txs:[{txParams:{memo:'wrong'}}]})},
   {key:'nearIntents',memoless:true,eligible:()=>true,quote:async()=>({amountOut:'1',txs:[{txParams:{to:owner,data:'0x'}}]})},
  ]);const result=await router.quote({...req,memoless:true});expect(thor).toBe(0);expect(result.map(r=>r.integration)).toEqual(['nearIntents']);
 });
 test('resolves unlisted ERC20 precision on demand and shares concurrent metadata requests',async()=>{
  const caip='eip155:1/erc20:0x1111111111111111111111111111111111111111';let calls=0;
  const resolver=new SwapAssetResolver({evm:{readRpc:async(_chain,_method,p:any)=>{calls++;return {success:true as const,data:p[0].data==='0x313ce567'?'0x06':AbiCoder.defaultAbiCoder().encode(['string'],['SIX'])};}}});
  expect(resolver.known(caip)).toBe(true);const [a,b]=await Promise.all([resolver.resolve(caip),resolver.resolve(caip)]);expect(a).toEqual(b);expect(a.decimals).toBe(6);expect(a.symbol).toBe('SIX');expect(calls).toBe(2);await resolver.resolve(caip);expect(calls).toBe(2);
  const unavailable=new SwapAssetResolver();await expect(unavailable.resolve(caip)).rejects.toThrow('precision');
 });
});
