import { afterEach, expect, test } from 'bun:test';
import { observeCache } from './cache';
import { HistoryClient } from './history';
import { UtxoClient } from './utxo';
import { ZerionClient } from './zerion';
import { PortfolioClient } from './portfolio';
import { createApp } from './http';
import { providerContext } from './provider-metrics';

const ADDRESS = '0x' + '1'.repeat(40);
const ETH_CAIP = 'eip155:1/slip44:60';
const realNow = Date.now;
afterEach(() => { Date.now = realNow; });
const database: any = { authenticate: async () => ({ id: 'fixture', username: 'fixture' }) };
const noCache: any = { getFresh: async () => null, getStale: async () => null, set: async () => {}, runExclusive: async (_key: string, task: () => unknown) => task() };
function read(path: string, body: any) {
    return new Request('https://fixture/api/v1/' + path + '?forceRefresh=true', {
        method: 'POST', headers: { Authorization: 'fixture', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
}

test('automatic native history retains a real observation and passes the Vault freshness contract', async () => {
    const utxo = new UtxoClient({ apiKey: 'fixture', cache: noCache,
        fetch: (async () => Response.json({ transactions: [] })) as unknown as typeof fetch });
    const app = createApp({ config: {} as any, database, history: new HistoryClient({ utxo }) });
    const response = await app.fetch(read('tx/history', { queries: [{ caip: 'bip122:00040fe8ec8471911baa1db1266ea15d/slip44:133', pubkey: 't1fixture' }],
        refreshReason: 'automatic', providerRefreshPolicy: 'cache-only' }));
    expect(response.status).toBe(200);
    const value: any = await response.json();
    expect(value.histories[0]).toMatchObject({ transactions: [], fresh: true, cached: false, loading: false });
    expect(value.histories[0].fetchedAt).toBeGreaterThan(0);
});

test('automatic EVM history distinguishes a fresh cached observation from a truly stale one', async () => {
    let now = 1000; Date.now = () => now;
    const transactions = observeCache([], { fetchedAt: 900, freshUntil: 1100, staleUntil: 2000, source: 'zerion' });
    const client = new HistoryClient({ zerion: { getTransactions: async () => transactions } });
    const query = () => providerContext.run({ source: 'http', cacheOnly: true }, () => client.getTransactionHistory({ queries: [{ caip: ETH_CAIP, pubkey: ADDRESS }] }));
    expect((await query() as any).histories[0]).toMatchObject({ fresh: true, cached: true, fetchedAt: 900 });
    now = 1200;
    expect((await query() as any).histories[0]).toMatchObject({ fresh: false, cached: true, fetchedAt: 900 });
});

test('opening balances initializes EVM history once and automatic history adds no paid calls', async () => {
    let paid = 0;
    const zerion = new ZerionClient({ apiKey: 'fixture', fetch: (async (url: any) => {
        paid++;
        return Response.json({ data: String(url).endsWith('/chains/') ? [{ id: 'ethereum', attributes: { external_id: '0x1' } }] : [] });
    }) as typeof fetch });
    const app = createApp({ config: {} as any, database, portfolio: new PortfolioClient({ zerion }), history: new HistoryClient({ zerion }) });
    const response = await app.fetch(read('portfolio/balances', { pubkeys: [{ caip: ETH_CAIP, pubkey: ADDRESS }], refreshReason: 'wallet-open', providerRefreshPolicy: 'on-demand' }));
    expect(response.status).toBe(200); expect(paid).toBe(3);
    for (let i = 0; i < 3; i++) {
        const history = await app.fetch(read('tx/history', { queries: [{ caip: ETH_CAIP, pubkey: ADDRESS }], refreshReason: 'automatic', providerRefreshPolicy: 'cache-only' }));
        expect(history.status).toBe(200);
        expect((await history.json() as any).histories[0]).toMatchObject({ transactions: [], fresh: true, cached: true });
    }
    expect(paid).toBe(3);
});

test('automatic history joins an authorized wallet-opening read instead of racing into a cache miss', async () => {
    let started!: () => void, release!: () => void, calls = 0;
    const loading = new Promise<void>(resolve => started = resolve);
    const gate = new Promise<void>(resolve => release = resolve);
    const zerion = new ZerionClient({ apiKey: 'fixture', fetch: (async (url: any) => {
        calls++;
        if (String(url).includes('/transactions/')) { started(); await gate; }
        return Response.json({ data: String(url).endsWith('/chains/') ? [{ id: 'ethereum', attributes: { external_id: '0x1' } }] : [] });
    }) as typeof fetch });
    const opening = providerContext.run({ source: 'http', cacheOnly: false }, () => zerion.getTransactions(ADDRESS));
    await loading;
    const automatic = providerContext.run({ source: 'http', cacheOnly: true }, () => zerion.getTransactions(ADDRESS, { forceRefresh: true }));
    release();
    expect(await Promise.all([opening, automatic])).toEqual([[], []]);
    expect(calls).toBe(2);
});

test('cache-only cold history cannot initiate a paid request or manufacture an empty successful snapshot', async () => {
    let calls = 0;
    const zerion = new ZerionClient({ apiKey: 'fixture', fetch: (async () => { calls++; throw Error('must not run'); }) as unknown as typeof fetch });
    await expect(providerContext.run({ source: 'http', cacheOnly: true }, () => zerion.getTransactions(ADDRESS, { forceRefresh: true }))).rejects.toMatchObject({ status: 409 });
    expect(calls).toBe(0);
});
