# Zerion usage policy and investigation

Zerion reads are on demand: wallet opening and explicit portfolio/history refresh
requests may fetch positions, DeFi data and history. SSE/socket subscriptions and
durable payment watches must not repeatedly fetch Zerion history. EVM push hints
and stored event replay remain available, but the gateway does not discover new
EVM payments by polling Zerion. A push-based EVM notification source is separate
work. UTXO monitoring continues through its existing providers.

The prior implementation forced wallet-wide history reads every 15 seconds for
active realtime subscribers and saved watches, including when Vault was closed.
An earlier batching patch reduced duplicate reads across chain groups but did
not remove recurring requests. Both monitoring paths now exclude EVM history;
the Zerion transport also refuses `background_monitor` and `realtime_poll`
contexts before fetching. EVM-only durable ticks report zero polling watches,
allowing the scheduler to disarm without deleting registrations or replay data.
Registration responses report `backgroundMonitoring: false` for EVM-only watches
and identify their `onDemandNetworks`.

Inventory on November 9 showed 72 EVM registrations, five distinct addresses,
and one client. Around 222,000 stored transaction-cache versions were present.
Cache versions are evidence of repeated work, not exact historical billing.
The provider dashboard spike has not been fully reconciled to historical calls.
Credential rotation was separately completed on November 10; the old key was
verified unauthorized and the replacement accepted. No credentials are stored here.

## Metrics

Each physical Zerion fetch records operation, source, authenticated client ID
when attributable, forced-refresh flag, HTTP status, duration, and outcome.
`upstream_ok`, `upstream_http_error`, `upstream_network_error`, and
`upstream_decode_error` count physical attempts. `cache_*` reuse and
`policy_blocked` refusals do not count as upstream calls. Logs exclude raw keys,
wallet addresses, provider URLs and response bodies.

Minute totals flush to PostgreSQL `provider_usage_minute` every ten seconds and
on orderly shutdown. Cumulative upserts keyed by process UUID avoid double
counting on retries. Retention is 30 days. A crash can lose unflushed totals;
database failures/overflow emit diagnostic logs. The gateway does not yet have
automatic budget alerts, collector heartbeat alerts or per-key billing totals.
Counters measure requests, not plan-specific credits or costs. Operator probes
outside the gateway are not included and must be accounted for separately.

```sql
SELECT date_trunc('hour', bucket) AS hour, source, operation, status, outcome,
       sum(count) AS attempts
FROM provider_usage_minute
WHERE bucket >= now() - interval '24 hours'
  AND left(outcome, 9) = 'upstream_'
GROUP BY 1, source, operation, status, outcome
ORDER BY 1 DESC, attempts DESC;

-- Must remain empty after the no-polling deployment.
SELECT source, operation, sum(count) AS attempts
FROM provider_usage_minute
WHERE bucket >= :deployment_time
  AND source IN ('background_monitor', 'realtime_poll')
  AND left(outcome, 9) = 'upstream_'
GROUP BY source, operation;

-- A refusal exposes attempted policy regressions without spending a provider call.
SELECT source, operation, sum(count) AS blocked
FROM provider_usage_minute
WHERE bucket >= now() - interval '24 hours' AND outcome = 'policy_blocked'
GROUP BY source, operation;
```

Compare the same UTC window and key in Zerion's dashboard with these counters.
Wallet-open requests can use multiple provider endpoints; one opening does not
necessarily equal one billable request. HTTP clients can still send repeated
requests, so request attribution and a separate usage-budget policy remain relevant.
