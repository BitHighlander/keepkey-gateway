# Pioneer v5 migration plan

Status: proposed execution plan  
Companion contract: [VAULT-PIONEER-CONTRACT.md](./VAULT-PIONEER-CONTRACT.md)

## Outcome

Build the smallest Pioneer provider that the current Vault can select and use
unchanged. Remove years of operational and API surface debt while improving
wallet latency, correctness, and upstream efficiency.

Pioneer v5 has exactly three runtime building blocks:

1. one Bun application image;
2. one PostgreSQL database as the only shared durable state;
3. bounded memory inside each application process.

There is no Watchtower service, cache-worker, Redis, MongoDB, Kafka, external
queue, or separate event service. The application may call chain nodes and
third-party protocol APIs because those are its data sources, not application
infrastructure.

## Hard invariants

1. **Consumer-first scope.** An endpoint is implemented only when the current
   Vault contract or another named active consumer requires it.
2. **Zero idle upstream traffic.** When no client is connected or making a
   request, v5 makes zero chain, indexer, pricing, swapper, or discovery API
   calls. Database maintenance and platform health checks are not upstream
   provider calls, but should also be kept minimal.
3. **Demand is leased.** Work exists only while an authenticated connection or
   in-flight request expresses interest. Persistent data never implies an
   eternal poller.
4. **One watch per resource.** Identical address, xpub, transaction, swap, price,
   and chain-height interests are deduplicated across users and replicas.
5. **PostgreSQL owns correctness.** Memory may accelerate and fan out work, but
   process loss cannot lose authoritative swap state, leases, or events.
6. **Absence is not zero.** An unavailable balance or history is stale/degraded,
   never silently converted to a zero balance or empty successful history.
7. **One image, one code path.** HTTP, streaming, refresh work, and swap
   monitoring are modules in the same binary. Any replica can perform work;
   PostgreSQL leasing prevents duplicates.
8. **No permanent indexer.** v5 is a wallet gateway and request coalescer, not a
   second blockchain database.

## Target architecture

```text
Vault
  │ HTTP / SSE / Socket.IO
  ▼
Cloudflare Worker router
  │ stable stream routing; distributed HTTP routing
  ▼
Bun container replicas
  ├─ OpenAPI-compatible HTTP handlers
  ├─ connection + interest registry
  ├─ bounded L1 cache and singleflight map
  ├─ embedded lease/job runner
  └─ SSE and Socket.IO adapters
       │
       ├──────── direct, demand-driven calls ───────► chain/protocol APIs
       │
       ▼
PostgreSQL
  ├─ clients and expiring interest leases
  ├─ typed pending-swap state
  ├─ read-through cache records
  ├─ leased jobs
  └─ durable event outbox
```

The Worker/Container platform is transport and lifecycle infrastructure, not a
second state store. Container filesystems are ephemeral.

The current Worker routes every request to the fixed container ID
`pioneer-main`. That intentionally creates one active instance; setting
`max_instances: 3` does not distribute requests by itself. Before load testing,
HTTP routing must select from a fixed replica set and streaming connections
must use stable routing. Cloudflare's current Containers API supports manual
routing and fixed-size random instance selection; automatic scaling is not yet
the basis of this plan:

- <https://developers.cloudflare.com/containers/platform-details/scaling-and-routing/>
- <https://developers.cloudflare.com/containers/get-started/>

Keep PostgreSQL access inside the Bun app simple: direct TLS plus a small,
bounded local connection pool. Hyperdrive is documented as a Workers binding,
so using it from a Container is not assumed:

- <https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/>

## Demand-driven execution model

### What counts as active demand

An interest can be created by:

- a live authenticated SSE or Socket.IO session;
- an in-flight HTTP request.

Every interest has a normalized resource key and a hard expiry. Examples:

```text
balance:eip155:1:0xabc...
utxo:bip122:000000000019d6689c085ae165831e93:xpub...
tx:eip155:8453:0xdef...
swap:relay:request-id
price:eip155:1/erc20:0x...
```

CAIP identifiers and addresses must be normalized with chain-appropriate case
rules before forming a key.

### Start, share, stop

