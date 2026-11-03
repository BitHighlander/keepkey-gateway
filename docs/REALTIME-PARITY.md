# Incoming payments and realtime parity scope

Status: audited 2026-11-03; proposed work below is not implemented by the LTC
balance correction. A manual balance refresh must return the correct funded
balance independently of notifications. Fix and verify that path first.

## Verified production behavior

The public-fixture probe completed at `2026-11-03T20:58:24.499Z` against
`oracles.cc`, revision `102fe9588ee8e31a47cc9618ba4a60721347055a`:

| Check | Result |
| --- | --- |
| `wss://oracles.cc/socket.io/?EIO=4&transport=websocket` | Engine.IO open, Socket.IO connect, authenticated successfully |
| `POST /api/v1/events/subscribe`, registered key, public LTC address | HTTP 200, `text/event-stream`, `connected`, `watching: 1` |
| Same SSE request without authentication | HTTP 401 |
| Socket.IO `transport=polling` | HTTP 404; websocket transport must be selected explicitly |

The probe registered an isolated API client, read no wallet credentials, and
closed the fixture subscription immediately. It proves transport,
authentication, and watch acceptance; it does not prove receipt of a newly
funded transaction. Its sanitized report is
`/private/tmp/gateway-realtime-readonly-probe.json` on the audit machine.

Implementation references: [Socket.IO handler](../container/server.ts),
[SSE endpoint](../container/src/http.ts), [shared event hub](../container/src/realtime.ts),
[history normalization](../container/src/history.ts), and
[Vault compatibility contract](./VAULT-PIONEER-CONTRACT.md#realtime-contract).

## Current limits

Only the SSE endpoint creates address watches. WebSocket `authenticate` adds a
sender but does not subscribe addresses. Socket events depend on an active SSE
subscription belonging to the same registered client. The hub polls history;
it does not maintain upstream Blockbook subscriptions or a durable Watchtower.

An active watch polls immediately, establishes a baseline without replaying
existing transactions, then waits 30 seconds. Quiet polls back off to 60, 120,
and 300 seconds. LTC history comes from NowNodes Blockbook with a short demand
cache and a first-page transaction limit. Closing the final SSE subscription
stops polling and clears snapshots. Reconnects and container restarts have no
replay cursor, and subscriptions do not survive them.

SSE emits `tx:incoming` and `tx:confirmed`. Socket.IO mirrors both as
`transaction:incoming`; confirmations use `type: "confirmation_update"` and a
synthetic count of one. New outgoing activity can also appear with
`type: "outgoing"`. There are no balance-change events or portfolio-cache
invalidations in this hub.

Payloads are insufficient as payment receipts: UTXO `value` can represent all
transaction outputs rather than the watched wallet's credited outputs; EVM
token history loses its token identity and the hub labels events with the
network's native CAIP. Reorgs, replacements, failed transactions, real
confirmation counts, and partial history failures need explicit handling.
Until corrected, notifications should trigger a scoped authoritative refresh.

## Prioritized implementation

1. **Correct balances and manual refresh.** Verify transparent LTC balance,
   unconfirmed balance, UTXOs, history, and account totals for each supported
   derivation/script family. Refresh must bypass stale balance data on request
   and must surface provider failures rather than turn them into zero.
2. **Reliable notifications while Vault is open.** Give SSE and WebSocket
   explicit subscribe/unsubscribe operations backed by one shared watch set.
   Watch the selected receive address and account, with a short receive-screen
   interval and a bounded lease. Support reconnect catch-up and idempotent
   events. A notification should invalidate and refresh only the affected
   account's balances, UTXOs, history, and totals, with a small debounce. Reset
   account/provider/device subscriptions when the wallet context changes.
3. **Correct payment event data.** Preserve network, exact asset CAIP, integer
   base units, decimals, credited output/account, direction, txid/output index,
   status, actual confirmations, observed time, and a stable event identifier.
   Handle unconfirmed, confirmed, failed/replaced/dropped, and reorg transitions.
   Expose watch freshness/failure so a connected socket does not imply a
   working chain indexer. Avoid duplicate events across SSE and sockets.
4. **Durable Watchtower capability, separately scoped.** Add opt-in persistent
   watch registrations, ownership/authentication rules, cursor-based replay,
   delivery acknowledgements/retries, restart recovery, retention limits,
   rate/cost budgets, and observability. Decide separately whether monitoring
   and notifications should continue while Vault is closed. Keep ordinary
   wallet subscriptions demand-driven; no permanent watchers are implied by
   connecting a wallet.

## Acceptance checks

Use deterministic transaction/history fixtures first. Any new funded test is
an explicit operator action; audit scripts must not sign or broadcast.

| Scenario | Required result |
| --- | --- |
| Incoming transparent LTC across all three wallet script families | Test legacy P2PKH (`L…`), P2SH wrapped SegWit (`M…`, legacy `3…` where supported), and native SegWit (`ltc1…`). Correct account, receive/change paths, pending amount, confirmed amount, UTXOs, history, and portfolio totals agree with the chain. |
| Receive screen already open when funding arrives | One incoming notification; the affected account refreshes automatically within the agreed receive-screen latency budget. Other accounts do not refetch unnecessarily. |
| Funding arrives just before subscribe, during reconnect, or during a container restart | Catch-up finds it once; the baseline does not silently swallow a new payment. Existing history does not replay as a burst of new payments. |
| Unconfirmed to confirmed | Pending funds appear with an unconfirmed state; confirmation updates spendable/confirmed balances and displays actual confirmation counts without a second incoming toast. |
| Reorg, replacement, dropped transaction, or temporary indexer failure | Reverse/update the previous state, do not double-credit, and retain a visible last-good/degraded state rather than presenting failure as an empty wallet. |
| Units and ownership | Example `0.02540134 LTC` remains exactly `2540134` base units at 8 decimals. Count only owned credited outputs; exclude another recipient's outputs and do not mislabel change or fees as income. Token events preserve their contract/mint and decimals. |
| Multiple transports/accounts | Two SSE sessions plus a socket share upstream work and yield one user notification. A socket-only subscription works after phase 2. One client's watches/events never leak to another. |
| Watch lifecycle | Closing Receive or changing account/provider/device removes the correct lease. The last disconnect stops upstream work; restart and reconnect behavior is documented and tested. |

Release evidence must distinguish successful transport/authentication,
deterministic event-transition tests, a verified manual refresh, and an actual
incoming-payment observation. A green socket connection alone satisfies none
of the funded-balance or receipt-delivery checks.
