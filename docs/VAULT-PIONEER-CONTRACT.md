# Vault → Pioneer v5 compatibility contract

Status: initial consumer-derived contract  
Consumer inspected: `keepkey-vault-v11/projects/keepkey-vault`  
Provider baseline: `https://api.keepkey.info` on 2026-08-23

## Purpose

Pioneer v5 is not a rewrite of every route ever exposed by Pioneer. Its first
contract is the behavior the current Vault actually consumes. A user must be
able to add the v5 URL as a custom Pioneer provider, select it, and use Vault
without a compatibility mode or a v5-specific Vault build.

The contract is defined by:

1. the OpenAPI document and its `operationId` values;
2. a small set of directly fetched HTTP and streaming routes;
3. authentication and error behavior;
4. the response fields Vault reads, including freshness and degraded-state
   semantics.

Anything not listed here is outside the first migration unless a second active
consumer is identified.

## Bootstrap and authentication

Vault resolves the provider URL in this order: saved database setting,
`PIONEER_API_BASE`, then `https://api.keepkey.info`.

The provider must support:

| Contract | Requirement |
| --- | --- |
| `HEAD /` | Reachability probe. Any successful HTTP response is sufficient. |
| `GET /api/v1/health` | Provider selection health check. Return JSON and a 2xx status when ready to serve. |
| `GET /spec/swagger.json` | OpenAPI document used to construct the client at runtime. |
| `Authorization: <queryKey>` | Accepted on SDK-generated requests. |
| `POST /api/v1/user/register` | Body `{ "username": string, "queryKey": string }`. Registration is best-effort, but is needed for authenticated realtime delivery. It must be idempotent. |

The OpenAPI host/base URL must resolve back to the selected provider. Vault
also supplies an override host for custom providers, but the document should be
correct independently.

## SDK-generated operations

`@pioneer-platform/pioneer-client` walks the OpenAPI document and creates a
method named after each `operationId`. For body methods Vault passes one object;
for GET methods it passes path/query parameters. It expects the SDK wrapper
`{ data: responseBody }`.

These are the operations found in the Vault backend and their currently
deployed route mappings:

| Priority | `operationId` | Method and path | Capability |
| --- | --- | --- | --- |
| P0 | `GetPortfolioBalances` | `POST /portfolio` | Wallet balances and DeFi positions |
| P0 | `GetMarketInfo` | `POST /market/info` | Prices used to value the portfolio |
| P0 | `GetPubkeyInfo` | `GET /utxo/pubkey-info/{network}/{xpub}` | UTXO address discovery and derivation paths |
| P0 | `ListUnspent` | `GET /utxo/unspent/{network}/{xpub}` | Spendable UTXOs |
| P0 | `GetFeeRate` | `GET /utxo/fee-rate/{networkId}` | UTXO fee estimate |
| P0 | `LookupUtxoTx` | `GET /utxo/lookup/{networkId}/{txid}` | Previous transaction hex/details |
| P0 | `Broadcast` | `POST /broadcast` | Signed transaction broadcast |
| P0 | `GetBalanceAddressByNetwork` | `GET /evm/balance/{networkId}/{address}` | Native EVM balance |
| P0 | `GetTokenBalance` | `GET /evm/token/balance/{networkId}/{address}/{contractAddress}` | ERC-20 balance |
| P0 | `GetTokenDecimals` | `GET /evm/token/decimals/{networkId}/{contractAddress}` | ERC-20 metadata |
| P0 | `GetNonceByNetwork` | `GET /evm/nonce/{networkId}/{address}` | EVM nonce |
| P0 | `GetGasPriceByNetwork` | `GET /evm/gas-price/{networkId}` | EVM gas price |
| P0 | `LookupTx` | `GET /evm/lookup/{networkId}/{txid}` | EVM receipt (`data.receipt`, `null` until mined) |
| P0 | `EvmReadRpc` | `POST /evm/rpc` | Read-only `eth_call`/`eth_getCode`/`eth_blockNumber`/`eth_simulateV1`, raw result in `data` |
| P0 | `LookupTokenMetadata` | `POST /evm/token/lookup` | ERC-20 `data.{symbol,name,decimals}`; 422 when not a token |
| P0 | `GetTokenAllowance` | `GET /evm/token/allowance/{networkId}/{contractAddress}/{ownerAddress}/{spenderAddress}` | ERC-20 `data.allowance` in base units |
| P0 | `GetAccountInfo` | `GET /getAccountInfo/{network}/{address}` | Cosmos/XRP signing state |
| P0 | `GetTransactionHistory` | `POST /tx/history` | Activity and report history |
| P0 | `BuildSolanaTransfer` | `POST /solana/build-transfer` | Native SOL transaction construction |
| P0 | `BuildSolanaTransferToken` | `POST /solana/build-transfer-token` | SPL transaction construction |
| P1 | `Quote` | `POST /quote` | Swap quotes and signing payloads |
| P1 | `GetAvailableAssets` | `GET /swap/available-assets` | Swappable asset catalog |
| P1 | `CreatePendingSwap` | `POST /swaps/pending` | Idempotent swap tracking registration |
| P1 | `GetPendingSwap` | `GET /swaps/pending/{txHash}` | Current swap state |
| P2 | `GetStakingPositions` | `POST /staking/positions` | Staking balances |
| P2 | `SearchAssets` | `GET /discovery/search` | Asset search |
| P2 | `GetName` | `POST /names/lookup` | Cosmos name lookup |
| P2 | `GetNameRegistrationQuote` | `POST /names/registration-quote` | Cosmos name pricing |

