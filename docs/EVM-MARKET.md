# EVM and market adapters

This slice implements the six Pioneer operations currently read by Vault:

- `GetMarketInfo`
- `GetGasPriceByNetwork`
- `GetNonceByNetwork`
- `GetBalanceAddressByNetwork`
- `GetTokenDecimals`
- `GetTokenBalance`

The OpenAPI document uses OpenAPI 3 `requestBody` semantics. This is required
by the current `@pioneer-platform/pioneer-client`, which sends body-bearing
operations through its `requestBody` field.

## Demand-only behavior

Constructing or starting either adapter performs zero provider calls. A call is
made only after an authenticated request misses bounded process memory and the
PostgreSQL cache. Concurrent cold misses are coalesced with an in-process
singleflight promise and a PostgreSQL advisory lock.

NOWNodes chain identity is verified with `eth_chainId` inside the first JSON-RPC
batch for each network, so validation does not add another HTTP request. The
supported wallet networks are Ethereum, Optimism, BSC, Polygon, Base, Arbitrum,
and Avalanche. NOWNodes authentication uses the `api-key` request header:

- <https://docs.nownodes.io/documentation/welcome-to-nownodes-docs/how-to-get-started-with-nownodes-api-key.html>

Nonce reads use the `pending` block tag, matching the legacy Pioneer signing
path and preventing reuse of a nonce already held by a pending transaction.
Balances are formatted with `BigInt` string arithmetic; they are never passed
through floating point.

Cache policy is versioned code:

| Resource | Fresh | Stale-on-error |
| --- | ---: | ---: |
| gas price | 15 seconds | 1 minute |
| pending nonce | 2 seconds | none beyond 2 seconds |
| native/token balance | 8 seconds | 1 minute |
| token decimals | 24 hours | 7 days |
| USD market price | 1 minute | 10 minutes |

CoinGecko prices are requested in one `/simple/price` batch for every cache
miss in a Vault request. Results are stored per CoinGecko asset ID so different
wallet portfolios share cache entries:

- <https://docs.coingecko.com/reference/simple-price>
- <https://docs.coingecko.com/reference/authentication>

## Discovery snapshot

CAIP-to-CoinGecko IDs and chain metadata are copied from
`@pioneer-platform/pioneer-discovery` 10.3.5, not maintained as source-code
conditionals:

| File | SHA-256 |
| --- | --- |
| `container/data/chains.json` | `cbb93329ec7a797efb2ca07edc70ae3afd5e2dfc84f732322b8a10c5531ec1a6` |
| `container/data/coingecko-mapping.json` | `5565714e81373471e00f1eb9d6a8ed8a937a7a5859fd2de1d91ddd8851dd2826` |

Updating discovery is a deliberate snapshot update: copy both generated files,
record the source package version, update these hashes, then run deterministic
and live contract tests.
