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
];
