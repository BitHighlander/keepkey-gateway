import { createHash } from 'node:crypto';
import type { SQL } from 'bun';
import { watchKey, type WatchAddress } from './realtime-watch';

const RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_CLIENT_SCOPES = 8, MAX_CLIENT_WATCHES = 1000;
export interface DurableWatch extends WatchAddress { clientId: string; walletScope: string; since: number }
export interface DurableEventInput {
 clientId: string; walletScope: string; eventId: string; eventName: 'tx:incoming' | 'tx:confirmed'; payload: Record<string, unknown>;
}
export interface DurableEvent extends DurableEventInput { id: string; createdAt: number }
export interface DurableRealtimeStore {
 replaceWatches(clientId: string, walletScope: string, watches: WatchAddress[], options: { enabled: boolean; since?: number; revision?: number }): Promise<void>;
 removeWallet(clientId: string, walletScope: string, options?: { revision?: number }): Promise<void>;
 listActiveWatches(): Promise<DurableWatch[]>;
 enqueueEvents(events: DurableEventInput[]): Promise<DurableEvent[]>;
 replay(clientId: string, options: { walletScope: string; after?: string | number; limit?: number }): Promise<{ events: DurableEvent[]; cursor: string }>;
 ack(clientId: string, options: { walletScope: string; eventIds?: string[]; cursor?: string | number }): Promise<void>;
 prune(): Promise<number>;
}
export class RealtimeStoreError extends Error { constructor(message: string, public readonly status = 400) { super(message); } }
function scope(value: string): string {
 if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(value)) throw new RealtimeStoreError('Invalid wallet scope');
 return value;
}
function cursor(value: string | number | undefined): string {
 if (value === undefined) return '0';
 if ((typeof value === 'number' && !Number.isSafeInteger(value)) || !/^(?:0|[1-9][0-9]{0,18})$/.test(String(value)) || BigInt(value) > 9223372036854775807n) throw new RealtimeStoreError('Invalid queue cursor');
 return String(value);
}
function eventId(value: string): void {
 if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(value)) throw new RealtimeStoreError('Invalid event identifier');
}
function normalized(watch: WatchAddress): WatchAddress {
 if (!watch || typeof watch.address !== 'string' || typeof watch.networkId !== 'string') throw new RealtimeStoreError('Invalid durable watch');
 const address = watch.address.trim(), networkId = watch.networkId.trim();
 if (!address || address.length > 512 || /\s/.test(address) || !/^[a-zA-Z0-9:._-]{1,128}$/.test(networkId)) throw new RealtimeStoreError('Invalid durable watch');
 return { networkId, address: networkId.startsWith('eip155:') ? address.toLowerCase() : address };
}
function watchId(watch: WatchAddress): string { return createHash('sha256').update(watchKey(watch)).digest('hex'); }
function stored(row: any): DurableEvent {
 const payload = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json;
 return { id: String(row.id), clientId: String(row.client_id), walletScope: String(row.wallet_scope), eventId: String(row.event_id),
  eventName: row.event_name, payload, createdAt: new Date(row.created_at).getTime() };
}

/** PostgreSQL owns registrations, delivery deduplication and acknowledged replay.
 * Connection close has no store operation; removal requires an explicit scope. */
