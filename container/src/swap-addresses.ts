import { base58, base58xrp, bech32, bech32m } from '@scure/base';
import { getBytes, isAddress, sha256 } from 'ethers';

const UTXO: Record<string,{versions:number[][];hrp?:string;cash?:boolean}> = {
 '000000000019d6689c085ae165831e93':{versions:[[0],[5]],hrp:'bc'},
 '12a765e31ffd4059bada1e25190f6e98':{versions:[[48],[50],[5]],hrp:'ltc'},
 '00000000001a91e3dace36e2be3bf030':{versions:[[30],[22]]},
 '000000000000000000651ef99cb9fcbe':{versions:[[0],[5]],cash:true},
 '000007d91d1254d60e2dd1ae58038307':{versions:[[76],[16]]},
 '00040fe8ec8471911baa1db1266ea15d':{versions:[[28,184],[28,189]]},
 '4da631f2ac1bed857bd968c67c913978':{versions:[[30],[63]],hrp:'dgb'},
};
function checkedBase58(address:string,versions:number[][],ripple=false): boolean {
 try {const bytes=(ripple?base58xrp:base58).decode(address),payload=bytes.slice(0,-4),check=getBytes(sha256(getBytes(sha256(payload)))).slice(0,4);
  return bytes.slice(-4).every((b,i)=>b===check[i]) && versions.some(v=>payload.length===v.length+20 && v.every((b,i)=>payload[i]===b));
 } catch {return false;}
}
function witness(address:string,hrp:string):boolean {
 for(const coder of [bech32,bech32m])try{const d=coder.decode(address as `${string}1${string}`),version=d.words[0],program=coder.fromWords(d.words.slice(1));
  if(d.prefix!==hrp||version>16||program.length<2||program.length>40)continue;
  if(version===0 && coder===bech32 && [20,32].includes(program.length))return true;
  if(version>0 && coder===bech32m)return true;
 }catch{/* other encoding */}
 return false;
}
function cash(address:string):boolean {
 const text=address.toLowerCase(); if(address!==text && address!==address.toUpperCase())return false;
 const alphabet='qpzry9x8gf2tvdw0s3jn54khce6mua7l',words=[...text].map(c=>alphabet.indexOf(c));
 if(words.some(w=>w<0)||words.length<42)return false;
 const values=[...[...'bitcoincash'].map(c=>c.charCodeAt(0)&31),0,...words];
 const generators=[0x98f2bc8e61n,0x79b76d99e2n,0xf33e5fb3c4n,0xae2eabe2a8n,0x1e4f43e470n];let c=1n;
 for(const v of values){const top=c>>35n;c=((c&0x07ffffffffn)<<5n)^BigInt(v);for(let i=0;i<5;i++)if((top>>BigInt(i))&1n)c^=generators[i];}
 return c===1n;
}
/** null means accepted; unknown chain families are left to their adapter. */
export function validateSwapAddress(caip:string,address:string):string|null {
 const network=caip.split('/')[0];
 if(!address || address!==address.trim() || /[:/&#?\s]/.test(address))return 'Address is empty or contains a forbidden delimiter';
 if(network.startsWith('eip155:'))return isAddress(address)?null:'Expected a checksummed or single-case EVM address';
 if(network.startsWith('solana:')){try{return base58.decode(address).length===32?null:'Expected a 32-byte Solana address';}catch{return 'Invalid Solana address';}}
 if(network.startsWith('bip122:')){const config=UTXO[network.slice(7)];if(!config)return null;
  return checkedBase58(address,config.versions)||(config.hrp&&witness(address,config.hrp))||(config.cash&&cash(address))?null:'Address does not match the source/destination network';}
 if(network.startsWith('cosmos:')){const prefix:Record<string,string>={'cosmoshub-4':'cosmos','thorchain-mainnet-v1':'thor','mayachain-mainnet-v1':'maya','osmosis-1':'osmo','kaiyo-1':'kujira'};
  try{const d=bech32.decode(address as `${string}1${string}`);return (!prefix[network.slice(7)]||d.prefix===prefix[network.slice(7)]) && [20,32].includes(bech32.fromWords(d.words).length)?null:'Unexpected Cosmos address prefix or length';}catch{return 'Invalid Cosmos address';}}
 if(network.startsWith('tron:'))return checkedBase58(address,[[65]])?null:'Invalid Tron address';
 if(network.startsWith('ripple:'))return checkedBase58(address,[[0]],true)?null:'Invalid XRP address';
 return null;
}