1. A client connects and declares its addresses/events.
2. The serving replica records local subscribers and upserts expiring interest
   leases in PostgreSQL.
3. One replica claims each due watch using an atomic PostgreSQL lease.
4. Its result is written once, published to local subscribers immediately, and
   appended to the event outbox for subscribers on other replicas.
5. Other callers with the same key reuse the result; they do not call upstream.
6. Sessions renew their interests while alive.
7. A normal disconnect withdraws its interests immediately. When the last
   interest disappears, no new job is scheduled for that key. An unclean
   disconnect is bounded by the short lease TTL.

Pending swaps are durable records, but not permission to poll forever. With no
active interest they are dormant. On reconnect or `GetPendingSwap`, v5 catches
up from the last known state, then resumes watching until disconnect or a
terminal state.

### Minimize calls while watching

Each resource adapter owns an explicit refresh policy:

- **Singleflight:** concurrent cache misses for one key share one promise in a
  process and one leased job across processes.
- **Freshness windows:** serve a fresh cached result immediately. Never poll
  merely because a timer exists.
- **Block-aware refresh:** when practical, many watched resources share one
  chain-head observation; balances/history refresh only after a relevant new
  block or event.
- **Adaptive cadence:** new pending transactions receive a short cadence, then
  exponential backoff; terminal swaps and transactions stop permanently.
- **Negative caching:** deterministic not-found/unsupported results receive a
  short TTL so repeated UI renders do not hammer upstream.
- **Batching:** use upstream batch endpoints when they preserve correctness;
  group address and asset requests by chain/provider.
- **Jitter:** spread refresh deadlines to avoid reconnect and block-boundary
  bursts.
- **Stale-while-revalidate:** return marked stale data when allowed, with one
  background refresh for all waiters.
- **Circuit breaking:** after upstream failures, increase backoff and return an
  honest degraded response instead of retry storms.
- **Connection sharing:** an upstream WebSocket, when genuinely cheaper and
  supported, is shared per chain/provider and exists only while at least one
  matching interest exists.

Every adapter must declare `fresh_for`, `stale_for`, minimum/maximum watch
cadence, batch limit, retry policy, and terminal conditions. These are measured
and tuned; there is no global magic polling interval.

The embedded runner is activity-driven. An HTTP request or local stream wakes
the relevant work directly; it does not scan PostgreSQL on a permanent timer.
Cross-replica outbox reads run only while that replica has local subscribers.
When it has no local demand, the process performs no job/outbox polling beyond
platform and database lifecycle necessities.

### Proving the idle invariant

Expose counters by adapter and reason:

```text
pioneer_upstream_requests_total{adapter,operation,reason}
pioneer_active_interests{kind}
pioneer_claimed_watches{kind}
pioneer_cache_result_total{kind,result}
pioneer_upstream_batch_size{adapter}
```

An automated soak gate must:

1. start v5 and wait for readiness;
2. make no client request or connection;
3. observe for longer than the longest configured refresh window;
4. assert the upstream request counter remains exactly zero;
5. connect two Vault sessions watching the same resource and assert they share
   one upstream watch;
6. disconnect both, wait through the lease expiry, and assert the counter
   stops increasing.

This test is required in CI and before production promotion.

## PostgreSQL model

Start with a small typed core. Add a table only when a contract slice requires
durability or indexed querying.

### `api_clients`

Stores a hashed query key, status, creation/last-seen timestamps, and optional
metadata required for registration. Never store a raw secret when a hash can
authenticate it.

### `interest_leases`

One row per `(resource_kind, resource_key, client_id)` with `expires_at` and
connection identity. Expiry makes crashes self-cleaning. An index on
`(resource_kind, resource_key, expires_at)` answers whether any demand remains.

For write reduction, a replica may aggregate its local connections into one
lease per resource and renew at a coarse cadence. The expiration must remain
short enough to meet the idle-stop requirement.

### `cache_items`

One read-through record per normalized resource:

```text
namespace, key, payload_json, fetched_at, fresh_until, stale_until,
source, last_error, error_at, version
```

This replaces Redis/Mongo response caching without pretending cached JSON is a
domain model. Cache entries are replaceable and TTL-pruned. Large/history data
gets a typed table only if measurement shows JSON records are insufficient.

