# Zerion adapter

Pioneer v5 uses Zerion as a new provider adapter. It carries no Zapper route,
schema, cache key, client package, or environment name.

## Upstream contract

The adapter calls Zerion only in response to an authenticated wallet request:

1. `GET /v1/chains/` to resolve Zerion chain IDs to their current external EVM
   chain IDs;
2. `GET /v1/wallets/{address}/positions/` with
   `filter[positions]=only_complex`, `currency=usd`, and `sort=-value`.

Zerion documents HTTP Basic authentication with the API key as the username
and an empty password. Its `only_complex` filter returns protocol positions
instead of ordinary wallet tokens:

- <https://developers.zerion.io/quickstart>
- <https://developers.zerion.io/api-reference/wallets/get-wallet-fungible-positions>
- <https://developers.zerion.io/api-reference/chains/get-list-of-all-chains>

No Zerion request happens during startup or while Pioneer has no demand.

## Public v5 response

`GET /api/v1/zerion/positions/{address}` returns:

```json
{
  "address": "0x...",
  "source": "zerion",
  "positions": [
    {
      "pubkey": "0x...",
      "type": "contract-position",
      "positionType": "deposit",
      "protocol": "Aave V3",
      "displayName": "Aave",
      "label": "Supplied USDC",
      "network": "ethereum",
      "networkId": "eip155:1",
      "balanceUsd": 5000.25,
      "tokens": []
    }
  ]
}
```

Zerion resource IDs remain opaque. Network identity comes from the live chain
catalog's `external_id`, converted to CAIP-2; it is not inferred from Zerion's
slug or a hardcoded table.

All `only_complex` results use `type: contract-position`. The more precise
Zerion category is retained as `positionType`. This prevents protocol
underlyings from being mistaken for independently spendable wallet tokens.

## Request reduction

- Concurrent requests for one address share a single in-flight promise.
- Normalized positions are cached for 15 minutes in bounded process memory and
  PostgreSQL, with a 24-hour stale window for a later degraded-response path.
- The chain catalog is cached for 24 hours in memory and PostgreSQL and loaded
  only on first Zerion use.
- PostgreSQL advisory leases coalesce cold misses across container replicas;
  the winner fetches while followers reuse the resulting cache record.
- A disabled adapter performs no calls and returns `feature_unavailable`.
