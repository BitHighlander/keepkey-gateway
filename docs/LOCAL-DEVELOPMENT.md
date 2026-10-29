# Local development

## Fast path

The default local gateway URL is `http://127.0.0.1:12000`.

```bash
bun install
cp .env.example .env
# Set the provider credentials for the capabilities being tested.
bun run local
```

Compose starts PostgreSQL 17 and the Bun gateway, waits for PostgreSQL health,
runs migrations, and then accepts traffic on port `12000`.

If a local PostgreSQL is already available:

```bash
createdb pioneer
bun run dev:container
```

`bun` loads the gitignored `.env` file automatically.

## Environment contract

There are six operational variables. Legacy aliases are intentionally not
accepted, keeping deployment configuration canonical:

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | none | PostgreSQL connection URL, including TLS parameters when required |
| `NOWNODES_API_KEY` | for EVM | none | EVM JSON-RPC credential |
| `COINGECKO_API_KEY` | for market data | none | CoinGecko Pro API credential |
| `ZERION_API_KEY` | only for DeFi | none | Server-side Zerion API credential |
| `PORT` | no | `12000` | Bun HTTP listener |
| `DATABASE_MAX_CONNECTIONS` | no | `5` | Per-replica PostgreSQL pool ceiling, constrained to `1..20` |

Application behavior is not configured through dozens of tuning variables.
Cache TTLs, lease rules, timeouts, and adapter policies are versioned code with
tests. A setting becomes an environment variable only when deployment genuinely
needs to vary it independently.

The service fails before listening if `DATABASE_URL` is absent or invalid.
Missing provider credentials disable only their adapter; health remains ready
and reports each of `evm`, `market`, and `zerion` as enabled or disabled.

Never copy the legacy Pioneer `.env` wholesale. In particular, v5 must not
receive MongoDB, Redis, Zapper, Watchtower, wallet private key, faucet, signing,
Discord, or unrelated deployment credentials.

## Verification

```bash
bun run typecheck
bun test
bun run test:live
curl http://127.0.0.1:12000/api/v1/health
curl http://127.0.0.1:12000/spec/swagger.json
```

Register the same way Vault does:

```bash
curl -X POST http://127.0.0.1:12000/api/v1/user/register \
  -H 'content-type: application/json' \
  --data '{"username":"local-vault","queryKey":"vault:local-live-test"}'
```

The query key is SHA-256 hashed before PostgreSQL storage.

`bun run test:live` expects the gateway already listening on port `12000`. It
registers a local test query key, exercises real CoinGecko, NOWNodes, and Zerion
calls through the gateway, validates all seven configured EVM networks, and
writes a sanitized ignored report to `artifacts/live/latest.json`. Override the
target without adding another operational environment variable:

```bash
bun --env-file=.env container/live/run.ts --url=http://127.0.0.1:12001
```