### `pending_swaps`

Typed identity, integration/provider identifiers, sell/buy CAIPs, current
status, confirmation and outbound fields, provider state JSON, error state,
next eligible check, terminal timestamp, and optimistic version. Registration
is idempotent. The invocation/debit/credit identity relationships from the old
system must be captured in fixtures before migration.

### `jobs`

A compact durable execution table:

```text
id, kind, resource_key, payload_json, priority, state, run_at,
lease_owner, lease_until, attempts, last_error, created_at, updated_at
```

Claim due work atomically with `FOR UPDATE SKIP LOCKED` or an equivalent single
statement. A unique active key prevents duplicate jobs. Before an upstream
call, the worker rechecks that active demand still exists. Jobs are a module in
the main process, not a cache-worker service.

### `event_outbox`

An ordered ID, client/bucket routing key, event type, payload, creation time,
and expiry. It bridges events between replicas and permits reconnect catch-up.
Local in-memory fanout is the fast path; the outbox is the durable cross-replica
path. Consumers advance cursors, and old rows are TTL-pruned.

Correctness must not depend on PostgreSQL `LISTEN/NOTIFY`; it may later be used
only as a wake-up optimization. Durable rows and cursors remain authoritative.

## In-process memory policy

Memory is deliberately useful but disposable:

- size-bounded LRU/TTL cache for hot response records;
- singleflight map keyed by normalized resource;
- local connection/subscriber registry;
- local event fanout;
- short-lived provider connection pools and rate-limit state.

Every collection needs an entry/byte bound and expiry. No unbounded address,
event, transaction, quote, or telemetry map is allowed. Restarting any replica
may cause a bounded catch-up but cannot change the durable result.

## Capability slices and exit gates

Each slice includes handlers, OpenAPI entries, database migration if needed,
sanitized baseline fixtures, contract tests, observability, and an unmodified
Vault walkthrough.

### 0. Freeze the real contract

- Land the consumer contract.
- Capture green and blue fixtures for P0 operations and direct routes.
- Record baseline latency, error rate, cache behavior, and upstream request
  counts from representative wallet sessions.
- Classify every old route as `required`, `named-other-consumer`, or `delete`.

Exit: the team can explain every endpoint entering v5 and identify its caller.

### 1. Runtime and PostgreSQL foundation

- Bun service structure, configuration validation, migrations, structured logs,
  request IDs, metrics, graceful shutdown, and readiness.
- Direct PostgreSQL pool with strict maximum connections per replica.
- Implement `HEAD /`, health, OpenAPI bootstrap, query-key registration/auth,
  cache records, leases, jobs, and event outbox primitives.
- Add the zero-idle-traffic soak test before any provider adapter.

Exit: multiple replicas can race safely, recover expired work, and go completely
idle after clients disconnect.

### 2. Wallet read path

- Discovery/search, market info, chain/account primitives, and portfolio.
- UTXO discovery, unspent, lookup, and fees.
- EVM balance/token/nonce/gas and Cosmos/XRP account state.
- Transaction history with explicit loading/stale/degraded semantics.
- Shared per-chain request batching and adaptive cache policies.

Exit: an unmodified Vault can load representative empty, funded, token-heavy,
UTXO, and degraded wallets without false zeros.

### 3. Transaction path

- Solana builders and all required broadcast behavior.
- Verify UTXO script type/path behavior and fee units using golden fixtures.
- Fail-fast validation and error passthrough; never synthesize transaction data.

Exit: Vault can build/sign against v5 and safely broadcast on designated test
networks; production broadcast is manually gated until audited.

### 4. Swap path

- Asset availability, health, quotes, and signing payload compatibility.
- Pending swap registration/state in PostgreSQL.
- Embedded, demand-leased monitor adapters for each enabled integration.
- Terminal detection, backoff, and catch-up-on-reconnect.

Exit: golden quotes match per integration and pending swaps survive container
restart without polling while nobody is connected.

### 5. Realtime compatibility

- One internal event model and watcher registry.
- SSE first, then Socket.IO v4 as a compatibility adapter.
- Stable stream routing and cross-replica outbox delivery.
- Prove two transports do not double upstream watches.

