# keepkey-gateway

Pioneer-v5: a rework of KeepKey's API gateway (`pioneer-server-v3`), running on
[Cloudflare Containers](https://developers.cloudflare.com/containers/) instead
of a self-managed Kubernetes cluster on DigitalOcean.

## Why

- DigitalOcean's k8s cluster + load balancers + managed databases have grown
  expensive and increasingly high-maintenance relative to what the workload
  actually needs (see cost/ops history in the private `pioneer` repo).
- `pioneer-server-v3` depends on Redis, Mongo, Watchtower, and a separate cache
  worker. The v5 runtime is one service image, PostgreSQL as its only shared
  durable state, and bounded in-process memory.
- Work is demand-driven: no connected/requesting wallets means zero upstream
  chain, indexer, pricing, or swapper API calls.
- Bun everywhere — the container runtime and (once there's real tooling
  beyond Wrangler) the repo's own scripts.
- OSS from the start, hosted under `bithighlander` for now.

## Architecture

A Cloudflare Worker (`src/index.ts`) routes requests to Bun containers. The
Durable Object is required for container identity/lifecycle, but it is not
Pioneer's application database or cache. The container (`./container`) holds
the HTTP, streaming, and embedded demand-driven job modules; PostgreSQL owns
shared durable state. The current vertical slice serves registration, Zerion
complex positions, CAIP-based CoinGecko market prices, and Vault-compatible
EVM reads across seven networks.

## Status

Hosted at `https://oracles.cc`. The runtime includes market, EVM, UTXO,
portfolio/DeFi, direct and fallback swap routing, pending swaps, and Vault
streaming compatibility. Migration parity is checked against the
[Vault contract](./docs/VAULT-PIONEER-CONTRACT.md); live provider availability
still depends on networks, trading pairs, amounts and configured API keys.

## Plan

1. Freeze the API behavior actually consumed by the current Vault.
2. Build the PostgreSQL-backed runtime, demand leases, bounded memory cache,
   embedded job runner, and zero-idle-traffic proof.
3. Implement the Vault contract in vertical capability slices.
4. Contract-test and shadow v5 against green/blue before provider canary.

See [the Vault compatibility contract](./docs/VAULT-PIONEER-CONTRACT.md) and
[the migration plan](./docs/MIGRATION-PLAN.md).

## Development

The gateway uses port `12000`. The complete local stack is:

```bash
bun install
cp .env.example .env  # then set only the provider keys you need
bun run local          # PostgreSQL + gateway through Docker Compose
```

If PostgreSQL is already running locally, set `DATABASE_URL` in `.env` and run
`bun run dev:container`. Useful probes:

```bash
curl http://127.0.0.1:12000/api/v1/health
curl http://127.0.0.1:12000/spec/swagger.json
```

The intentionally small environment contract and Zerion response mapping are
documented in [local development](./docs/LOCAL-DEVELOPMENT.md) and
[the Zerion adapter](./docs/ZERION.md). EVM, market caching, and the discovery
snapshot are documented in [EVM and market adapters](./docs/EVM-MARKET.md).

Cloudflare development and deployment remain available as `bun run dev` and
`bun run deploy`. See [PlanetScale deployment](./docs/PLANETSCALE.md) for the
isolated hosted alpha database, credentials, and migration workflow.

The hosted gateway is available at `https://oracles.cc`. Wrangler declares the
`oracles.cc/*` Worker route, which sends the apex domain's traffic directly to
`keepkey-gateway` using the existing proxied DNS record. Verify readiness at
`https://oracles.cc/api/v1/health` and the API contract at
`https://oracles.cc/spec/swagger.json`.

CI stamps the commit into the container image. Deployment verification waits
for `/api/v1/health` to report that exact `revision` and a healthy database;
a healthy previous image during rollout does not satisfy the check.

The Worker rewrites OpenAPI server URLs using the public request origin because
container forwarding uses HTTP internally. Advertising that internal scheme
causes SDK POSTs to lose their method and body on an HTTP-to-HTTPS 301 redirect.
Run `bun run test:portfolio-client --url=https://oracles.cc` to check the live
portfolio endpoint with Vault's installed, unchanged Pioneer client and a public
fixture address. Cloudflare uses a method-preserving HTTPS redirect (307) for
legacy HTTP URLs. Cross-scheme redirects can still strip authorization, so an
already-initialized client must reload its API configuration. Desktop's existing
`POST /api/pioneer/url` endpoint can reload the same HTTPS URL without a process
restart or a Vault code change.

The Worker uses `pioneer-main-recovery-20261003` with shared PostgreSQL. This replaced an
instance whose portfolio requests stalled while health checks continued to pass.
Structured Worker logs record request method, path, status, and timing without
recording authorization headers, query strings, or wallet payloads.

Cache reads and writes inside an advisory lock reuse its reserved database
connection, avoiding pool starvation during concurrent cold portfolio loads.
Run the database regression tests against a dedicated test database with
`CACHE_TEST_DATABASE_URL=postgres://... bun test container/src/database-cache.integration.test.ts`.

## License

MIT — see [LICENSE](./LICENSE).
