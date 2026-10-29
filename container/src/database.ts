import { SQL } from "bun";
import { AsyncLocalStorage } from "node:async_hooks";
import type { PersistentCache } from "./cache";
import type { AppConfig } from "./config";
import { migrations } from "./migrations";

export interface RegisterClientInput {
	username: string;
	queryKey: string;
}

export interface RegisteredClient {
	id: string;
	username: string;
	createdAt: string;
	lastSeenAt: string;
}

export class DisabledClientError extends Error {}

export interface StoredPendingSwap {
	payload: Record<string, unknown>;
	status: string;
	createdAt: string;
	updatedAt: string;
	lastCheckedAt?: string;
}

export interface Database extends PersistentCache {
	migrate(): Promise<void>;
	ping(): Promise<void>;
	registerClient(input: RegisterClientInput): Promise<RegisteredClient>;
	authenticate(queryKey: string): Promise<{ id: string; username: string } | null>;
	upsertPendingSwap(clientId: string, txHash: string, payload: Record<string, unknown>): Promise<StoredPendingSwap>;
	getPendingSwap(clientId: string, txHash: string): Promise<StoredPendingSwap | null>;
	updatePendingSwap(clientId: string, txHash: string, status: string, patch: Record<string, unknown>): Promise<StoredPendingSwap | null>;
	recordVaultTelemetry(clientId: string, records: Record<string, unknown>[]): Promise<number>;
	reserveHiveClaim(clientId: string, ethAddress: string, username: string): Promise<boolean>;
	completeHiveClaim(ethAddress: string, txid: string): Promise<void>;
	releaseHiveClaim(ethAddress: string): Promise<void>;
	close(): Promise<void>;
}

