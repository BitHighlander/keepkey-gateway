# Swap provider parity and deployment checks

The gateway serves the [Vault API contract](./VAULT-PIONEER-CONTRACT.md) at
`https://oracles.cc`. Provider coverage is an ability to attempt a quote; a
particular pair can still be unavailable because of trading halts, provider
limits, liquidity, amount, or source-chain execution checks.

## Routing and restored behavior

The first tier queries eligible direct THORChain, MayaChain, Relay, NEAR Intents,
0x, and Uniswap integrations. Successful routes in that tier are sorted by
output. ShapeShift is the next fallback tier, followed by fee-attributed
SwapKit routes when configured. ShapeShift remains the Chainflip fallback;
there is no configured direct KeepKey Chainflip broker.

- NEAR Intents uses 1Click directly. It discovers tokens on demand, preserves
  native precision, refunds to the customer's origin address, verifies the
  registered deposit terms, and supports pending-swap status checks.
- Relay supports EVM and Solana origins, including verified ERC-20/SPL token
  precision and fresh unsigned Solana serialization. Bitcoin is destination
  only; an upstream route being disabled does not remove other providers.
- THORChain and MayaChain normalize quote quantities to protocol precision
  while retaining the exact source deposit amount. ETH source precision is
  not incorrectly limited to eight decimals.
- `memoless: true` excludes memo-based adapters and rejects a returned memo.
  `relayExecutionMode: "solver-deposit"` requests and validates the supported
  EVM deposit form. Vault sends this extension only when the selected server's
  OpenAPI schema advertises it; legacy Pioneer rejects unknown quote fields.

Adapters do not fetch during construction or eligibility checks. Token
registries, metadata, blockhashes, quotes, and status are fetched because of a
request, with bounded request timeouts and short metadata reuse. There is no
provider-health polling loop while wallets are idle.

## Fees and configuration

Defaults restore the legacy source policy; deployment environment overrides
take precedence. These are app fees, with network, provider, and protocol costs
reported separately.

| Integration | Default app policy | Optional environment overrides |
| --- | --- | --- |
| NEAR Intents | 30 bps to `caa0106da86351f909f1dfa28e7bfa65665554dc512ab2eedd431b040daa3a1f` | `NEAR_AFFILIATE_RECIPIENT`, `NEAR_AFFILIATE_BPS` (0–450) |
| Relay | 30 bps: 15 to `0x87Ab2637bc4231604ad708c5e8aAC92A260c7704`, 15 to `0x21c9a94AF76B59b171b32fD125A4edF0e9A2Ad3e` | `RELAY_AFFILIATE_ADDRESS`, `RELAY_AFFILIATE_ADDRESS_2`, `RELAY_AFFILIATE_BPS` (0–1000) |
| THORChain | 30 bps, affiliate `keep` | `THORCHAIN_AFFILIATE`, `THORCHAIN_AFFILIATE_BPS` (0–1000) |
| MayaChain | 30 bps, affiliate `keep` | `MAYACHAIN_AFFILIATE`, `MAYACHAIN_AFFILIATE_BPS` (0–500) |

Zero bps disables the configured app charge; upstream charges can remain. An
odd Relay total assigns its remainder to the first recipient. ShapeShift
partner/provider attribution is validated from its response rather than
assuming a fixed rate. Quotes without the required fallback attribution are
rejected.

`NEAR_API_SECRET` optionally authenticates 1Click requests. `NOWNODES_API_KEY`
supplies EVM reads and Solana RPC; Solana serialization is only requested for a
Solana origin. `ZEROX_API_KEY` and `SWAPKIT_API_KEY` enable their integrations.
Worker settings are forwarded through `src/container-env.ts`; configure hosted
values as Worker variables or secrets and local values in `.env`. Never put API
credentials in source or quote reports.

NEAR and Relay expose `raw.fees.items` with `kind`, `assetCaip`, `symbol`,
`decimals`, `amountBaseUnits` and/or decimal `amount`, and optional `bps`,
`recipient`, and `label`. Consumers must use that currency metadata: a SOL fee
is not an ETH fee merely because ETH is the destination. Source gas is not the
integrator fee. NEAR withdrawal costs identify the destination currency.

## Health and release evidence

`/api/v1/health` checks the running revision and database. `/api/v1/swap/health`
reports recent demand-driven quote observations. `unknown` means there is no
recent quote observation; `degraded` means a recent pair/amount failed. Neither
proves a provider-wide outage. A THORChain halt message is returned only after
all eligible fallback tiers fail, with individual attempts in the diagnostics.

On each `master` push, [deployment CI](../.github/workflows/deploy.yml) installs
the frozen lockfile, runs unit tests and both TypeScript checks, stamps the
commit, deploys, and waits for that exact revision plus a healthy database.
The next gate runs:

```sh
bun container/live/provider-parity.ts https://oracles.cc
```

It requires executable quotes for ETH→LTC, an 18-decimal ETH→LTC amount,
LTC→ETH, SOL→ETH, and memoless BTC→LTC. Both LTC directions require a direct
`nearIntents` route. A provider outage fails this live gate visibly even when
the application health endpoint is healthy. A failed post-deploy gate reports
a failed deployment workflow; it does not automatically roll back the image.

After deployment, compare the old server and gateway from the Vault checkout:

```sh
cd projects/keepkey-vault
bun scripts/audit-swap-provider-parity.ts /private/tmp/provider-parity.json --check-parity
bun scripts/audit-swap-sdk-contract.ts /private/tmp/provider-sdk-contract.json --check-current-client
```

The first command compares identical public fixtures on `api.keepkey.info` and
`oracles.cc`, including memoless behavior and source transaction shapes. Its
`--only='ETH to LTC|LTC to ETH|SOL to ETH|memoless'` option narrows a diagnostic
rerun; the full matrix is the release comparison. The second uses Vault's
installed SDK and capability negotiation against both servers.

These checks register isolated API clients and can allocate unused deposit
addresses. They never read wallet credentials, sign, or broadcast. Passing
quotes establish API and unsigned-transaction behavior; device review and a
funded swap remain separate validation.