export function createRealtimeStore(sql: SQL): DurableRealtimeStore {
 const activeClient = async (query: SQL, clientId: string) => {
  const rows = await query`SELECT id FROM api_clients WHERE id = ${clientId} AND disabled_at IS NULL`;
  if (!rows.length) throw new RealtimeStoreError('Client is unavailable', 403);
 };
 // Registration, enqueue and acknowledgement use the same lock order. Acquire
 // every client before every scope so reversed multi-wallet batches cannot deadlock.
 const lockScopes = async (query: SQL, pairs: Array<{ clientId: string; walletScope: string }>) => {
  for (const clientId of [...new Set(pairs.map(pair => pair.clientId))].sort())
   await query`SELECT pg_advisory_xact_lock(hashtextextended(${`realtime-client:${clientId}`}, 0))`;
  for (const key of [...new Set(pairs.map(pair => `realtime:${pair.clientId}:${pair.walletScope}`))].sort())
   await query`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
 };
 const store: DurableRealtimeStore = {
  async replaceWatches(clientId, walletScope, raw, options) {
   scope(walletScope);
   if (!options || typeof options.enabled !== 'boolean' || !Array.isArray(raw) || raw.length > 200) throw new RealtimeStoreError('Invalid durable watch registration');
   const watches = [...new Map(raw.map(item => { const watch = normalized(item); return [watchId(watch), watch] as const; })).entries()];
   const now = Date.now();
   if (options.since !== undefined && (!Number.isSafeInteger(options.since) || options.since < 0 || options.since > now + 60_000)) throw new RealtimeStoreError('Invalid durable watch cursor');
   if (options.revision !== undefined && (!Number.isSafeInteger(options.revision) || options.revision < 0 || options.revision > now + 60_000)) throw new RealtimeStoreError('Invalid registration revision');
   const since = new Date(Math.max(Math.min(options.since ?? now, now), now - RETENTION_MS));
   await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`realtime-client:${clientId}`}, 0))`;
    await activeClient(tx, clientId);
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`realtime:${clientId}:${walletScope}`}, 0))`;
    const previous = await tx`SELECT revision, enabled FROM realtime_wallets WHERE client_id = ${clientId} AND wallet_scope = ${walletScope} FOR UPDATE`;
    const revision = options.revision ?? Math.max(now, Number(previous[0]?.revision || 0) + 1);
    if (previous.length && BigInt(revision) <= BigInt(previous[0].revision)) {
     const current = await tx`SELECT watch_id FROM realtime_watches WHERE client_id = ${clientId} AND wallet_scope = ${walletScope} ORDER BY watch_id`;
     const desired = options.enabled ? watches.map(([id]) => id).sort() : [];
     if (previous[0].enabled === options.enabled && current.length === desired.length && current.every((row: any, i: number) => row.watch_id === desired[i])) return;
     throw new RealtimeStoreError('Registration revision conflicts with current watch state', 409);
    }
    if (options.enabled) {
     const scopes = await tx`SELECT count(*)::integer AS count FROM realtime_wallets WHERE client_id = ${clientId} AND wallet_scope <> ${walletScope} AND enabled = true`;
     const count = await tx`SELECT count(*)::integer AS count FROM realtime_watches w JOIN realtime_wallets r USING (client_id, wallet_scope)
      WHERE w.client_id = ${clientId} AND w.wallet_scope <> ${walletScope} AND r.enabled = true`;
     if (Number(scopes[0].count) >= MAX_CLIENT_SCOPES || Number(count[0].count) + watches.length > MAX_CLIENT_WATCHES) throw new RealtimeStoreError('Durable watch quota exceeded', 429);
    }
    await tx`INSERT INTO realtime_wallets (client_id, wallet_scope, revision, enabled) VALUES (${clientId}, ${walletScope}, ${revision}, ${options.enabled})
     ON CONFLICT (client_id, wallet_scope) DO UPDATE SET revision = EXCLUDED.revision, enabled = EXCLUDED.enabled, updated_at = now()`;
    if (!options.enabled || !watches.length) {
     await tx`DELETE FROM realtime_ack_receipts WHERE client_id = ${clientId} AND wallet_scope = ${walletScope}`;
     await tx`DELETE FROM realtime_watches WHERE client_id = ${clientId} AND wallet_scope = ${walletScope}`;
     return;
    }
    const keys = watches.map(([id]) => id);
    const keep = { items: keys };
    await tx`DELETE FROM realtime_watches WHERE client_id = ${clientId} AND wallet_scope = ${walletScope}
     AND watch_id NOT IN (SELECT jsonb_array_elements_text((${keep}::jsonb)->'items'))`;
    for (const [id, watch] of watches) await tx`INSERT INTO realtime_watches (client_id, wallet_scope, watch_id, network_id, address, since_at)
     VALUES (${clientId}, ${walletScope}, ${id}, ${watch.networkId}, ${watch.address}, ${since})
     ON CONFLICT (client_id, wallet_scope, watch_id) DO NOTHING`;
   });
  },
  async removeWallet(clientId, walletScope, options = {}) {
   await store.replaceWatches(clientId, walletScope, [], { enabled: false, ...options });
  },
  async listActiveWatches() {
   const rows = await sql`SELECT w.client_id, w.wallet_scope, w.network_id, w.address, GREATEST(w.since_at, now() - interval '7 days') AS since_at
    FROM realtime_watches w JOIN realtime_wallets r USING (client_id, wallet_scope) JOIN api_clients c ON c.id = w.client_id
    WHERE r.enabled = true AND c.disabled_at IS NULL ORDER BY w.client_id, w.wallet_scope, w.watch_id`;
   return rows.map((row: any) => ({ clientId: String(row.client_id), walletScope: String(row.wallet_scope), address: String(row.address),
    networkId: String(row.network_id), since: new Date(row.since_at).getTime() }));
  },
  async enqueueEvents(events) {
   if (!Array.isArray(events) || events.length > 500) throw new RealtimeStoreError('Too many queued events');
   const inserted: DurableEvent[] = [];
   await sql.begin(async tx => {
    await lockScopes(tx, events);
    for (const event of events) {
     scope(event.walletScope); eventId(event.eventId);
     if (!['tx:incoming', 'tx:confirmed'].includes(event.eventName)) throw new RealtimeStoreError('Invalid queued event name');
     const p = event.payload, watch = normalized({ address: String(p?.watchAddress || p?.address || ''), networkId: String(p?.networkId || '') });
     const payload = { ...p, eventId: event.eventId, refreshHint: true };
     if (JSON.stringify(payload).length > 16_384) throw new RealtimeStoreError('Queued event exceeds size limit');
     const rows = await tx`INSERT INTO realtime_events (client_id, wallet_scope, watch_id, event_id, event_name, payload_json, acked_at)
      SELECT w.client_id, w.wallet_scope, w.watch_id, ${event.eventId}, ${event.eventName}, ${payload}, a.acked_at
      FROM realtime_watches w JOIN realtime_wallets r USING (client_id, wallet_scope) JOIN api_clients c ON c.id = w.client_id
      LEFT JOIN realtime_ack_receipts a ON a.client_id = w.client_id AND a.wallet_scope = w.wallet_scope
       AND a.event_id = ${event.eventId} AND a.expires_at > now()
      WHERE w.client_id = ${event.clientId} AND w.wallet_scope = ${event.walletScope} AND w.watch_id = ${watchId(watch)} AND r.enabled = true AND c.disabled_at IS NULL
      ON CONFLICT (client_id, wallet_scope, event_id) DO NOTHING
      RETURNING id::text AS id, client_id, wallet_scope, event_id, event_name, payload_json, created_at, acked_at`;
     if (rows.length && rows[0].acked_at === null) inserted.push(stored(rows[0]));
    }
    await tx`DELETE FROM realtime_events WHERE expires_at <= now()`;
   });
   return inserted;
  },
  async replay(clientId, options) {
   scope(options.walletScope);
   await activeClient(sql, clientId);
   const after = cursor(options.after), limit = options.limit ?? 100;
   if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new RealtimeStoreError('Invalid replay limit');
   const rows = await sql`SELECT e.id::text AS id, e.client_id, e.wallet_scope, e.event_id, e.event_name, e.payload_json, e.created_at
    FROM realtime_events e JOIN realtime_wallets r USING (client_id, wallet_scope) JOIN api_clients c ON c.id = e.client_id
    WHERE e.client_id = ${clientId} AND e.wallet_scope = ${options.walletScope} AND r.enabled = true AND c.disabled_at IS NULL
     AND e.id > ${after}::bigint AND e.acked_at IS NULL AND e.expires_at > now()
     AND NOT EXISTS (SELECT 1 FROM realtime_ack_receipts a WHERE a.client_id = e.client_id AND a.wallet_scope = e.wallet_scope
      AND a.event_id = e.event_id AND a.expires_at > now())
    ORDER BY e.id LIMIT ${limit}`;
   const events = rows.map(stored);
   return { events, cursor: events.at(-1)?.id || after };
  },
  async ack(clientId, options) {
   scope(options.walletScope);
   const ids = options.eventIds || [];
   if (!Array.isArray(ids) || ids.length > 500 || (!ids.length && options.cursor === undefined)) throw new RealtimeStoreError('An acknowledgement requires event identifiers or a cursor');
   ids.forEach(eventId); const through = cursor(options.cursor), acknowledged = { items: ids };
   await sql.begin(async tx => {
    await lockScopes(tx, [{ clientId, walletScope: options.walletScope }]);
    await activeClient(tx, clientId);
    await tx`DELETE FROM realtime_ack_receipts WHERE client_id = ${clientId} AND wallet_scope = ${options.walletScope} AND expires_at <= now()`;
    // Live streams can be reconciled before the monitor inserts their event.
    // Retain only explicit IDs, only for a currently enabled registered scope.
    // A late ACK after disable/removal must not restore persisted wallet data.
    if (ids.length) await tx`INSERT INTO realtime_ack_receipts (client_id, wallet_scope, event_id)
     SELECT r.client_id, r.wallet_scope, jsonb_array_elements_text((${acknowledged}::jsonb)->'items')
     FROM realtime_wallets r JOIN api_clients c ON c.id = r.client_id
     WHERE r.client_id = ${clientId} AND r.wallet_scope = ${options.walletScope} AND r.enabled = true AND c.disabled_at IS NULL
      AND EXISTS (SELECT 1 FROM realtime_watches w WHERE w.client_id = r.client_id AND w.wallet_scope = r.wallet_scope)
     ON CONFLICT (client_id, wallet_scope, event_id) DO NOTHING`;
    // Queue cursors refer to rows already allocated, never to future IDs.
    await tx`UPDATE realtime_events SET acked_at = COALESCE(acked_at, now()) WHERE client_id = ${clientId} AND wallet_scope = ${options.walletScope}
     AND (event_id IN (SELECT jsonb_array_elements_text((${acknowledged}::jsonb)->'items')) OR (${options.cursor !== undefined} AND id <= ${through}::bigint))`;
   });
  },
  async prune() {
   const rows = await sql`DELETE FROM realtime_events WHERE expires_at <= now() RETURNING id`;
   const receipts = await sql`DELETE FROM realtime_ack_receipts WHERE expires_at <= now() RETURNING event_id`;
   return rows.length + receipts.length;
  },
 };
 return store;
}
