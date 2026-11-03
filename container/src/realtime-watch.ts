export interface WatchAddress { address: string; networkId: string }
/** Only EVM hex addresses are case-insensitive; base58 keys/signatures are not. */
export function watchKey(watch: WatchAddress): string {
 return `${watch.networkId}:${watch.networkId.startsWith("eip155:") ? watch.address.toLowerCase() : watch.address}`;
}
