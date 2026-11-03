# Payment monitoring

The gateway supports active connection watches and explicit durable registrations.
Authentication by itself never creates a durable watch. Standard-wallet clients
register background watches explicitly; hidden wallets use ephemeral streams only.

## Active delivery

Authenticated SSE (`POST /api/v1/events/subscribe`) and Socket.IO `subscribe` use
one connection-scoped watch hub. Each subscription contains at most 200 account
keys or addresses. EVM addresses compare without case; base58 public keys and
addresses retain case. Socket disconnect/unsubscribe removes its active lease.

UTXO account keys expand through Blockbook into derived leaf addresses. While a
consumer is connected, the gateway opens one lazy NOWNodes Blockbook websocket
per watched UTXO network and subscribes to addresses and new blocks. Notifications
map back to the original watched account key. Expansion is bounded to 500 leaves
per network; unresolved or excess accounts retain polling fallback. Websocket
connection or acknowledgement failure enables the same fallback. There are no
upstream websockets without active leases.

Other networks and failed UTXO streams use active history polling at a 15-second
cadence, plus provider request time. Healthy UTXO websocket watches skip periodic
history reads except reconciliation and confirmation checks. Explicit fresh reads
bypass gateway wallet/history caches and stale fallback; provider indexing can
still lag the chain.

Every connection receives `sync:required` on subscription and another coalesced
hint after its first successful history baseline. Upstream registration/reconnect
also requests reconciliation. This covers payments arriving between an earlier
balance read and watch establishment. A `since` epoch cursor requests bounded
first-snapshot catch-up, at most 24 hours. Notifications contain the original
`watchAddress`, network, stable event ID and `refreshHint: true`; they do not assert
unverified payment amounts, native assets or token credits.

Legacy auth/join clients can acquire active watches from their recent authenticated
portfolio requests. Portfolio chunks merge into a bounded, ten-minute in-memory
inventory. Explicit wallet leases supersede that inventory and block late merges;
last explicit lease closure clears the implicit inventory. The active lease itself
does not expire at ten minutes. `join` validates the supplied query key and any
username and retains the JSON-string `subscribedToUsername` acknowledgement.
Legacy `transaction:incoming` hints are emitted only to connections owning the
matching watch. This compatibility inventory is never persisted as permission for
background monitoring.

## Monitoring with Vault closed

`POST /api/v1/events/watches` registers a standard-wallet scope and an explicit
watch list. Registrations and ordering revisions live in PostgreSQL. Closing SSE,
WebSocket or Vault does not remove durable watches. Posting `enabled: false`
removes that scope's registrations and queued events. Generic balance queries,
authentication and hidden-wallet streams cannot create durable registrations.
Conflicting stale revisions return HTTP 409; retries requesting the same enabled
state and watch set are idempotent, including after a scheduler-arm failure.

A separate Cloudflare Durable Object alarm wakes the container after registration
and runs a monitoring tick every 15 seconds while registrations remain. The tick
endpoint is blocked publicly at the Worker and also authenticates a scheduler
secret inside the container. It uses fresh provider histories, deduplicates watches
and queues stable pending/confirmed transition IDs with client and wallet scope.
Disabled clients and removed watches cannot receive newly queued events. No alarm
or scanner continues after the last durable registration is removed.

Events are retained for seven days, including acknowledged IDs needed to suppress
requeueing. `/events/replay` requires the authenticated client's wallet scope and
returns unacknowledged records with an opaque PostgreSQL cursor. `/events/ack`
acknowledges only that client's scope. Clients acknowledge after successful scoped
balance/history reconciliation, then persist that delivery cursor. This cursor is
separate from the epoch-millisecond SSE catch-up cursor.

An exact event-ID acknowledgement is retained for seven days even when the live
stream delivered that event before the background monitor stored it. Later
insertion preserves the acknowledgement and does not publish or replay that event
again. Receipts are isolated by client and wallet scope and require an enabled
registration; explicit disable removes them, and a late acknowledgement cannot
restore a disabled scope. Cursor-only acknowledgement affects existing queue rows
and does not acknowledge events allocated in the future. Delivery remains subject
to retries; clients reconcile authoritative state before acknowledging.

The seven days describe queue retention, not unlimited historical reconstruction.
The scanner currently observes the latest provider history page (normally 50
transactions), with at most 200 normalized rows per watch per tick. Tick diagnostics
report potentially truncated pages and missing confirmed timestamps. High-volume
wallets or prolonged provider downtime can exceed that coverage; payment amounts
remain authoritative only after wallet balance/history reconciliation. Pending
transactions without a block timestamp are treated as newly observed hints, never
as a proved credit.
