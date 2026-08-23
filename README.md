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
- OSS from the start, hosted under `bithighlander` for now.

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
npm install
npm run dev       # wrangler dev
npm run deploy    # wrangler deploy
```

## License

MIT — see [LICENSE](./LICENSE).
