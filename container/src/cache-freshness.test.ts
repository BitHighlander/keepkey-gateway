import { afterEach, expect, test } from 'bun:test';
import { DemandCache } from './demand-cache';
import { cacheObservation, observeCache, type PersistentCache, type StoredCacheEntry } from './cache';
import { PortfolioClient } from './portfolio';
import { ZerionClient } from './zerion';
import { createApp } from './http';
import { providerContext } from './provider-metrics';
const realNow = Date.now;
afterEach(() => { Date.now = realNow; });
class SharedCache implements PersistentCache {
 entries = new Map<string, StoredCacheEntry<any>>();
 locks = new Map<string, Promise<void>>();
 async getEntry<T>(n: string, k: string, mode: 'fresh' | 'stale') {
  const row = this.entries.get(`${n}:${k}`);
  return row && (mode === 'fresh' ? row.freshUntil : row.staleUntil) > Date.now() ? row as StoredCacheEntry<T> : null;
 }
 async getFresh<T>(n: string, k: string) { return (await this.getEntry<T>(n, k, 'fresh'))?.value ?? null; }
 async getStale<T>(n: string, k: string) { return (await this.getEntry<T>(n, k, 'stale'))?.value ?? null; }
 async set(n: string, k: string, value: unknown, fresh: number, stale: number, source: string) {
  const key = `${n}:${k}`, version = String(Number(this.entries.get(key)?.version ?? 0) + 1);
  this.entries.set(key, { value, fetchedAt: Date.now(), freshUntil: Date.now() + fresh, staleUntil: Date.now() + stale, source, version });
 }
 async runExclusive<T>(key: string, task: () => Promise<T>) {
  const previous = this.locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  this.locks.set(key, new Promise<void>(r => release = r));
  await previous;
  try { return await task(); } finally { release(); }
 }
}
const policy = { namespace: 'balance', key: 'fixture', freshForMs: 100, staleForMs: 500, source: 'chain' };

test('L1 preserves the original persistent deadline and observation timestamp', async () => {
 let now = 1000; Date.now = () => now;
 const persistent = new SharedCache(); await persistent.set('balance', 'fixture', { balance: '10' }, 100, 500, 'chain');
 const cache = new DemandCache(persistent); let loads = 0;
 const load = async () => { loads++; return { balance: '0' }; };
 now = 1090; const persisted = await cache.get(policy, load);
 expect(cacheObservation(persisted)?.fetchedAt).toBe(1000);
 expect(cacheObservation(persisted)?.freshUntil).toBe(1100);
 now = 1101; expect((await cache.get(policy, load)).balance).toBe('0'); expect(loads).toBe(1);
});

test('same-millisecond explicit refresh bypasses a preexisting fresh snapshot', async () => {
 Date.now = () => 1000; const persistent = new SharedCache();
 await persistent.set('balance', 'fixture', { balance: '0' }, 100, 500, 'chain');
 expect((await new DemandCache(persistent).get(policy, async () => ({ balance: '10' }), { forceRefresh: true })).balance).toBe('10');
});

test('two instances join one forced upstream observation under a shared lock', async () => {
 Date.now = () => 1000; const persistent = new SharedCache();
 await persistent.set('balance', 'fixture', { balance: 'old' }, 100, 500, 'chain');
 let loads = 0;
 const load = async () => { loads++; await Promise.resolve(); return { balance: 'new' }; };
 const results = await Promise.all([new DemandCache(persistent).get(policy, load, { forceRefresh: true }), new DemandCache(persistent).get(policy, load, { forceRefresh: true })]);
 expect(results.map(row => row.balance)).toEqual(['new', 'new']); expect(loads).toBe(1);
});

test('stale fallback retains its age and is never promoted after upstream failure', async () => {
 let now = 1000; Date.now = () => now; const persistent = new SharedCache();
 await persistent.set('balance', 'fixture', { balance: '10' }, 100, 500, 'chain'); now = 1200;
 const cache = new DemandCache(persistent), fail = async () => { throw Error('offline'); };
 const stale = await cache.get(policy, fail);
 expect(cacheObservation(stale)).toMatchObject({ fetchedAt: 1000, freshUntil: 1100 });
 await expect(cache.get(policy, fail, { forceRefresh: true })).rejects.toThrow('offline');
 now = 1501; await expect(cache.get(policy, fail)).rejects.toThrow('offline');
});

test('portfolio keeps stale native and token observations distinct from response time', async () => {
 Date.now = () => 2000;
 const observation = { fetchedAt: 1000, freshUntil: 1500, staleUntil: 3000, source: 'chain' };
 const rows = observeCache([{ caip: 'cosmos:cosmoshub-4/slip44:118', pubkey: 'cosmos1fixture', address: 'cosmos1fixture', balance: '10', networkId: 'cosmos:cosmoshub-4', symbol: 'ATOM', name: 'Cosmos', decimals: 6, type: 'native', isNative: true, dataSource: 'cosmos-rest' }], observation);
 const client = new PortfolioClient({ multichain: { getBalances: async () => rows as any } });
 const result = await client.getBalances({ pubkeys: [{ caip: rows[0].caip, pubkey: rows[0].pubkey }] });
 expect(result.balances[0]).toMatchObject({ fetchedAt: 1000, fetchedAtISO: new Date(1000).toISOString(), isStale: true, verified: false, degraded: true });
 expect(result.meta.staleChains).toEqual([{ caip: rows[0].caip, pubkey: rows[0].pubkey, ageMs: 1000, fetchedAtISO: new Date(1000).toISOString() }]); expect(result.meta.degraded).toBe(true);
 expect(result.snapshot.at).toBe(new Date(2000).toISOString());
});

