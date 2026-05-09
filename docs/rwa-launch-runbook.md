# Phase Ω6 — RWA Perpetuals Launch Runbook

**Goal**: enable BENJI / USDY / OUSG perpetual markets on testnet so the
frontend (already updated in [packages/sdk/src/clients/perp-engine.ts](../packages/sdk/src/clients/perp-engine.ts) →
`STATIC_MARKETS`) can list them and let users open positions.

> **Why this is a runbook and not a Makefile target**: the production
> oracle uses signed RedStone payloads (`write_prices(payload: Bytes)`),
> not a plain `set_price` entry. The plan's `set_price --feed_id BENJI`
> command would fail. The keeper extension is therefore a proper
> step-by-step ops procedure rather than an automatic CLI invocation.

## Prerequisites

```bash
source deployments/testnet.env    # populates STELLAX_* + STELLAR_NETWORK
stellar keys public-key stellax-deployer
```

## Ω6.1 — Extend oracle feed allow-list + register perp markets

Use the checked-in SDK script. It handles the Vec/Bytes ScVal encoding that the
CLI struggles with, upgrades the oracle when `ORACLE_WASM_HASH` is supplied,
pushes seed NAVs, and registers market IDs 100/101/102.

```bash
source deployments/testnet.env
node scripts/setup-rwa-markets.mjs

# If the deployed oracle does not expose admin_push_price yet:
ORACLE_WASM_HASH=<new_oracle_wasm_hash> node scripts/setup-rwa-markets.mjs
```

Verify with the actual config view name (`config`, not `get_config`):

```bash
stellar contract invoke --id "$STELLAX_ORACLE" \
  --source stellax-deployer --network testnet -- config

for feed in BENJI USDY OUSG; do
  stellar contract invoke --id "$STELLAX_ORACLE" \
    --source stellax-deployer --network testnet -- get_price --asset "$feed"
done

for market in 100 101 102; do
  stellar contract invoke --id "$STELLAX_PERP_ENGINE" \
    --source stellax-deployer --network testnet -- get_market --market_id "$market"
done
```

## Ω6.2 — Deploy mock RWA issuer tokens + register vault collateral

These are required for the RWA collateral/yield part of the demo. The perps can
trade after Ω6.1, but the Vaults page needs issuer contracts and vault collateral
configuration.

```bash
stellar contract build --package stellax-rwa-issuer
stellar contract optimize --wasm target/wasm32v1-none/release/stellax_rwa_issuer.wasm

source deployments/testnet.env
node scripts/deploy-rwa-issuers.mjs
source deployments/testnet.env
node scripts/setup-rwa-collateral.mjs
```

Smoke-test faucet minting and a small deposit:

```bash
node scripts/rwa-faucet.mjs --asset BENJI --account "$STELLAX_DEPLOYER" --amount 100
stellar contract invoke --id "$STELLAX_VAULT" --source stellax-deployer \
  --network testnet -- deposit \
  --user "$STELLAX_DEPLOYER" --token_address "$STELLAX_RWA_BENJI" --amount 1000000
```

## Ω6.3 — Keeper NAV cadence

Run the full keeper with:

```bash
RWA_FEEDS=BENJI,USDY,OUSG \
RWA_CONTRACTS="BENJI=$STELLAX_RWA_BENJI,USDY=$STELLAX_RWA_USDY,OUSG=$STELLAX_RWA_OUSG" \
PERP_MARKET_IDS=1,2,3,100,101,102 \
WORKER_RWA_NAV_ENABLED=true \
WORKER_YIELD_SIMULATOR_ENABLED=true \
pnpm -F @stellax/keeper start
```

The repaired keeper RedStone fetcher uses the RedStone SDK serializer; RWA NAVs
use `oracle.admin_push_price`. Keep crypto feeds and RWA feeds separate.

## Ω6.4 — Indexer-backed RWA chart history

The indexer persists oracle `price_upd` / `price_adm` events and serves RWA
OHLC candles to the frontend. Start it with the oracle contract included:

```bash
source deployments/testnet.env
STELLAX_PERP_ENGINE="$STELLAX_PERP_ENGINE" \
STELLAX_RISK="$STELLAX_RISK" \
STELLAX_BRIDGE="$STELLAX_BRIDGE" \
STELLAX_OPTIONS="$STELLAX_OPTIONS" \
STELLAX_CLOB="$STELLAX_CLOB" \
STELLAX_ORACLE="$STELLAX_ORACLE" \
pnpm -F @stellax/indexer dev
```

After at least one keeper NAV push, verify candles:

```bash
curl 'http://localhost:4001/prices/BENJI/latest'
curl 'http://localhost:4001/prices/BENJI/candles?interval=900&limit=10'
```

