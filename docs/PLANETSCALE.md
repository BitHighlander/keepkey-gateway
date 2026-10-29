# PlanetScale deployment

## Target

- Organization: `bithighlander`
- Database: `keepkey-gateway-alpha`
- Branch: `main` (PlanetScale production branch, used for the gateway alpha)
- Engine: PostgreSQL 17
- Region: AWS `us-east` / N. Virginia
- Size: `PS_5_AWS_ARM`, single node, zero replicas
- Base compute: $5/month at provisioning; storage and other usage may add cost.
- Dashboard: https://app.planetscale.com/bithighlander/keepkey-gateway-alpha

This is a separate PlanetScale database from `degenquest-alpha` and
`degenquest-prod`. It shares their organization and billing, but has its own
cluster, schema, and credentials. No DegenQuest data or database credentials
are copied.

## Reference architecture

Reviewed `/Users/highlander/gamedev/DegenQuest-v46`: its server reads
`DATABASE_URL` from the environment and uses a bounded connection pool;
`projects/game/deploy/core-container/src/container-env.js` forwards that secret
to its Cloudflare container. KeepKey already implements the same pattern with
Bun SQL and five connections. The current Worker routes through one fixed
Durable Object/container instance, so `max_instances: 3` is spare capacity and
does not currently create three application replicas.

Use direct PostgreSQL port **5432** with `sslmode=verify-full`. The gateway
uses session advisory locks on reserved connections, so transaction-mode
PgBouncer on port 6432 is unsuitable for this implementation.

## Credentials and migrations

The ignored, owner-readable `.env.planetscale` holds the KeepKey-only
`DATABASE_URL`. The existing `.env` remains the local development configuration.
Never put the database URL in Wrangler vars, committed files, or command arguments.

The application role has read/write access and `CREATE` on the `public` schema
of this isolated database. The gateway currently runs migrations during boot,
so it owns the tables it creates. It does not need the `postgres` administrative
role. Before a broader production rollout, separate migration execution and
schema ownership from runtime access.

Apply the checked-in schema without starting the HTTP server:

```bash
bun --env-file=.env.planetscale container/migrate.ts
```

Run the gateway against the hosted alpha database:

```bash
bun --env-file=.env --env-file=.env.planetscale container/server.ts
```

These commands use the real alpha database. Keep ordinary local development
on Docker Compose / `.env`.

## Cloudflare deployment

The Worker is named `keepkey-gateway` in `wrangler.jsonc`. Its deployment
requires `DATABASE_URL` plus the five provider API keys listed there.
The ignored, owner-readable `.env.cloudflare.json` contains those secrets,
combining the new KeepKey database credential with the existing gateway provider
keys. Upload it during the application deployment workflow:

```bash
bunx wrangler secret bulk .env.cloudflare.json
```

This updates remote Worker secrets and may offer to create a missing Worker;
it has not been run as part of database provisioning. Never use the PlanetScale
management token as an application credential.

Database provisioning alone does not deploy the Worker or container. Verify
`/api/v1/health` returns `database: "ok"` from the deployed Worker before
declaring the Cloudflare-to-PlanetScale path working.

## Provisioning verification — 2026-09-15 UTC

- Database and branch report `ready`; PostgreSQL reports version 17.11.
- Application role: `keepkey-gateway-runtime`, ID `vehun3eqfrlb`.
- Direct endpoint certificate verified with TLS 1.3.
- All five migrations applied; nine tables exist in `public`.
- The application health handler, invoked locally against hosted PostgreSQL,
  returned HTTP 200 and `database: "ok"`.
- Application role has no superuser, create-database, or create-role privilege.
- TypeScript checks passed.
- Secret files are git-ignored and mode `0600`.
- No completed backups were present during initial provisioning; recovery
  readiness remains unverified.
- Cloudflare deployment `e5044f51-6cf0-4448-b4d5-5ea39319b1e4` is live at
  `https://keepkey-gateway.bithighlander.workers.dev`; public health returned
  HTTP 200 with `database: "ok"`.
- Public registration issues access on demand, query keys require at least 32
  characters, and bounded per-isolate IP plus query-key rate limits run before
  the container. These limits reset with isolates and are not globally exact.

## Production follow-up

- Measure Cloudflare-container latency to `us-east`.
- Size compute and connection limits from actual load.
- Enable HA before requiring automatic failover; this starter is single-node.
- Verify completed backups and restore procedures; establish retention and
  recovery objectives before accepting production data.
- Use a separate database for a future production environment.

Sources: [connections](https://planetscale.com/docs/postgres/connecting/quickstart),
[roles](https://planetscale.com/docs/postgres/connecting/roles),
[pricing](https://planetscale.com/docs/postgres/pricing).
