export interface Migration {
	version: number;
	name: string;
	statements: readonly string[];
}

export const migrations: readonly Migration[] = [
	{
		version: 1,
		name: "runtime_foundation",
		statements: [
			`CREATE TABLE IF NOT EXISTS api_clients (
				id uuid PRIMARY KEY,
				query_key_hash text NOT NULL UNIQUE,
				username text NOT NULL,
				created_at timestamptz NOT NULL DEFAULT now(),
				last_seen_at timestamptz NOT NULL DEFAULT now(),
				disabled_at timestamptz
			)`,
			`CREATE TABLE IF NOT EXISTS interest_leases (
				resource_kind text NOT NULL,
				resource_key text NOT NULL,
				client_id uuid NOT NULL REFERENCES api_clients(id) ON DELETE CASCADE,
				owner_id text NOT NULL,
				expires_at timestamptz NOT NULL,
				updated_at timestamptz NOT NULL DEFAULT now(),
				PRIMARY KEY (resource_kind, resource_key, client_id, owner_id)
			)`,
			`CREATE INDEX IF NOT EXISTS interest_leases_active_idx
				ON interest_leases (resource_kind, resource_key, expires_at)`,
			`CREATE TABLE IF NOT EXISTS cache_items (
				namespace text NOT NULL,
				key text NOT NULL,
				payload_json jsonb NOT NULL,
				fetched_at timestamptz NOT NULL,
				fresh_until timestamptz NOT NULL,
				stale_until timestamptz NOT NULL,
				source text NOT NULL,
				last_error text,
				error_at timestamptz,
				version bigint NOT NULL DEFAULT 1,
				PRIMARY KEY (namespace, key)
			)`,
			`CREATE INDEX IF NOT EXISTS cache_items_expiry_idx ON cache_items (stale_until)`,
			`CREATE TABLE IF NOT EXISTS jobs (
				id uuid PRIMARY KEY,
				kind text NOT NULL,
				resource_key text NOT NULL,
				payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
				priority integer NOT NULL DEFAULT 0,
				state text NOT NULL DEFAULT 'pending',
				run_at timestamptz NOT NULL DEFAULT now(),
				lease_owner text,
				lease_until timestamptz,
				attempts integer NOT NULL DEFAULT 0,
				last_error text,
				created_at timestamptz NOT NULL DEFAULT now(),
				updated_at timestamptz NOT NULL DEFAULT now(),
				CONSTRAINT jobs_state_check CHECK (state IN ('pending', 'leased', 'complete', 'failed'))
			)`,
			`CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_active_resource_idx
				ON jobs (kind, resource_key) WHERE state IN ('pending', 'leased')`,
			`CREATE INDEX IF NOT EXISTS jobs_due_idx ON jobs (state, run_at, priority DESC)`,
			`CREATE TABLE IF NOT EXISTS event_outbox (
				id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
				routing_key text NOT NULL,
				event_type text NOT NULL,
				payload_json jsonb NOT NULL,
				created_at timestamptz NOT NULL DEFAULT now(),
				expires_at timestamptz NOT NULL
			)`,
			`CREATE INDEX IF NOT EXISTS event_outbox_route_idx ON event_outbox (routing_key, id)`,
			`CREATE INDEX IF NOT EXISTS event_outbox_expiry_idx ON event_outbox (expires_at)`,
		],
	},
	{
		version: 2,
		name: "pending_swaps",
		statements: [
			`CREATE TABLE IF NOT EXISTS pending_swaps (
				client_id uuid NOT NULL REFERENCES api_clients(id) ON DELETE CASCADE,
				tx_hash text NOT NULL,
				status text NOT NULL DEFAULT 'pending',
				payload_json jsonb NOT NULL,
				created_at timestamptz NOT NULL DEFAULT now(),
				updated_at timestamptz NOT NULL DEFAULT now(),
				last_checked_at timestamptz,
				version bigint NOT NULL DEFAULT 1,
				PRIMARY KEY (client_id, tx_hash),
				CONSTRAINT pending_swaps_status_check CHECK (status IN (
					'pending', 'pending_confirmation', 'confirming', 'output_detected', 'output_confirming',
					'output_confirmed', 'completed', 'failed', 'refunded'
				))
			)`,
			`CREATE INDEX IF NOT EXISTS pending_swaps_active_idx
				ON pending_swaps (client_id, updated_at DESC)
				WHERE status IN ('pending', 'pending_confirmation', 'confirming')`,
		],
	},
	{
		version: 3,
		name: "pending_swap_output_states",
		statements: [
			`ALTER TABLE pending_swaps DROP CONSTRAINT IF EXISTS pending_swaps_status_check`,
			`ALTER TABLE pending_swaps ADD CONSTRAINT pending_swaps_status_check CHECK (status IN (
				'pending', 'pending_confirmation', 'confirming', 'output_detected', 'output_confirming',
				'output_confirmed', 'completed', 'failed', 'refunded'
			))`,
		],
	},
	{
		version: 4,
		name: "vault_performance_telemetry",
		statements: [
			`CREATE TABLE IF NOT EXISTS vault_performance (
				id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
				client_id uuid NOT NULL REFERENCES api_clients(id) ON DELETE CASCADE,
				payload_json jsonb NOT NULL,
				client_at timestamptz,
				received_at timestamptz NOT NULL DEFAULT now()
			)`,
			`CREATE INDEX IF NOT EXISTS vault_performance_client_time_idx
				ON vault_performance (client_id, received_at DESC)`,
			`CREATE INDEX IF NOT EXISTS vault_performance_expiry_idx
				ON vault_performance (received_at)`,
		],
	},
	{
		version: 5,
		name: "hive_sponsored_onboarding",
		statements: [
			`CREATE TABLE IF NOT EXISTS hive_onboarding_claims (
				eth_address text PRIMARY KEY,
				username text NOT NULL UNIQUE,
				client_id uuid NOT NULL REFERENCES api_clients(id) ON DELETE CASCADE,
				status text NOT NULL DEFAULT 'reserving',
				txid text,
				created_at timestamptz NOT NULL DEFAULT now(),
				completed_at timestamptz,
				CONSTRAINT hive_onboarding_status_check CHECK (status IN ('reserving', 'created'))
			)`,
			`CREATE INDEX IF NOT EXISTS hive_onboarding_client_time_idx ON hive_onboarding_claims (client_id, created_at DESC)`,
		],
	},
	{
		version: 6,
		name: "durable_realtime_watches_and_delivery",
		statements: [
			`CREATE TABLE IF NOT EXISTS realtime_wallets (
				client_id uuid NOT NULL REFERENCES api_clients(id) ON DELETE CASCADE,
				wallet_scope text NOT NULL,
				revision bigint NOT NULL,
				enabled boolean NOT NULL DEFAULT true,
				created_at timestamptz NOT NULL DEFAULT now(),
				updated_at timestamptz NOT NULL DEFAULT now(),
				PRIMARY KEY (client_id, wallet_scope)
			)`,
			`CREATE TABLE IF NOT EXISTS realtime_watches (
				client_id uuid NOT NULL,
				wallet_scope text NOT NULL,
				watch_id text NOT NULL,
				network_id text NOT NULL,
				address text NOT NULL,
				since_at timestamptz NOT NULL,
				created_at timestamptz NOT NULL DEFAULT now(),
				PRIMARY KEY (client_id, wallet_scope, watch_id),
				FOREIGN KEY (client_id, wallet_scope) REFERENCES realtime_wallets(client_id, wallet_scope) ON DELETE CASCADE
			)`,
			`CREATE INDEX IF NOT EXISTS realtime_watches_watch_idx ON realtime_watches (watch_id)`,
			`CREATE TABLE IF NOT EXISTS realtime_events (
				id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
				client_id uuid NOT NULL,
				wallet_scope text NOT NULL,
				watch_id text NOT NULL,
				event_id text NOT NULL,
				event_name text NOT NULL CHECK (event_name IN ('tx:incoming', 'tx:confirmed')),
				payload_json jsonb NOT NULL,
				created_at timestamptz NOT NULL DEFAULT now(),
				expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
				acked_at timestamptz,
				UNIQUE (client_id, wallet_scope, event_id),
				FOREIGN KEY (client_id, wallet_scope, watch_id) REFERENCES realtime_watches(client_id, wallet_scope, watch_id) ON DELETE CASCADE
			)`,
			`CREATE INDEX IF NOT EXISTS realtime_events_replay_idx ON realtime_events (client_id, wallet_scope, id) WHERE acked_at IS NULL`,
			`CREATE INDEX IF NOT EXISTS realtime_events_expiry_idx ON realtime_events (expires_at)`,
		],
	},
	{
		version: 7,
		name: "realtime_early_acknowledgements",
		statements: [
			`CREATE TABLE IF NOT EXISTS realtime_ack_receipts (
				client_id uuid NOT NULL,
				wallet_scope text NOT NULL,
				event_id text NOT NULL,
				acked_at timestamptz NOT NULL DEFAULT now(),
				expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
				PRIMARY KEY (client_id, wallet_scope, event_id),
				FOREIGN KEY (client_id, wallet_scope) REFERENCES realtime_wallets(client_id, wallet_scope) ON DELETE CASCADE
			)`,
			`CREATE INDEX IF NOT EXISTS realtime_ack_receipts_expiry_idx ON realtime_ack_receipts (expires_at)`,
		],
	},
	{
		version: 8,
		name: "provider_usage_metrics",
		statements: [
			`CREATE TABLE IF NOT EXISTS provider_usage_minute (
				bucket timestamptz NOT NULL, instance_id uuid NOT NULL, provider text NOT NULL,
				source text NOT NULL, client_id text NOT NULL, operation text NOT NULL,
				outcome text NOT NULL, forced boolean NOT NULL, status integer NOT NULL,
				count bigint NOT NULL, duration_ms bigint NOT NULL,
				PRIMARY KEY (bucket, instance_id, provider, source, client_id, operation, outcome, forced, status)
			)`,
		],
	},
 {
  version: 9, name: "provider_spend_controls", statements: [
   `ALTER TABLE provider_usage_minute ADD COLUMN IF NOT EXISTS credential_id text NOT NULL DEFAULT ''`,
   `ALTER TABLE provider_usage_minute ADD COLUMN IF NOT EXISTS refresh_reason text NOT NULL DEFAULT ''`,
   `CREATE TABLE IF NOT EXISTS provider_request_budgets (
     provider text NOT NULL, window_kind text NOT NULL, window_start timestamptz NOT NULL,
     used bigint NOT NULL CHECK (used >= 0), PRIMARY KEY(provider,window_kind,window_start))`,
   `CREATE TABLE IF NOT EXISTS provider_budget_alerts (
     provider text NOT NULL, window_kind text NOT NULL, window_start timestamptz NOT NULL,
     threshold integer NOT NULL, used bigint NOT NULL, request_limit bigint NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(provider,window_kind,window_start,threshold))`
  ]
 },
];
