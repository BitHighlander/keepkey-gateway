import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { createDatabase, type Database } from './database';
import { loadConfig } from './config';
import type { DurableEventInput, DurableRealtimeStore } from './realtime-store';

// Explicit dedicated test database only. Never load application .env/config.
const url = process.env.REALTIME_TEST_DATABASE_URL;
if (url && !new URL(url).pathname.endsWith('_test')) throw new Error('Use a dedicated realtime _test database');
const integration = url ? test : test.skip;
let database: Database, sql: SQL, store: DurableRealtimeStore, one: string, two: string;
const extraClients: string[] = [];
async function client(): Promise<string> {
 const id = (await database.registerClient({ username: 'durable-extra', queryKey: `test:${crypto.randomUUID()}` })).id;
 extraClients.push(id); return id;
}
const scope = () => `wallet-${crypto.randomUUID()}`;
const A = { address: '0x1111111111111111111111111111111111111111', networkId: 'eip155:1' };
const B = { address: '0x2222222222222222222222222222222222222222', networkId: 'eip155:1' };
function event(clientId: string, walletScope: string, id: string, confirmed = false): DurableEventInput {
 return { clientId, walletScope, eventId: id, eventName: confirmed ? 'tx:confirmed' : 'tx:incoming',
  payload: { watchAddress: A.address, address: A.address, networkId: A.networkId, txid: 'public-fixture', cursor: Date.now(), refreshHint: true } };
}
beforeAll(async () => {
 if (!url) return;
 database = createDatabase(loadConfig({ DATABASE_URL: url, DATABASE_MAX_CONNECTIONS: '2' }));
 await database.migrate(); store = database.realtime!; sql = new SQL(url, { max: 1 });
 one = (await database.registerClient({ username: 'durable-one', queryKey: `test:${crypto.randomUUID()}` })).id;
 two = (await database.registerClient({ username: 'durable-two', queryKey: `test:${crypto.randomUUID()}` })).id;
});
afterAll(async () => {
 if (sql) { for (const client of [one, two, ...extraClients].filter(Boolean)) await sql`DELETE FROM api_clients WHERE id = ${client}`; await sql.close(); }
 if (database) await database.close();
});

