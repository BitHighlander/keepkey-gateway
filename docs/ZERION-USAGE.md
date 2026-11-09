# Zerion usage investigation and metrics

Read-only observations on 2026-11-09 UTC:

- `api.keepkey.info` served legacy Pioneer v1.4.5. `api-blue.keepkey.info`
  served gateway revision `c350d52e93a115e8aede941f0d92edf85878dd9a`.
- The Cloudflare-configured database had 72 enabled EVM registrations for
  five unique addresses on nine chains, owned by one registered client.
  Eight wallet scopes were enabled; the earliest scope update was November 5.
- At 18:34:24 the transaction cache held approximately 222,217 total stored
  versions, compared with 2,510 wallet-position and 259 DeFi-position versions.
  Transaction versions reached 222,300 at the 18:37:41 inventory. These are
  successful cache writes, not a historical billing counter; they omit errors,
  deleted entries, and any other users of the Zerion key.

The durable monitor grouped work by address **and chain** and forced history
reads every 15 seconds while watches remained enabled, including when Vault
was closed. Zerion history is already across chains per wallet. In-flight
coalescing only combined overlapping requests, so repeated chain groups could
cause more requests after the earlier request completed. The monitor now
batches all supported EVM chains for each address into one history call per
tick, preserving individual chain results and owner delivery. For the observed
inventory, that is five EVM history loads per tick instead of 45 chain groups.
Actual upstream savings depend on timing and existing in-flight coalescing.

Active socket/SSE polling still runs separately at a 15-second cadence and can
overlap durable monitoring. Explicit forced user refreshes retain their existing
freshness semantics. Watch disabling, expiry policy and cadence are unchanged.
The evidence identifies internal amplification; it does not establish key theft
or exclude traffic outside this gateway. Compare provider dashboard usage for
the same UTC window with `upstream_*` counts to investigate any difference.

## Recorded metrics

`ZerionClient.request` records exactly one attempt for each physical fetch,
including failures. Counters distinguish chains, wallet positions, DeFi
positions and transactions. Outcomes are `upstream_ok`, `upstream_http_error`,
`upstream_network_error`, and `upstream_decode_error`; status 0 means no HTTP
response. Durations include response-body decoding. Rate limits are status 429.

Memory hits, persistent hits (including a hit after a cross-container lock),
in-flight joins and stale fallbacks use separate `cache_*` outcomes and never
inflate upstream attempt counts. Chain metadata reuse is not counted as a
cache outcome. A failed upstream followed by stale fallback records both facts.

Sources are `http`, `background_monitor`, `realtime_poll`, or `unknown`.
HTTP attribution uses the authenticated database client ID. A durable batch
with one owner client records that ID; a shared batch and live polling have
an empty client ID because no single caller owns the upstream request. In-flight
shared calls attribute the physical fetch to its initiator and record joiners
as cache reuse. No wallet addresses, raw keys, full URLs, or provider error
messages are included. Request IDs are logged only when UUID-shaped.

`provider_request` structured logs are emitted immediately. Minute totals flush
to PostgreSQL `provider_usage_minute` every ten seconds and at orderly shutdown.
Cumulative snapshots use a process UUID and monotonic upserts, so retries and
multiple containers do not double-count persisted totals. Old minute buffers
are discarded after successful persistence. Retention removes up to 5,000 rows
older than 30 days each hour per process. Up to 2,000 distinct metric buckets are
buffered; `provider_metrics_overflow` and `provider_metrics_write_failed` expose
loss or persistence failures. A crash can lose unflushed totals; immediate logs
provide supporting evidence subject to Cloudflare log retention/sampling.

Migration 8 creates the metrics table when the gateway starts. This patch must
be deployed before counters appear in the hosted database; no historical
request count can be recovered from this new table. Metrics cover this gateway
only. They count requests, not plan-specific credits or dollar costs.

## Operator queries

Use database operator access; these metrics are not exposed by a public API.
All queries below are read-only and sum across instances.

```sql
-- Actual upstream attempts, errors, forced refreshes and latency over 24 hours.
SELECT operation, source, forced, status, outcome, sum(count) AS attempts,
       round(sum(duration_ms)::numeric / NULLIF(sum(count), 0), 1) AS avg_ms
FROM provider_usage_minute
WHERE bucket >= now() - interval '24 hours' AND left(outcome, 9) = 'upstream_'
GROUP BY operation, source, forced, status, outcome
ORDER BY attempts DESC;

-- Traffic over time.
SELECT date_trunc('hour', bucket) AS hour, source, sum(count) AS attempts
FROM provider_usage_minute
WHERE bucket >= now() - interval '24 hours' AND left(outcome, 9) = 'upstream_'
GROUP BY 1, source ORDER BY 1 DESC, attempts DESC;

-- Callers responsible for upstream work, separating shared/background traffic.
SELECT NULLIF(client_id, '') AS client_id, source, operation, sum(count) AS attempts
FROM provider_usage_minute
WHERE bucket >= now() - interval '24 hours' AND left(outcome, 9) = 'upstream_'
GROUP BY client_id, source, operation ORDER BY attempts DESC LIMIT 50;

-- Cache reuse is separate from physical upstream attempts.
SELECT operation, outcome, sum(count) AS occurrences
FROM provider_usage_minute
WHERE bucket >= now() - interval '24 hours' AND left(outcome, 6) = 'cache_'
GROUP BY operation, outcome ORDER BY operation, occurrences DESC;
```

After rollout, check logs for `provider_request` and metrics-write errors, run
the queries after a full minute, and compare background transaction attempts
with the unique enabled EVM address count. Five addresses at four ticks/minute
implies roughly twenty background attempts/minute before scheduler/provider
latency, failures, or watch changes. Investigate substantial excess, sustained
429s, unexpected HTTP caller concentration, or provider totals materially above
the gateway's measured attempts. Persisted metrics survive container restarts.

Validation uses fake provider responses plus a dedicated local PostgreSQL
database. No test spends Zerion credits or changes live watch registrations.
