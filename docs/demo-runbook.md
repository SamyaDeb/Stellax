# StellaX — Demo Runbook (Phase Ω8)

End-to-end walkthrough for a credible testnet demo. Use this checklist
before any presentation, hackathon judging, or stakeholder review.

## 0. Preflight manifests

Validate that the checked-in testnet env and JSON manifests agree before
running expensive smoke tests:

```bash
make demo-preflight
```

The preflight also reminds operators to use the deployed oracle's actual config
view method, `config` — not the old `get_config` helper name:

```bash
source deployments/testnet.env
stellar contract invoke --id "$STELLAX_ORACLE" \
   --source stellax-deployer --network testnet -- config
```

## 1. One-shot smoke gate

```bash
make demo-smoke
```

This runs:
1. `cargo test --workspace --quiet` — every contract unit suite.
2. `pnpm -F @stellax/sdk build` — TS clients compile.
3. `pnpm -F @stellax/telegram-bot build` — bot compiles.
4. `pnpm -F @stellax/frontend build` — Vite production build.
5. `pnpm -F @stellax/e2e ... phase-stuv-smoke.test.ts` — Phase S/T/U/V
   on-chain entrypoints respond.

`make demo-smoke` must exit `0`. If any step fails, fix before presenting.

## 2. Local services for the RWA path

Run these in separate terminals for the RWA collateral and indexed chart flow:

```bash
# Event indexer: required for indexed RWA oracle candles.
source deployments/testnet.env
STELLAX_PERP_ENGINE="$STELLAX_PERP_ENGINE" \
STELLAX_RISK="$STELLAX_RISK" \
STELLAX_BRIDGE="$STELLAX_BRIDGE" \
STELLAX_OPTIONS="$STELLAX_OPTIONS" \
STELLAX_CLOB="$STELLAX_CLOB" \
STELLAX_ORACLE="$STELLAX_ORACLE" \
pnpm -F @stellax/indexer dev
```

```bash
# Keeper: pushes RedStone crypto prices and RWA NAVs.
source deployments/testnet.env
KEEPER_SECRET_KEY=<authorized-and-funded-S-key> \
ORACLE_CONTRACT_ID="$STELLAX_ORACLE" \
FUNDING_CONTRACT_ID="$STELLAX_FUNDING" \
PERP_ENGINE_CONTRACT_ID="$STELLAX_PERP_ENGINE" \
RISK_CONTRACT_ID="$STELLAX_RISK" \
OPTIONS_CONTRACT_ID="$STELLAX_OPTIONS" \
CLOB_CONTRACT_ID="$STELLAX_CLOB" \
RWA_CONTRACTS="BENJI=$STELLAX_RWA_BENJI,USDY=$STELLAX_RWA_USDY,OUSG=$STELLAX_RWA_OUSG" \
RWA_FEEDS=BENJI,USDY,OUSG \
PERP_MARKET_IDS=1,2,3,100,101,102 \
pnpm -F @stellax/keeper dev
```

```bash
# RWA faucet: backs VITE_RWA_FAUCET_URL=http://localhost:8787/mint.
source deployments/testnet.env
node scripts/rwa-faucet.mjs --serve --port 8787
```

After the keeper has pushed at least one RWA NAV, verify indexed candles:

```bash
curl 'http://localhost:4001/prices/BENJI/candles?interval=900&limit=10'
```

## 3. Manual demo script

Walk through the following on the live testnet frontend
(http://localhost:5173 or your deployed Vercel/Cloudflare host).

| # | Action | Phase |
|---|--------|-------|
| 1 | **Connect Freighter** to the testnet wallet | — |
| 2 | **Get test BENJI** from the Vaults RWA collateral card | M / Ω6 |
| 3 | **Deposit BENJI collateral**, confirm wallet balance decreases and vault balance increases | M / Ω6 |
| 4 | **Open a perp** on BENJI-PERP, small 2× long | Y / Ω6 |
| 5 | **Chart check** — BENJI chart says indexed oracle history; if the indexer is cold it should say synthetic fallback | Ω6 |
| 6 | **Close BENJI-PERP** and withdraw part of the BENJI collateral | M / Ω6 |
| 7 | **Deposit anything** — XLM → USDC via the `/deposit` page (path-payment-strict-receive) | W |
| 8 | **Sub-account** — split 100 USDC into sub 1, transfer 30 to sub 2, withdraw 30 | S |
| 9 | **Long-straddle** strategy on XLM-OPTIONS via the Strategy Builder | V |
| 10 | **Spot swap** — atomic swap between two test wallets | T |
| 11 | **Telegram** — `/price XLM`, `/position <G-addr>`, `/funding 0`, `/health <G-addr>` | Ω5 |
| 12 | **Pending payouts** — claim a claimable balance from the `/deposit` page | W |

The Dashboard panel shows: open positions, sub-account balances, active
strategies, and treasury fee accounting.

## 4. Optional mutating RWA e2e

Run once before a high-stakes demo, not in every CI pass:

```bash
make demo-e2e-write
```

This mints BENJI to a disposable user, deposits into the vault, credits yield,
opens/closes a small BENJI-PERP, and withdraws part of the collateral.

## 5. Live testnet addresses

See [deployments/testnet.env](../deployments/testnet.env). Re-run
`source deployments/testnet.env` before invoking any `stellar` CLI command.

## 6. Recovery cheatsheet

| Symptom | Fix |
|---------|-----|
| Oracle stale (`OracleError 5`) | Restart keeper so RedStone crypto prices and RWA NAVs are pushed. |
| `get_config` fails on oracle | Use `config`; the live oracle view method is not `get_config`. |
| RWA chart says synthetic fallback | Start indexer with `STELLAX_ORACLE`, wait for a NAV push, then refresh. |
| RWA faucet button fails | Start `scripts/rwa-faucet.mjs --serve --port 8787` with the deployer/admin identity available. |
| Frontend wallet not detected | Re-install Freighter, switch to **Testnet**, reload page. |
| Path-payment fails on `/deposit` | The Horizon paths query is debounced 400 ms; wait for the candidate list to repopulate. |
| `register_market` fails with `MarketExists` | The market is already live — proceed to Ω6.4 (frontend). |
| Telegram bot 401 | Rotate `TELEGRAM_BOT_TOKEN` from BotFather; restart `pnpm -F @stellax/telegram-bot start`. |

## 7. After the demo

1. `git status` — capture any local config diffs.
2. Save the demo recording.
3. File issues for any rough edges noticed during the walkthrough.
4. Run `make demo-smoke` once more to ensure no regressions slipped in
   from the live session.

✅ Items 0–4 done.