describe('PostgreSQL durable realtime delivery', () => {
 integration('registrations survive connection close and store recreation', async () => {
  const wallet = scope();
  const first = createDatabase(loadConfig({ DATABASE_URL: url!, DATABASE_MAX_CONNECTIONS: '1' }));
  await first.realtime!.replaceWatches(one, wallet, [A], { enabled: true, since: Date.now() - 1_000 });
  await first.close();
  const restarted = createDatabase(loadConfig({ DATABASE_URL: url!, DATABASE_MAX_CONNECTIONS: '1' }));
  try {
   const watches = await restarted.realtime!.listActiveWatches();
   expect(watches.find(watch => watch.clientId === one && watch.walletScope === wallet)).toMatchObject(A);
  } finally { await restarted.close(); }
 });

 integration('stable pending/confirmed phases deduplicate across replay and acknowledgement', async () => {
  const wallet = scope(); await store.replaceWatches(one, wallet, [A], { enabled: true });
  const pending = event(one, wallet, 'pending'), confirmed = event(one, wallet, 'confirmed', true);
  expect(await store.enqueueEvents([pending, pending, confirmed])).toHaveLength(2);
  expect(await store.enqueueEvents([pending, confirmed])).toHaveLength(0);
  const page = await store.replay(one, { walletScope: wallet, limit: 1 });
  expect(page.events).toHaveLength(1); expect(typeof page.events[0].id).toBe('string');
  await store.ack(one, { walletScope: wallet, eventIds: ['pending'] });
  expect((await store.replay(one, { walletScope: wallet })).events.map(row => row.eventId)).toEqual(['confirmed']);
  expect(await store.enqueueEvents([pending])).toHaveLength(0); // ack is not deletion of the dedupe record
  await store.ack(one, { walletScope: wallet, cursor: (await store.replay(one, { walletScope: wallet })).cursor });
  expect((await store.replay(one, { walletScope: wallet })).events).toHaveLength(0);
 });

 integration('replay and acknowledgements isolate both client and wallet', async () => {
  const wallet = scope(), otherWallet = scope();
  for (const [client, scope] of [[one, wallet], [one, otherWallet], [two, wallet]]) await store.replaceWatches(client, scope, [A], { enabled: true });
  await store.enqueueEvents([event(one, wallet, 'same-id'), event(one, otherWallet, 'same-id'), event(two, wallet, 'same-id')]);
  await store.ack(one, { walletScope: wallet, eventIds: ['same-id'] });
  expect((await store.replay(one, { walletScope: wallet })).events).toHaveLength(0);
  expect((await store.replay(one, { walletScope: otherWallet })).events).toHaveLength(1);
  expect((await store.replay(two, { walletScope: wallet })).events).toHaveLength(1);
  await expect(store.replay(one, {} as any)).rejects.toThrow('wallet scope');
  await expect(store.ack(one, { cursor: '999999' } as any)).rejects.toThrow('wallet scope');
 });

 integration('replacement and explicit removal suppress late work and stale re-registration', async () => {
  const wallet = scope(), revision = Date.now();
  await store.replaceWatches(one, wallet, [A], { enabled: true, revision });
  await store.replaceWatches(one, wallet, [B], { enabled: true, revision: revision + 1 });
  expect(await store.enqueueEvents([event(one, wallet, 'old-watch')])).toHaveLength(0);
  const current = event(one, wallet, 'current'); current.payload = { ...current.payload, ...B, watchAddress: B.address };
  expect(await store.enqueueEvents([current])).toHaveLength(1);
  await store.removeWallet(one, wallet, { revision: revision + 2 });
  expect((await store.replay(one, { walletScope: wallet })).events).toHaveLength(0);
  expect(await store.enqueueEvents([current])).toHaveLength(0);
  await store.replaceWatches(one, wallet, [A], { enabled: true, revision: revision + 1 });
  expect((await store.listActiveWatches()).some(watch => watch.clientId === one && watch.walletScope === wallet)).toBe(false);
 });

 integration('expired events are invisible and pruned; watch history starts within the retained horizon', async () => {
  const wallet = scope(); await store.replaceWatches(one, wallet, [A], { enabled: true, since: 0 });
  const watch = (await store.listActiveWatches()).find(watch => watch.clientId === one && watch.walletScope === wallet)!;
  expect(watch.since).toBeGreaterThan(Date.now() - 7 * 24 * 60 * 60_000 - 2_000);
  await store.enqueueEvents([event(one, wallet, 'expired')]);
  await sql`UPDATE realtime_events SET expires_at = now() - interval '1 second' WHERE client_id = ${one} AND wallet_scope = ${wallet}`;
  expect((await store.replay(one, { walletScope: wallet })).events).toHaveLength(0);
  expect(await store.prune()).toBeGreaterThanOrEqual(1);
 });

 integration('batch validation failures roll back previously inserted events', async () => {
  const wallet = scope(); await store.replaceWatches(one, wallet, [A], { enabled: true });
  await expect(store.enqueueEvents([event(one, wallet, 'valid-first'), { ...event(one, wallet, 'bad-second'), eventName: 'unknown' as any }])).rejects.toThrow('event name');
  expect((await store.replay(one, { walletScope: wallet })).events).toHaveLength(0);
 });

 integration('EVM case deduplicates while base58 watches remain distinct', async () => {
  const wallet = scope(), networkId = 'solana:mainnet';
  await store.replaceWatches(one, wallet, [A, { ...A, address: A.address.toUpperCase() },
   { networkId, address: 'Base58Case' }, { networkId, address: 'base58case' }], { enabled: true });
  expect((await store.listActiveWatches()).filter(watch => watch.clientId === one && watch.walletScope === wallet)).toHaveLength(3);
 });

 integration('per-client quotas serialize concurrent scope additions and allow explicit removal', async () => {
  const id = await client();
  for (let i = 0; i < 7; i++) await store.replaceWatches(id, `quota-${i}`, [A], { enabled: true });
  const attempts = await Promise.allSettled(['quota-7', 'quota-8'].map(wallet => store.replaceWatches(id, wallet, [A], { enabled: true })));
  expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);
  await store.removeWallet(id, 'quota-0');
  await store.replaceWatches(id, 'quota-after-removal', [A], { enabled: true });
  expect((await store.listActiveWatches()).filter(watch => watch.clientId === id)).toHaveLength(8);
 });

 integration('total active watch quota is enforced across wallet scopes', async () => {
  const id = await client();
  for (let i = 0; i < 5; i++) await store.replaceWatches(id, `watch-quota-${i}`,
   Array.from({ length: 200 }, (_, j) => ({ ...A, address: `0x${(i * 200 + j).toString(16).padStart(40, '0')}` })), { enabled: true });
  await expect(store.replaceWatches(id, 'watch-over-quota', [A], { enabled: true })).rejects.toThrow('quota');
  await store.removeWallet(id, 'watch-quota-0');
  await store.replaceWatches(id, 'watch-over-quota', [A], { enabled: true });
 });

 integration('disabled and missing clients cannot register, replay or acknowledge', async () => {
  const id = await client(), wallet = scope();
  await store.replaceWatches(id, wallet, [A], { enabled: true });
  await store.enqueueEvents([event(id, wallet, 'before-disable')]);
  await sql`UPDATE api_clients SET disabled_at = now() WHERE id = ${id}`;
  for (const disabled of [id, crypto.randomUUID()]) {
   await expect(store.replay(disabled, { walletScope: wallet })).rejects.toThrow('unavailable');
   await expect(store.ack(disabled, { walletScope: wallet, eventIds: ['before-disable'] })).rejects.toThrow('unavailable');
   await expect(store.replaceWatches(disabled, wallet, [A], { enabled: true })).rejects.toThrow('unavailable');
  }
  expect(await store.enqueueEvents([event(id, wallet, 'after-disable')])).toHaveLength(0);
  expect((await store.listActiveWatches()).some(watch => watch.clientId === id)).toBe(false);
 });

 integration('opaque event cursors retain bigint precision beyond JavaScript safe integers', async () => {
  const id = await client(), wallet = scope();
  await store.replaceWatches(id, wallet, [A], { enabled: true });
  await sql`SELECT setval(pg_get_serial_sequence('realtime_events', 'id'), 9007199254740992::bigint, true)`;
  const events = await store.enqueueEvents([event(id, wallet, 'wide-cursor')]);
  expect(events[0].id).toBe('9007199254740993');
  const page = await store.replay(id, { walletScope: wallet, after: '9007199254740992' });
  expect(page.cursor).toBe('9007199254740993');
  await store.ack(id, { walletScope: wallet, cursor: page.cursor });
  expect((await store.replay(id, { walletScope: wallet })).events).toHaveLength(0);
 });
});