Exit: incoming/confirmed transaction events reach Vault once, reconnects catch
up, and all upstream calls stop after the final disconnect.

### 6. Secondary Vault features

- Staking, Cosmos names, Zerion-backed DeFi display, Hive, and best-effort
  telemetry.
- Update Vault's supplementary DeFi fetch from the legacy Zapper path to the
  provider-neutral Zerion path. Do not add a Zapper compatibility route.
- Each feature remains independently removable and cannot affect wallet-core
  readiness.

Exit: the remaining P2 contract passes or the UI capability is explicitly
disabled by product decision.

### 7. Shadow, alpha, and cutover

- Add v5 as a custom provider in an unmodified Vault; keep green selected by
  default.
- Replay read-only traffic/fixtures and compare normalized results.
- Run the existing Pioneer smoke suite, but use the Vault contract suite as the
  release gate because the legacy suite covers routes outside this scope.
- Canary internal users, then a small provider cohort. Provider selection is
  the rollback switch.
- Migrate only live data needed by implemented contract slices—principally
  client registration and active pending swaps. Cached data can warm on demand.

Exit: correctness and measured performance gates hold under representative
load, rollback is rehearsed, and green remains available through the soak
window.

### 8. Retire legacy pieces

Only after the soak window:

- remove traffic from old Pioneer;
- archive contract fixtures and any required audit data;
- remove Watchtower, cache-worker, Redis, and Mongo deployments/configuration;
- delete old routes rather than porting them “just in case.”

Infrastructure deletion is a separate, explicitly approved operation after
rollback is no longer required.

## Performance and correctness gates

Do not invent latency targets before measuring the current service and network
placement. Establish baselines, then set budgets for:

- p50/p95/p99 handler latency for cache hit, coalesced miss, and cold miss;
- upstream calls per connected wallet-hour and per unique watched resource;
- exact zero calls per disconnected soak window;
- cache hit/coalescing ratio;
- PostgreSQL queries and connections per request;
- reconnect catch-up time;
- event delivery delay and duplicate rate;
- stale/degraded response rate;
- quote and pending-swap normalized parity.

The most important load test is a realistic wallet distribution, not repeated
requests for one address. It must include many wallets sharing popular assets
and chains, reconnect storms, slow providers, database failover, and container
restart.

Cloudflare notes typical container cold starts of roughly 1–3 seconds and fixed
placement until restart. Measure from actual wallet geographies against the
chosen PostgreSQL region before declaring the platform performant:

- <https://developers.cloudflare.com/containers/platform-details/architecture/>

## Migration and rollback rules

- Do not dual-write the entire legacy model. Import only data the Vault contract
  needs.
- Read-only slices can shadow without user-visible risk.
- Broadcast must never be mirrored to two providers.
- Quote comparisons do not execute the quote.
- Active pending swaps require a one-time, idempotent import and normalized
  comparison before their provider is switched.
- A Vault/provider URL switch returns users to green. Keep schema migrations
  backward-compatible throughout canary so rollback does not require a database
  restore.
- No legacy stateful component is deleted during alpha or canary.

## Decisions required before production implementation

These choices do not block contract/foundation work, but must be measured and
recorded before production traffic:

1. PostgreSQL production sizing, backup/PITR policy, and connection ceiling.
   Alpha now uses PlanetScale in AWS us-east; see [deployment](./PLANETSCALE.md).
2. Container replica count and routing strategy for HTTP versus long-lived
   streams.
3. Failure-detection and lease duration that bound work after an unclean
   disconnect while preserving reconnect correctness.
4. Retention for client registration, pending swaps, cache records, events, and
   telemetry.
5. Which swap integrations and P2 features enter the first public cutover.

## First implementation milestone

The first vertical milestone should be deliberately small:

1. health and OpenAPI bootstrap;
2. query-key registration/authentication;
3. PostgreSQL migrations for clients, interests, cache, jobs, and events;
4. one cheap read adapter, instrumented end to end;
5. SSE connection declaring that resource as an interest;
6. deduplication across two clients;
7. stop-on-last-disconnect and zero-idle soak proof.

This validates the new system's defining architecture before portfolio, swaps,
or the long tail can obscure it.