test('Zerion forced wallet discovery coalesces across instances and reserves only one request', async () => {
 Date.now = () => 1000; const cache = new SharedCache();
 await cache.set('zerion_metadata', 'chains', { ethereum: 'eip155:1' }, 10000, 10000, 'zerion');
 await cache.set('zerion_wallet_positions', '0x' + '1'.repeat(40), [], 100, 500, 'zerion');
 let calls = 0, reservations = 0;
 const options = { apiKey: 'fixture', cache, beforeRequest: async () => { reservations++; }, fetch: (async () => { calls++; return Response.json({ data: [] }); }) as unknown as typeof fetch };
 const [first, second] = [new ZerionClient(options), new ZerionClient(options)];
 await Promise.all([first.getWalletPositions('0x' + '1'.repeat(40), { forceRefresh: true }), second.getWalletPositions('0x' + '1'.repeat(40), { forceRefresh: true })]);
 expect(calls).toBe(1); expect(reservations).toBe(1);
});

test('automatic Zerion memory reuse stops at the original stale deadline', async () => {
 let now = 1000; Date.now = () => now;
 let calls = 0;
 const client = new ZerionClient({ apiKey: 'fixture', fetch: (async (input: any) => { calls++; return Response.json({ data: String(input).endsWith('/chains/') ? [{id:'ethereum',attributes:{external_id:'0x1'}}] : [] }); }) as unknown as typeof fetch });
 const address = '0x' + '1'.repeat(40); await client.getWalletPositions(address);
 const warmed = calls; now += 5 * 60000 + 1;
 await expect(providerContext.run({ source: 'http', cacheOnly: true }, () => client.getWalletPositions(address))).rejects.toThrow('No cached provider snapshot');
 expect(calls).toBe(warmed);
});


test('the legacy SDK portfolio path stays in the gateway and enforces automatic cache-only intent', async () => {
 let paid = 0, direct = 0;
 const zerion = new ZerionClient({ apiKey: 'fixture', fetch: (async () => { paid++; throw Error('Paid provider must not be called'); }) as unknown as typeof fetch });
 const app = createApp({ config: {} as any, database: { authenticate: async () => ({id:'fixture',username:'fixture'}) } as any,
  portfolio: new PortfolioClient({ zerion, evm: { getBalance: async () => { direct++; return {balance:'1'}; }, getTokenBalance: async () => ({balance:'0'}) } }) });
 for (const path of ['/api/v1/portfolio','/api/v1/portfolio/balances']) {
  const response = await app.fetch(new Request('https://api.keepkey.info'+path+'?forceRefresh=true', {method:'POST',headers:{Authorization:'fixture','Content-Type':'application/json'},body:JSON.stringify({pubkeys:[{caip:'eip155:1/slip44:60',pubkey:'0x'+'1'.repeat(40)}],refreshReason:'automatic',providerRefreshPolicy:'cache-only'})}));
  expect(response.status).toBe(200); expect((await response.json() as any).balances[0].balance).toBe('1');
 }
 expect(paid).toBe(0); expect(direct).toBe(2);
});


test('independent chain families load concurrently without waiting for a slow provider', async () => {
 let started = 0, release!: () => void;
 const gate = new Promise<void>(resolve => release=resolve);
 const enter = async () => { if (++started===3) release(); await gate; };
 const client = new PortfolioClient({
  hive: { account: async () => { await enter(); return {success:true,account:{name:'fixture',hive:'1',hbd:'0'}}; } },
  utxo: { getPubkeyInfo: async () => { await enter(); return {balance:'100000000',unconfirmedBalance:'0',tokens:[]}; } },
  multichain: { getBalances: async (caip,pubkey) => { await enter(); return [{caip,pubkey,networkId:'cosmos:cosmoshub-4',balance:'1',symbol:'ATOM',name:'Cosmos',decimals:6,type:'native' as const,isNative:true as const,address:pubkey,dataSource:'fixture'}]; } },
 });
 const result=await client.getBalances({pubkeys:[
  {caip:'hive:beeab0de/slip44:1275',pubkey:'STM'+'1'.repeat(50)},
  {caip:'bip122:000000000019d6689c085ae165831e93/slip44:0',pubkey:'xpub-fixture'},
  {caip:'cosmos:cosmoshub-4/slip44:118',pubkey:'cosmos1fixture'},
 ]});
 expect(started).toBe(3); expect(result.balances).toHaveLength(3); expect(result.meta.degraded).toBe(false);
},1000);