P0 is required for ordinary wallet read/send behavior. P1 is required for
swaps. P2 is visible functionality but can follow the first wallet alpha.

### Implementation progress

The first live vertical slice now implements `GetMarketInfo` and all five EVM
read operations. Their raw HTTP contract, every configured EVM network, cache
reuse, and the generated methods from Vault's installed Pioneer client have
been exercised locally. Portfolio, UTXO, account-state, history, Solana build,
and broadcast operations remain before recording a complete Vault session.

### Known operation-name drift

- Vault contains a fallback call to `GetFeeRateByNetwork`; the deployed OpenAPI
  document exposes only `GetFeeRate`. v5 should expose `GetFeeRate` and Vault's
  existing fallback remains harmless.
- One Vault BTC helper calls `UtxoLookup`, while the deployed document exposes
  `LookupUtxoTx`. To work with the current Vault unchanged, v5 should expose a
  second alias operation (on an alias path if OpenAPI uniqueness requires it)
  with `operationId: UtxoLookup`, backed by the same handler.

## Direct routes outside the generated SDK

These routes are fetched directly and therefore do not appear in a scan of SDK
method calls:

| Priority | Method and path | Requirement |
| --- | --- | --- |
| P0 | `GET /api/v1/swappers/supported-chains` | Object mapping swapper names to chain identifiers. Vault reads `thorchain`, `mayachain`, `relay`, `zeroex`, `chainflip`, and `shapeshift`. |
| P1 | `GET /api/v1/swap/health` | Integration/provider health displayed by the swap UI. |
| P1 | `POST /api/v1/events/subscribe` | Authenticated SSE subscription described below. |
| P1 | `/socket.io/?EIO=4&transport=websocket` | Socket.IO v4 compatibility described below. |
| P2 | `POST /api/v1/telemetry/vault` | Best-effort telemetry; failure must not affect wallet actions. |
| P2 | `GET /api/v1/zerion/positions/{address}` | Optional provider-neutral DeFi positions sourced from Zerion. Requires a registered Pioneer query key. |
| P2 | `GET /api/v1/hive/account/{pubkey}` | Hive feature support. |
| P2 | `GET /api/v1/hive/username-available/{name}` | Hive feature support. |
| P2 | `POST /api/v1/hive/create-account` | Hive feature support. |
| P2 | `GET /api/v1/hive/tx-params` | Hive feature support. |
| P2 | `POST /api/v1/hive/broadcast` | Hive feature support. |