If this endpoint is empty on a fresh DB, the frontend intentionally falls back
to synthetic NAV candles until the next oracle event is indexed.

## Ω6.5 — Faucet and write-side smoke

Run the local faucet for the browser demo:

```bash
source deployments/testnet.env
node scripts/rwa-faucet.mjs --serve --port 8787
```

Run the opt-in mutating e2e once before a high-stakes demo:

```bash
make demo-e2e-write
```

This is intentionally not part of the default smoke gate because it mutates
shared testnet state.

## Ω6.6 — Final pre-demo checks

```bash
make demo-preflight
make demo-smoke
```

---

## Legacy notes

The old manual CLI procedure below is retained only for historical context. Use
the scripts above for live testnet.

## Ω6.1 (legacy) — Extend oracle feed allow-list

The oracle stores its `feed_ids` set in instance storage. Append the RWA
symbols via `update_config`:

```bash
stellar contract invoke --id "$STELLAX_ORACLE" \
  --source stellax-deployer --network testnet \
  -- update_config \
  --signers '<existing_signers_json>' \
  --threshold 1 \
  --staleness_ms 86400000 \
  --feed_ids '["XLM","BTC","ETH","SOL","USDC","BENJI","USDY","OUSG"]'
```

> Read the existing config first with `stellar contract invoke … -- config`
> (or your current admin script) and copy `signers` + `threshold` verbatim.

## Ω6.2 — Push initial NAV via the keeper

The oracle accepts only signed RedStone payloads. Two options:

**Option A — extend `scripts/oracle-keeper.mjs`** to fetch BENJI/USDY/OUSG
NAV from a feed source you trust (Franklin, Ondo, Treasury yields) and
include them in the next signed batch.

**Option B — temporary mock oracle for testnet only**: deploy a copy of
the `MockReflector` test contract, point the perp engine's oracle binding
at it via `update_dependencies`, and set prices directly:
```bash
# only on a forked / sandboxed testnet — never on the live demo environment.
```

Recommended: **Option A**. Document the keeper extension PR.

## Ω6.3 — Register the markets

For each `(market_id, base_asset)` triple, build a `Market` JSON value
matching `stellax-math::types::Market`:

```bash
MARKET_BENJI='{
  "market_id": 100,
  "base_asset": "BENJI",
  "quote_asset": "USD",
  "max_leverage": 3,
  "maker_fee_bps": 5,
  "taker_fee_bps": 15,
  "max_oi_long": "100000000000000000000",
  "max_oi_short": "100000000000000000000",
  "is_active": true
}'

stellar contract invoke --id "$STELLAX_PERP_ENGINE" \
  --source stellax-deployer --network testnet \
  -- register_market \
  --market "$MARKET_BENJI" \
  --min_position_size 1000000000000000000 \
  --skew_scale 100000000000000000000 \
  --maker_rebate_bps 2

# repeat with market_id 101 (USDY) and 102 (OUSG) using the same
# template; only base_asset changes.
```

Verify:
```bash
stellar contract invoke --id "$STELLAX_PERP_ENGINE" \
  --source stellax-deployer --network testnet \
  -- get_market --market_id 100
```

## Ω6.4 — Frontend market list

Already done in code:
- [packages/sdk/src/core/types.ts](../packages/sdk/src/core/types.ts) — `Market.badge?: string`.
- [packages/sdk/src/clients/perp-engine.ts](../packages/sdk/src/clients/perp-engine.ts) — `STATIC_MARKETS` extended with 100/101/102, all `badge: "RWA"`.
- [packages/frontend/src/pages/dashboard/MarketsTable.tsx](../packages/frontend/src/pages/dashboard/MarketsTable.tsx) — renders badge pill.

After Ω6.3 lands, the Trade and Dashboard pages list BENJI-PERP, USDY-PERP,
OUSG-PERP with the **RWA** pill.

## Ω6.5 — Keeper NAV cadence

Add to keeper config (e.g. `packages/keeper/src/config.ts` or a cron
workflow file):

```
0 0 * * *   pnpm -F @stellax/keeper push-nav -- --feeds BENJI,USDY,OUSG
```

The handler should fetch NAV from a configured source, sign the payload,
and call `oracle.write_prices(payload)`.

## ✅ Done when

1. `stellar contract invoke … -- get_market --market_id 100` returns the BENJI market.
2. `oracle.get_price BENJI` returns a fresh value (timestamp within `staleness_ms`).
3. Frontend Trade page lists **BENJI-PERP** with an **RWA** badge.
4. Opening a 50-USDC long position on BENJI-PERP from the frontend succeeds.