async function hashQueryKey(queryKey: string): Promise<string> {
	const bytes = new TextEncoder().encode(queryKey);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createDatabase(config: AppConfig): Database {
	const sql = new SQL(config.databaseUrl, {
		max: config.databaseMaxConnections,
		// DemandCache uses PostgreSQL advisory locks to coalesce cold loads across
		// container instances. The reserved connection is intentionally idle while
		// the upstream provider is in flight; keep it alive longer than the longest
		// bounded multi-provider fallback window.
		idleTimeout: 120,
		connectionTimeout: 5,
	});
	const cacheConnection = new AsyncLocalStorage<Awaited<ReturnType<typeof sql.reserve>>>();

	return {
		async migrate() {
			await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
				version integer PRIMARY KEY,
				name text NOT NULL,
				applied_at timestamptz NOT NULL DEFAULT now()
			)`;

			for (const migration of migrations) {
				await sql.begin(async (tx) => {
					await tx`SELECT pg_advisory_xact_lock(hashtext('keepkey-gateway-migrations'))`;
					const rows = await tx`SELECT version FROM schema_migrations WHERE version = ${migration.version}`;
					if (rows.length > 0) return;
					for (const statement of migration.statements) await tx.unsafe(statement);
					await tx`INSERT INTO schema_migrations (version, name) VALUES (${migration.version}, ${migration.name})`;
				});
			}
		},

		async ping() {
			await sql`SELECT 1`;
		},

		async registerClient(input) {
			const queryKeyHash = await hashQueryKey(input.queryKey);
			const id = crypto.randomUUID();
			const rows = await sql`
				INSERT INTO api_clients (id, query_key_hash, username)
				VALUES (${id}, ${queryKeyHash}, ${input.username})
				ON CONFLICT (query_key_hash) DO UPDATE
				SET username = EXCLUDED.username, last_seen_at = now()
				WHERE api_clients.disabled_at IS NULL
				RETURNING id, username, created_at, last_seen_at
			`;
			if (rows.length === 0) throw new DisabledClientError("This query key is disabled");
			const row = rows[0];
			return {
				id: String(row.id),
				username: String(row.username),
				createdAt: new Date(row.created_at).toISOString(),
				lastSeenAt: new Date(row.last_seen_at).toISOString(),
			};
		},

		async authenticate(queryKey) {
			const queryKeyHash = await hashQueryKey(queryKey);
			const rows = await sql`
				UPDATE api_clients
				SET last_seen_at = now()
				WHERE query_key_hash = ${queryKeyHash} AND disabled_at IS NULL
				RETURNING id, username
			`;
			if (rows.length === 0) return null;
			return { id: String(rows[0].id), username: String(rows[0].username) };
		},

		async upsertPendingSwap(clientId, txHash, payload) {
			const rows = await sql`
				INSERT INTO pending_swaps (client_id, tx_hash, payload_json)
				VALUES (${clientId}, ${txHash}, ${payload})
				ON CONFLICT (client_id, tx_hash) DO UPDATE SET
					payload_json = (CASE WHEN jsonb_typeof(pending_swaps.payload_json) = 'object'
						THEN pending_swaps.payload_json ELSE '{}'::jsonb END) || EXCLUDED.payload_json,
					updated_at = now(),
					version = pending_swaps.version + 1
				RETURNING payload_json, status, created_at, updated_at, last_checked_at
			`;
			return storedPendingSwap(rows[0]);
		},

		async getPendingSwap(clientId, txHash) {
			const rows = await sql`
				SELECT payload_json, status, created_at, updated_at, last_checked_at
				FROM pending_swaps
				WHERE client_id = ${clientId} AND tx_hash = ${txHash}
			`;
			return rows.length > 0 ? storedPendingSwap(rows[0]) : null;
		},

		async updatePendingSwap(clientId, txHash, status, patch) {
			const rows = await sql`
				UPDATE pending_swaps SET
					status = ${status},
					payload_json = payload_json || ${patch},
					updated_at = now(),
					last_checked_at = now(),
					version = version + 1
				WHERE client_id = ${clientId} AND tx_hash = ${txHash}
				RETURNING payload_json, status, created_at, updated_at, last_checked_at
			`;
			return rows.length > 0 ? storedPendingSwap(rows[0]) : null;
		},

		async recordVaultTelemetry(clientId, records) {
			if (records.length === 0) return 0;
			const payload = { records: records.slice(0, 100) };
			return sql.begin(async (tx) => {
				const rows = await tx`
					INSERT INTO vault_performance (client_id, payload_json, client_at)
					SELECT ${clientId}, record, CASE
						WHEN (record->>'at') ~ '^[0-9]+$' THEN to_timestamp((record->>'at')::double precision / 1000)
						ELSE NULL
					END
					FROM jsonb_array_elements((${payload}::jsonb)->'records') AS record
					RETURNING id
				`;
				// Retention is piggy-backed on ingest. There is no cleanup daemon and no
				// work at all while Vaults are disconnected.
				await tx`DELETE FROM vault_performance WHERE received_at < now() - interval '30 days'`;
				await tx`
					DELETE FROM vault_performance
					WHERE client_id = ${clientId} AND id IN (
						SELECT id FROM vault_performance WHERE client_id = ${clientId}
						ORDER BY received_at DESC OFFSET 10000
					)
				`;
				return rows.length;
			});
		},

		async reserveHiveClaim(clientId, ethAddress, username) {
			const rows = await sql`
				INSERT INTO hive_onboarding_claims (eth_address, username, client_id)
				SELECT ${ethAddress}, ${username}, ${clientId}
				WHERE NOT EXISTS (
					SELECT 1 FROM hive_onboarding_claims
					WHERE client_id = ${clientId} AND created_at > now() - interval '24 hours'
				)
				ON CONFLICT DO NOTHING
				RETURNING eth_address
			`;
			return rows.length === 1;
		},

		async completeHiveClaim(ethAddress, txid) {
			await sql`UPDATE hive_onboarding_claims SET status = 'created', txid = ${txid}, completed_at = now() WHERE eth_address = ${ethAddress}`;
		},

		async releaseHiveClaim(ethAddress) {
			await sql`DELETE FROM hive_onboarding_claims WHERE eth_address = ${ethAddress} AND status = 'reserving'`;
		},

		async getFresh<T>(namespace: string, key: string): Promise<T | null> {
			const query = cacheConnection.getStore() || sql;
			const rows = await query`
				SELECT payload_json
				FROM cache_items
				WHERE namespace = ${namespace} AND key = ${key} AND fresh_until > now()
			`;
			if (rows.length === 0) return null;
			const payload = rows[0].payload_json;
			return (typeof payload === "string" ? JSON.parse(payload) : payload) as T;
		},

		async getStale<T>(namespace: string, key: string): Promise<T | null> {
			const query = cacheConnection.getStore() || sql;
			const rows = await query`
				SELECT payload_json
				FROM cache_items
				WHERE namespace = ${namespace} AND key = ${key} AND stale_until > now()
			`;
			if (rows.length === 0) return null;
			const payload = rows[0].payload_json;
			return (typeof payload === "string" ? JSON.parse(payload) : payload) as T;
		},

		async set(namespace, key, value, freshForMs, staleForMs, source) {
			const query = cacheConnection.getStore() || sql;
			const fetchedAt = new Date();
			const freshUntil = new Date(fetchedAt.getTime() + freshForMs);
			const staleUntil = new Date(fetchedAt.getTime() + staleForMs);
			const payload = JSON.stringify(value);
			await query`
				INSERT INTO cache_items (
					namespace, key, payload_json, fetched_at, fresh_until, stale_until, source
				) VALUES (
					${namespace}, ${key}, ${payload}::jsonb, ${fetchedAt}, ${freshUntil}, ${staleUntil}, ${source}
				)
				ON CONFLICT (namespace, key) DO UPDATE SET
					payload_json = EXCLUDED.payload_json,
					fetched_at = EXCLUDED.fetched_at,
					fresh_until = EXCLUDED.fresh_until,
					stale_until = EXCLUDED.stale_until,
					source = EXCLUDED.source,
					last_error = NULL,
					error_at = NULL,
					version = cache_items.version + 1
			`;
		},

		async runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
			const inherited = cacheConnection.getStore();
			const reserved = inherited || await sql.reserve();
			try {
				await reserved`SELECT pg_advisory_lock(hashtextextended(${key}, 0))`;
				// Cache reads and writes must use the lock's connection. Reserving
				// every pool slot then requesting another slot deadlocks cold loads.
				return await cacheConnection.run(reserved, task);
			} finally {
				try {
					await reserved`SELECT pg_advisory_unlock(hashtextextended(${key}, 0))`;
				} finally {
					if (!inherited) reserved.release();
				}
			}
		},

		async close() {
			await sql.close({ timeout: 5 });
		},
	};
}

function storedPendingSwap(row: Record<string, unknown>): StoredPendingSwap {
	const rawPayload = row.payload_json;
	return {
		payload: (typeof rawPayload === "string" ? JSON.parse(rawPayload) : rawPayload) as Record<string, unknown>,
		status: String(row.status),
		createdAt: new Date(row.created_at as string | number | Date).toISOString(),
		updatedAt: new Date(row.updated_at as string | number | Date).toISOString(),
		...(row.last_checked_at ? { lastCheckedAt: new Date(row.last_checked_at as string | number | Date).toISOString() } : {}),
	};
}