Hive routes are firmware-gated but are real consumer behavior. They should be a
separate implementation slice, not accidentally pulled into the wallet core.

### Deliberate DeFi contract change

The current Vault still contains a direct legacy fetch to
`/api/v1/zapper/portfolio/{address}`. v5 does not expose that route or preserve
its response types. The clean migration is to update Vault's supplementary
DeFi client to call `/api/v1/zerion/positions/{address}` and consume the already
normalized `positions` array, or rely entirely on `defiPositions` embedded in
`GetPortfolioBalances`. DeFi already degrades to an empty section, so this does
not block the wallet-core provider alpha.

## Realtime contract

### Server-sent events

Vault sends:

```json
{
  "addresses": [{ "address": "...", "networkId": "..." }],
  "events": ["tx:incoming", "tx:confirmed"]
}
```

It sets `Accept: text/event-stream` and sends the query key in `x-api-key`.
The stream must use standard SSE framing and may emit:

- `connected`: `{ sessionId, watching }`
- `tx:incoming`: `{ address, networkId, caip, txid, value, from?, type }`
- `tx:confirmed`: `{ address, networkId, txid, confirmations }`

### Socket.IO

Vault connects with the Socket.IO v4 protocol, emits `authenticate` with
`{ queryKey }`, and expects `authenticated`. It currently consumes
`transaction:incoming`. Balance events must not be required for portfolio
correctness; Vault intentionally ignores them to avoid refresh loops.

SSE and Socket.IO are compatibility transports over one internal event stream.
They must not run two independent upstream watchers.

## Data contracts actually consumed

The schemas below deliberately describe fields Vault reads rather than all
legacy response fields.

### Portfolio

Request:

```json
{
  "pubkeys": [{ "caip": "...", "pubkey": "..." }],
  "includeDefi": true,
  "extraContracts": [
    {
      "networkId": "...",
      "contractAddress": "...",
      "decimals": 18,
      "symbol": "...",
      "name": "...",
      "icon": "..."
    }
  ]
}
```

`extraContracts` is optional. The request can include the query parameter
`forceRefresh`.

Canonical response:

```json
{
  "balances": [],
  "meta": {
    "degraded": false,
    "degradedCount": 0,
    "failures": [],
    "staleChains": []
  },
  "defiPositions": []
}
```

Balance fields used are `caip`, `pubkey`, `address`, `networkId`, `chainId`,
`symbol`, `name`, `balance`, `valueUsd`, `priceUsd`, `icon`, `decimals` or
`precision`, `type`, `isNative`, `contract`, and `dataSource`.

`meta.failures[]` uses `{ caip, reason }`. `meta.staleChains[]` uses
`{ caip, pubkey, ageMs, fetchedAtISO }`. A timeout or upstream failure must
never be returned as a numeric zero balance. Return a stale value marked stale,
or mark the chain degraded/failed.

DeFi position fields used are `pubkey`, `protocol`, `displayName`, `network`,
`networkId`, `balanceUsd`, `icon`, and optional token entries with `networkId`,
`address`, `symbol`, `balance`, and `balanceUsd`.

### Swap quote

Vault sends CAIP identifiers directly:

```json
{
  "sellAsset": "caip-19",
  "sellAmount": "human-readable decimal",
  "buyAsset": "caip-19",
  "recipientAddress": "...",
  "senderAddress": "...",
  "slippage": 1
}
```

The response is an array ordered best-first. Vault consumes the integration,
expected/minimum output, fees, expiry/timing/warnings, inbound address, memo,
router, swapper identity, and the first transaction's signing parameters.
Signing parameters include EVM calldata, UTXO/Cosmos memos and vault addresses,
or a serialized Solana transaction plus Solana metadata.

