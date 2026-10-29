# HANDOFF: keepkey-gateway (pioneer-v5) bootstrap

**Status:** runnable local foundation with PostgreSQL migrations,
authentication/bootstrap routes, and a live Zerion DeFi adapter. Wallet-core
chain operations are not implemented yet.

## What this is

A rework of `pioneer-server-v3` (private `pioneer` monorepo,
`services/pioneer-server`) to run on **Cloudflare Containers** instead of a
self-managed Kubernetes cluster on DigitalOcean.

Repo: https://github.com/BitHighlander/keepkey-gateway (public, MIT, OSS from
the start, hosted under `bithighlander` for now)

## Why (context from the pioneer session that spawned this)

- DO's k8s cluster + LBs + managed databases had grown expensive
  (~$450/mo) and high-maintenance relative to actual load. See the private
  `pioneer` repo's memory/session history for the full cost audit (node pool
  right-sizing, dead LBs, registry bloat, etc.) — that's a separate,
  already-in-progress cleanup on the *existing* DO stack and is NOT blocked
  on this work.
- `pioneer-server-v3` depends on Redis/Mongo plus separate Watchtower and cache
  workers. **Decision (2026-08-23):** v5 is one application image, PostgreSQL
  as its only shared durable state, and bounded in-process memory. Durable
  Object storage, KV, and Cloudflare Cache are not application state.
- Work is demand-driven. With no connected or requesting wallets, v5 makes
  zero upstream chain/indexer/pricing/swapper calls. Watches are deduplicated
  and stop after the final client interest lease expires.
- Runtime is **Bun**, not Node — the container image, and the repo's own
  tooling (`bun install`, `bun run ...`).

## What's actually done

1. Bare repo scaffold — `package.json`, `tsconfig.json`, `.gitignore`,
   `LICENSE` (MIT).
2. A **Worker** (`src/index.ts`) that proxies every request to a single
   container-backed Durable Object (`PioneerContainer`, via
   `@cloudflare/containers`). This is the real pattern — not a bare Worker
   guess. WebSocket upgrades forward transparently through
   `container.fetch(request)` (confirmed via the `@cloudflare/containers`
   package README, `node_modules/@cloudflare/containers/README.md` after
   `bun install`).
3. A Bun **container** (`container/server.ts`, `container/Dockerfile`) with
   fail-fast configuration, PostgreSQL migrations, readiness, OpenAPI,
   query-key registration/authentication, and the first provider adapter.
4. `wrangler.jsonc` wires the container binding, Durable Object binding, and
   the SQLite migration Cloudflare Containers requires.

**Verified so far:**
- `bun run typecheck` and `bun test` pass for Worker and container code.
- The gateway is live locally on port `12000` against PostgreSQL 16.
- Startup migrations created clients, interests, cache, jobs, and event tables.
- Vault-style query-key registration persists only a SHA-256 hash.
- The migrated Zerion credential returned normalized live DeFi positions.
- A cold result and chain catalog persist in PostgreSQL; after process restart,
  the same request was served in about 7ms with no upstream call.
- Docker Compose is defined, but Docker Desktop's engine socket was unresponsive
  during the verification session. The non-disruptive Homebrew PostgreSQL path
  was used rather than restarting Docker and affecting unrelated containers.
- **Not yet verified:** `wrangler dev` with the actual container binding.

## Reference architecture — read this first

`/Users/highlander/gamedev/DegenQuest-v41/projects/game/deploy/core-container/`
(a sibling project, NOT related to keepkey/pioneer functionally, but the
**exact same infra pattern** already proven in production):

- `docs/CLOUDFLARE-CONTAINER-CUTOVER.md` — the gate-by-gate migration plan
  DegenQuest actually executed (alpha → prod, DOKS retirement). Worth
  mirroring the *shape* of this (prove on a staging route before touching
  production DNS) even though pioneer's specifics differ.
- `wrangler.prod.toml` — real `[[containers]]` / `durable_objects.bindings`
  / `[[migrations]]` config, including `instance_type`, `max_instances`,
  region constraints, and a cron trigger for keep-warm.
- `src/index.js` — the `Container` subclass + routing Worker, including:
  scale-to-zero via `sleepAfter` + an `onActivityExpired` readiness check,
  lifecycle hooks (`onStart`/`onStop`/`onError`) writing to Durable Object
  storage, and a canary control-plane pattern (`/__canary/:world/state`)
  worth stealing for pioneer's own blue/green-equivalent on Cloudflare.

## Next steps (roughly in order)

1. Resolve/restart Docker Desktop when safe, then verify both Compose and
   `wrangler dev` with the container binding on port `12000`.
2. PlanetScale alpha is provisioned in AWS us-east; see
   `docs/PLANETSCALE.md`. Validate direct TLS access from the deployed Bun
   container with a deliberately small connection pool. Do not
   assume Hyperdrive is available inside a Container; it is documented as a
   Workers binding.
3. Implement the P0 wallet-read slice from the consumer-derived contract in
   `docs/VAULT-PIONEER-CONTRACT.md`, following the demand-driven execution
   model and capability slices in `docs/MIGRATION-PLAN.md`. Do not broadly
   port old Pioneer controllers.
4. Set up CI (GitHub Actions) for Cloudflare deploys — DegenQuest's
   `deploy-alpha.yml`/`deploy-server.yml` (same repo, `.github/workflows/`)
   are the reference for "CI owns the container image and rollout,
   `wrangler deploy` from a dev machine is never a release artifact."

## Explicitly not decided yet — don't assume

- Production Postgres sizing and recovery policy. Alpha now uses isolated
  PlanetScale `keepkey-gateway-alpha`; see `docs/PLANETSCALE.md`.
- Replica count/routing and the failure-detection/lease timing that bounds work
  after an unclean disconnect while preserving the zero-idle API-load goal.
- Which swap integrations and secondary Vault features enter the first public
  cutover.
- Timeline / whether the existing DO cost-reduction work should pause once
  this is further along, or whether both tracks run independently.

Ask the user before assuming any of the above.
