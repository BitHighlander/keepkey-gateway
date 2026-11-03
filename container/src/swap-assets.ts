import assets from '../data/assets.json';
import { AbiCoder, decodeBytes32String } from 'ethers';
import type { EvmClient } from './evm';

export interface SwapAssetMetadata { assetId: string; chainId: string; symbol: string; decimals: number }
export function staticSwapAsset(caip: string): SwapAssetMetadata | undefined {
 const asset = (Object.values(assets) as Array<{assetId:string;decimals?:number}>).find(a => caip.startsWith('eip155:') ? a.assetId.toLowerCase() === caip.toLowerCase() : a.assetId === caip);
 return asset && Number.isInteger(asset.decimals) ? asset as SwapAssetMetadata : undefined;
}
/** Token eligibility follows supported chains; precision must still be verified.
 * No startup traffic or background refresh, and no assumed 18-decimal tokens. */
export class SwapAssetResolver {
 private readonly cache = new Map<string, { value: SwapAssetMetadata; expires: number }>();
 private readonly flights = new Map<string, Promise<SwapAssetMetadata>>();
 constructor(private readonly options: { fetch?: typeof fetch; evm?: Pick<EvmClient,'readRpc'>; nownodesApiKey?: string } = {}) {}
 known(caip: string): boolean {
  return !!staticSwapAsset(caip) || /^eip155:\d+\/erc20:0x[\da-f]{40}$/i.test(caip)
   || /^solana:[^/]+\/token:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(caip);
 }
 async resolve(caip: string): Promise<SwapAssetMetadata> {
  const pinned = staticSwapAsset(caip); if (pinned) return pinned;
  const key = caip.startsWith('eip155:')?caip.toLowerCase():caip, cached = this.cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  const existing = this.flights.get(key); if (existing) return existing;
  const flight = this.load(caip).then(value => {
   if (this.cache.size >= 512) this.cache.delete(this.cache.keys().next().value!);
   this.cache.set(key,{value,expires:Date.now()+300_000});return value;
  }).finally(()=>this.flights.delete(key));
  this.flights.set(key,flight);return flight;
 }
 private async load(caip: string): Promise<SwapAssetMetadata> {
  const [chainId, asset] = caip.split('/');
  if (/^eip155:\d+$/.test(chainId) && /^erc20:0x[\da-f]{40}$/i.test(asset) && this.options.evm) {
   const to=asset.slice(6);
   const decimalResult=await this.options.evm.readRpc(chainId,'eth_call',[{to,data:'0x313ce567'},'latest']);
   const decimals=Number(BigInt(String(decimalResult.data)));
   if(!Number.isInteger(decimals)||decimals<0||decimals>255)throw new Error('Token returned invalid precision');
   let symbol='TOKEN';
   try { const result=String((await this.options.evm.readRpc(chainId,'eth_call',[{to,data:'0x95d89b41'},'latest'])).data);
    try { symbol=AbiCoder.defaultAbiCoder().decode(['string'],result)[0]; } catch { symbol=decodeBytes32String(result); }
   } catch { /* symbol is presentation only; decimals must be verified */ }
   return {assetId:caip,chainId,symbol:String(symbol).slice(0,32),decimals};
  }
  if (chainId.startsWith('solana:') && /^token:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(asset)) {
   const endpoint=this.options.nownodesApiKey?'https://sol.nownodes.io':'https://api.mainnet-beta.solana.com';
   const response=await (this.options.fetch||fetch)(endpoint,{method:'POST',headers:{'Content-Type':'application/json',...(this.options.nownodesApiKey?{'api-key':this.options.nownodesApiKey}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getAccountInfo',params:[asset.slice(6),{encoding:'jsonParsed',commitment:'confirmed'}]}),signal:AbortSignal.timeout(8000)});
   const body=await response.json() as any, info=body?.result?.value?.data?.parsed;
   if(!response.ok || body.error || info?.type!=='mint' || !Number.isInteger(info.info?.decimals) || info.info.decimals<0 || info.info.decimals>255)throw new Error('Unable to verify Solana mint precision');
   return {assetId:caip,chainId,symbol:'SPL',decimals:info.info.decimals};
  }
  throw new Error(`Unable to verify asset precision for ${caip}`);
 }
}
