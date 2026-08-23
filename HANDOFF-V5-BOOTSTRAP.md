# HANDOFF: keepkey-gateway (pioneer-v5) bootstrap

**Status:** early scaffold, verified working end-to-end for a trivial case.
Not yet handling any real pioneer logic. Picking this up fresh is fine —
there's no in-flight state to lose, just a proven pattern to build on.

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
- `pioneer-server-v3` depends on Redis (pending-balance overlays, caching).
  **Goal: drop Redis entirely**, replaced by Cloudflare-native primitives
  (Durable Object storage / KV / cache).
- **Mongo is being retired in favor of Postgres** — decided mid-session,
  not yet designed. Whatever DB layer this ends up with should target
  Postgres from the start, not Mongo.
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
3. A minimal **container** (`container/server.ts`, `container/Dockerfile`,
   `oven/bun:1-alpine` base) — just a health check + WebSocket echo. This
   is a placeholder proving the Worker → Container → WebSocket path works,
   not real pioneer logic yet.
4. `wrangler.jsonc` wires the container binding, Durable Object binding, and
   the SQLite migration Cloudflare Containers requires.

**Verified so far:**
- `bun install` + `bun run typecheck` (`tsc --noEmit`) clean on the Worker.
- `bun run server.ts` inside `container/` runs standalone, health check
  responds with a real 200.
- **Not yet verified:** `wrangler dev` with the actual container binding
  (needs Docker running locally — that step got interrupted mid-session).
  This is the very next thing to check before building anything further.

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

1. Get `wrangler dev` actually running the container locally (needs Docker
   Desktop or equivalent running) — confirm the Worker → Container →
   WebSocket path really works, not just the container standalone.
2. Decide the Postgres access pattern (Cloudflare Hyperdrive in front of a
   managed Postgres, most likely — Cloudflare has no native managed
   Postgres) and the Redis-replacement pattern (Durable Object storage is
   the obvious first candidate for pending-balance overlays specifically,
   since that data is inherently per-key/small).
3. Start porting real `pioneer-server-v3` logic into `container/` —
   `pioneer-discovery` (static CAIP/asset data, no state) is the smallest,
   safest first real slice. Balance/history logic (the Redis-dependent
   part) should come later, once the replacement caching pattern is chosen.
4. Set up CI (GitHub Actions) for Cloudflare deploys — DegenQuest's
   `deploy-alpha.yml`/`deploy-server.yml` (same repo, `.github/workflows/`)
   are the reference for "CI owns the container image and rollout,
   `wrangler deploy` from a dev machine is never a release artifact."

## Explicitly not decided yet — don't assume

- Whether this fully replaces `pioneer-server-v3` or runs alongside it for
  a while.
- Exact Postgres hosting (Neon? Supabase? DO's own managed Postgres, kept
  around specifically for this?).
- Timeline / whether the existing DO cost-reduction work should pause once
  this is further along, or whether both tracks run independently.

Ask the user before assuming any of the above.
