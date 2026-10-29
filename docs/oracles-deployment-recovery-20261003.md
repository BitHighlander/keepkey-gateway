# oracles.cc deployment recovery

Verified October 3, 2026 UTC. No Vault source changes or Desktop process restart.

## Findings and deployed fixes

| Finding | Change | Verification |
| --- | --- | --- |
| Apex traffic was not routed to the gateway Worker; redirect loop | `oracles.cc/*` Worker route | Public health and Swagger return 200 |
| Swagger advertised internal HTTP; HTTPS 301 changed SDK POSTs into GETs, yielding 404 | Rewrite Swagger servers to the public origin; Cloudflare HTTPS redirect uses 307 | Unchanged installed Vault SDK sends HTTPS POST directly, without redirects |
| Already-initialized SDK retained HTTP configuration; cross-scheme redirects can strip authorization | Reloaded the same HTTPS server URL through Desktop's existing `/api/pioneer/url` endpoint | Desktop remained running |
| Portfolio operations stalled although health checks passed | Fresh gateway instance, then updated container image | Old instance inactive; recovery instance running container version 5 |
| Advisory-lock holders could reserve every pool connection, then wait for another connection for cache reads/writes | Cache queries reuse their advisory lock's connection via async context; nested locks reuse it too | Eight cold loads complete with a one-connection PostgreSQL pool; failure cleanup verified |

The container deployment also includes the existing 60-second Bun HTTP idle timeout. Gateway changes are deployed; no Vault files were edited.

## Final checks

- 98 tests passed, including two integration tests against isolated local PostgreSQL; both TypeScript checks passed.
- Unchanged Vault SDK: eight concurrent public Gnosis fixture balance requests, all HTTP 200 in 217–296 ms, seven balances each, no degradation or provider failures.
- Independent public fixture probes on EVM chains 1, 137, 42161, 10, 43114, 56, 8453, 100, 4663, 143, 2868, and 1101: all balance requests HTTP 200 in 4549–4879 ms; no degradation or failed chains. All history requests HTTP 200 in 682–683 ms.
- During initial verification around the container rollout, two balance probes still exceeded 45 seconds. The complete subsequent probe passed. This establishes current recovery, not a guarantee of every future provider response.
- Final Worker version: `71877299-fb5c-4e03-94f2-5e325cd2c7d8`.
- Container image digest: `sha256:d6ad471b556cf926c8a818a416b921ebaaa2e02cd251392ad4b0c2ba33bc6c3a`.

## Error review limits

Live Worker diagnostics record path, method, status, timing, request ID, and bounded error classifications. They exclude authorization, query strings, wallet payloads, and raw error messages.

Before recovery, live traffic included portfolio HTTP 500 and history HTTP 502 responses. Subsequent fixture checks pass, but those earlier responses did not carry enough logged detail to establish every individual cause.

An event-subscription HTTP 400 with `realtime_error` was observed separately. Its precise validation cause remains unconfirmed; the logger now categorizes known subscription errors without exposing request payloads. This error is not claimed fixed by the portfolio recovery.

Cloudflare historical events are sampled at 1%. The dashboard requests acceptance of observability pricing terms to restore fuller eventing; those terms were not accepted. Historical samples cannot establish an exhaustive inventory of all errors. Public fixtures do not establish the state of the user's actual wallet or every non-EVM provider.

## Browser verification

Existing Chrome profile/browser `b2-5c387a` was used through KeepKey Desktop MCP. Test tab `356992308` opened `https://docs.keepkey.com/docs/bex`; title and visible documentation were verified. Cloudflare diagnostics were inspected in tab `356992311`. The generated Cloudflare token remains local and is not included here.
