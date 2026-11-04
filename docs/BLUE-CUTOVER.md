# Pioneer blue gateway cutover

Target: `api-blue.keepkey.info` routes to the same Cloudflare Worker and gateway
container as `oracles.cc`. The production hostname `api.keepkey.info` continues
to use legacy green. Follow the gates below for future cutovers and rollback.

## Deployment order

1. Merge the legacy Pioneer workflow change removing `smoke-test-blue-pre`,
   `deploy-blue`, `smoke-test-blue-post` and `rollback-blue`. Apply it to active
   release branches and cancel any older running blue rollout. Legacy release
   images remain available for green; gateway checks cannot validate those images.
2. Inspect the existing `api-blue.keepkey.info` DNS record in the `keepkey.info`
   zone. Save its type, content, TTL and proxy state privately. The record must
   be proxied for a Worker route to intercept requests. If DNS is managed outside
   this Cloudflare account, stop and resolve ownership before changing anything.
   Check for an existing overlapping Worker route and preserve its rollback state.
3. Save the old blue Deployment and any HPA targeting it, including the current
   running image digest. Retain the Service/Ingress/DNS records for rollback.
   Snapshots can contain environment values and must remain private.
4. For an alias-only cutover, keep the currently published Worker/container
   revision and apply the checked-in routes with the project's locked Wrangler:
   `./node_modules/.bin/wrangler triggers deploy`. Record that published revision
   for the live health checks. Code/container changes continue through the existing
   deployment CI. Both domains use the same Worker; no redirect to `oracles.cc`
   is needed. OpenAPI must advertise the caller's hostname so SDK POSTs and
   authorization stay on origin.
5. Require the exact deployed gateway revision and healthy database on both
   domains. The CI blue gate additionally checks the HTTPS OpenAPI origin and
   all three Litecoin derivation families. Run the installed Vault SDK portfolio
   probe against blue, then check receive balances/history and active SSE or
   Socket.IO delivery. Do not execute or broadcast a transaction for these checks.
6. Confirm green's health and routing are unchanged. Only after all replacement
   checks pass, delete the exact legacy blue HPA and Deployment identified from
   live inventory. Never delete by an imprecise `blue` name substring or remove
   shared workers, databases, namespaces, Services or Ingresses.

Useful probes from the gateway checkout, with Vault installed locally:

```sh
bun container/live/deploy-health.ts https://api-blue.keepkey.info FULL_GATEWAY_SHA
bun container/live/portfolio-client.mjs --url=https://api-blue.keepkey.info
bun container/live/ltc-script-discovery.ts https://api-blue.keepkey.info
```

The existing Cloudflare token needs access to both zones and Worker routes. A
successful deploy to `oracles.cc` alone does not prove access to `keepkey.info`.

## Rollback

Restore the saved blue Deployment with its immutable running image digest and
verify its readiness before returning traffic. Restore its HPA after the
Deployment is healthy. Then remove only the gateway's `api-blue.keepkey.info/*`
Worker route and restore the previous overlapping route and DNS proxy state,
if either was changed. Keep the `oracles.cc/*` route in place. Verify legacy
blue health and Swagger, plus green health. The retired legacy deployment jobs
remain retired unless a separate decision restores their ownership.

## Completed cutover, 2026-11-04

Host access to Wrangler and Kubernetes is available. Wrangler's OAuth credential
can manage Worker routes but its DNS-record read endpoint returns HTTP 403.
The existing blue A record was inspected in the authenticated Cloudflare browser
session: it is already proxied, so no DNS-record change is required. Rollback
snapshots remain private. Earlier sandbox name-resolution and listener failures
must not be treated as evidence that the host's DNS is broken.

The existing OAuth login successfully applied both routes using the locked
Wrangler's `triggers deploy`. No new token or DNS-record edit was needed. Both
domains passed health and database checks at the published gateway revision
`bff70f2a83e2db01a7acb8f06d2dd714974ceaf3`.

Blue's HTTPS OpenAPI origin, all three Litecoin derivation families (including
receive/change branches), eight concurrent installed Vault SDK balance requests,
public receive balances and transaction history passed. An authenticated SSE
connection delivered both its connected frame and a sync event. These checks
used public fixtures and did not sign or broadcast transactions.

Legacy Pioneer PR219 was merged and its workflow retirement backported to
`develop`, `release/v1.5.0` and `release/v1.4.5`. The exact old Deployment
`default/pioneer-server-v3-blue-2l3smo5j` was deleted in context
`do-sfo3-do-cluster-2b9226d` after its UID and template were rechecked against the
private snapshot. No HPA targeted it. Its pods are absent, and blue passed the
same exact-revision health check after deletion. The Service, Ingress and DNS
record remain available for rollback. Green still reports the same legacy
service version 1.4.5 and its pre-existing degraded status; this cutover does not
resolve that separate health condition.