The legacy quote shape has drifted across integrations. v5 acceptance must use
sanitized golden fixtures for every enabled swapper and representative pair;
do not replace it with a hand-authored “close enough” schema.

### Pending swaps

Registration includes `txHash`, sell/buy CAIP asset objects, quote metadata,
integration, optional swapper, optional Relay `requestId`, and optional NEAR
Intents `depositAddress`. It must be an idempotent upsert by the stable swap
identity; retries must not create a second monitor.

Vault reads status, inbound and outbound confirmations, protocol-specific
outbound hashes, Relay request/output identifiers, swapper/protocol identity,
actionable error fields, time estimates, final buy amount, confirmation time,
and receipt fields such as block number/hash and gas used.

### UTXO

- Unspent entries: `txid`, `vout`, `value`, `tx.hex` or `hex`, and when known
  `address`, `path`, and `scriptType`.
- Pubkey info: `tokens[]` entries with `name` or `address`, `path`, and
  `transfers`. These paths are safety-critical for input/change derivation.
- Fee estimate: numeric `slow`, `average`, and `fastest` or `fast`. Preserve
  the unit behavior from the baseline; Vault detects sat/kB when values exceed
  500 and otherwise treats them as sat/vB.
- Lookup: `hex` or `tx.hex`.
- Broadcast: a string txid or an object containing `txid`, `tx_hash`, or `hash`.

### EVM and account-based chains

- Native/token balance: `nativeBalance` or `balance`; numeric zero is valid,
  while a missing value is an error.
- Token metadata: `{ decimals }`.
- Nonce: `{ nonce }`.
- Gas: a scalar or `{ slow, average, fastest|fast }`, denominated as the current
  baseline expects.
- Cosmos account: `{ account: { account_number, sequence } }` or the legacy
  nested result/value equivalent.
- XRP account: `Sequence`, `ledger_index_current`, and `Balance`.
- Solana builders: `{ serialized }`, with optional `success`, `error`, and
  `message`.

### History, staking, discovery, and names

- History: `{ histories: [{ transactions, loading?, cached? }] }`. An uncached
  first call may return `loading: true`; Vault retries. Transaction fields must
  preserve tx hash/id, direction/value, timestamp, confirmations, block height,
  fee, sender, and recipient.
- Staking: an array or `{ balances: [] }`; entries use `type`, `balance`,
  `valueUsd` or `value`, `ticker` or `symbol`, validator fields, and `status`.
- Available assets: an array or `{ assets: [] }`; each token needs `caip` plus
  display identity/decimals/icon fields.
- Name lookup: `found`, `owner`, `expireBlockHeight`, `aliases`, and
  `preferredAsset`.
- Name registration quote: `registerFeeBase`, `feePerBlockBase`,
  `blocksPerYear`, and optional `currentBlockHeight`.

## Explicit exclusions

The following network activity in Vault is not part of the Pioneer provider
contract:

- Vault's own local REST/RPC routes;
- direct swap-provider fallbacks such as Midgard, Relay, and 1Click;
- direct chain RPC calls made by Vault;
- every legacy `/zapper/*` route, cache key, response type, and environment
  variable;
- legacy Pioneer controllers that no active Vault path invokes.

An excluded route can return only after an identified consumer and captured
contract fixture justify it.

## Contract verification

Before implementing a capability slice:

1. capture sanitized request/response/error fixtures from green and blue;
2. record exact status, headers, field types, numeric units, and stale/error
   semantics;
3. run the same fixture suite against v5;
4. exercise the feature from an unmodified Vault configured with the v5 URL;
5. retain the fixture as a regression test.

Fixtures must use public, fixed addresses and contain no credentials or user
identifiers. Broadcast tests must verify deterministic rejection or response
shape with non-spendable payloads; automated tests must never move funds.
