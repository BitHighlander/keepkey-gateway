# keepkey-gateway

Pioneer-v5: a rework of KeepKey's API gateway (`pioneer-server-v3`), running on
[Cloudflare Containers](https://developers.cloudflare.com/containers/) instead
of a self-managed Kubernetes cluster on DigitalOcean.

## Why

- DigitalOcean's k8s cluster + load balancers + managed databases have grown
  expensive and increasingly high-maintenance relative to what the workload
  actually needs (see cost/ops history in the private `pioneer` repo).
- `pioneer-server-v3` depends on Redis for caching/pending-balance overlays.
  This rework removes that dependency — target state uses Cloudflare-native
  primitives (Durable Objects / KV / cache) instead of a managed Redis.
- Mongo is being retired in favor of Postgres.
- Bun everywhere — the container runtime and (once there's real tooling
  beyond Wrangler) the repo's own scripts.
- OSS from the start, hosted under `bithighlander` for now.

## Architecture

A Cloudflare Worker (`src/index.ts`) proxies every request to a single
container-backed Durable Object (`PioneerContainer`). The container
(`./container`, Bun) is where pioneer's actual server logic will live —
right now it's a minimal health + WebSocket-echo stub proving the
Worker → Container → WebSocket path end-to-end. Pattern taken from
DegenQuest's proven Cloudflare Containers cutover
(`projects/game/deploy/core-container` in the DegenQuest-v41 repo).

## Status

Bootstrapping. Not yet handling real traffic.

## Plan

1. Scaffold (this commit) — bare Cloudflare Worker, `/api/v1/health`.
2. Port over what's leverageable from `pioneer-server-v3` / `pioneer-server-v2`
   (private `pioneer` monorepo): CAIP/discovery data, blockbook client,
   balance-cache logic — reworked to drop the Redis dependency.
3. Stand up a Cloudflare Container binding for anything that can't run as a
   plain Worker (long-lived connections, heavier compute).
4. Parity-test against `pioneer-server-v3` before any real cutover.

## Development

```bash
bun install
bun run dev       # wrangler dev
bun run deploy    # wrangler deploy
```

## License

MIT — see [LICENSE](./LICENSE).
