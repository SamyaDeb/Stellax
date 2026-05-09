# StellaX — Implementation V3 Extended

> **Goal**: ship a credible end-to-end testnet demo where every Phase S–V
> feature is callable from the frontend, with telegram bot observability,
> RWA markets live, and the e2e harness green.
>
> **Scope**: Items 1 → 6 of the post-Phase-Z plan (mainnet items deferred).
> **Audience**: yourself + AI agent. Each step is a tight directive — no
> open questions.
>
> **Conventions**:
> - Paths are workspace-relative.
> - Shell snippets assume `cwd = /Users/samya/Downloads/stellax`.
> - "✅ verify" lines are gates — do not move on until they pass.
> - Anything tagged `[AGENT]` is a good prompt to hand back to Copilot.

---

## Table of Contents

- [Phase Ω1 — Testnet Upgrade S–V](#phase-ω1--testnet-upgrade-sv)
- [Phase Ω2 — Referrals decision](#phase-ω2--referrals-decision)
- [Phase Ω3 — Frontend wiring of Phase S/T/U/V](#phase-ω3--frontend-wiring-of-phase-stuv)
- [Phase Ω4 — Phase W frontend (deposit-anything + claimable)](#phase-ω4--phase-w-frontend-deposit-anything--claimable)
- [Phase Ω5 — Telegram bot live](#phase-ω5--telegram-bot-live)
- [Phase Ω6 — RWA markets launched](#phase-ω6--rwa-markets-launched)
- [Phase Ω7 — E2E harness covers S–V](#phase-ω7--e2e-harness-covers-sv)
- [Phase Ω8 — Demo runbook + smoke gate](#phase-ω8--demo-runbook--smoke-gate)
- [Appendix A — Env vars cheat sheet](#appendix-a--env-vars-cheat-sheet)
- [Appendix B — Common failure modes](#appendix-b--common-failure-modes)

---

## Phase Ω1 — Testnet Upgrade S–V

**Outcome**: live testnet contracts at the existing addresses in
[deployments/testnet.env](../deployments/testnet.env) execute the new entries
added in Phases S, T, U, V.

**Estimated**: half-day.

### Ω1.1 — Pre-flight checks

1. Confirm `stellar` CLI is v26+:
   ```bash
   stellar --version
   ```
2. Confirm the deployer key is loaded:
   ```bash
   stellar keys ls | grep stellax-deployer
   ```
3. Confirm the deployer is funded on testnet (≥ 200 XLM):
   ```bash
   stellar account --network testnet --account stellax-deployer
   ```
4. Confirm the working tree is clean:
   ```bash
   git status
   ```

### Ω1.2 — Build optimised WASMs

```bash
make optimize
ls -la target/wasm32v1-none/release/*.optimized.wasm
```

✅ verify the following files exist and have a recent mtime:
- `stellax_vault.optimized.wasm`
- `stellax_options.optimized.wasm`
- `stellax_treasury.optimized.wasm`

### Ω1.3 — Upgrade `stellax_vault` (Phases S + T)

```bash
HASH_VAULT=$(stellar contract upload \
  --wasm target/wasm32v1-none/release/stellax_vault.optimized.wasm \
  --source stellax-deployer --network testnet)
echo "vault hash: $HASH_VAULT"

source deployments/testnet.env
stellar contract invoke --id "$STELLAX_VAULT" \
  --source stellax-deployer --network testnet \
  -- upgrade --new_wasm_hash "$HASH_VAULT"

# Verify version bump (vault CONTRACT_VERSION is post-upgrade value)
stellar contract invoke --id "$STELLAX_VAULT" --network testnet -- version
```

✅ verify version increased by 1 vs previous reading.

### Ω1.4 — Upgrade `stellax_options` (Phase V)

```bash
HASH_OPT=$(stellar contract upload \
  --wasm target/wasm32v1-none/release/stellax_options.optimized.wasm \
  --source stellax-deployer --network testnet)
stellar contract invoke --id "$STELLAX_OPTIONS" \
  --source stellax-deployer --network testnet \
  -- upgrade --new_wasm_hash "$HASH_OPT"
stellar contract invoke --id "$STELLAX_OPTIONS" --network testnet -- version
```

### Ω1.5 — Upgrade `stellax_treasury` (Phase U)

```bash
HASH_TRE=$(stellar contract upload \
  --wasm target/wasm32v1-none/release/stellax_treasury.optimized.wasm \
  --source stellax-deployer --network testnet)
stellar contract invoke --id "$STELLAX_TREASURY" \
  --source stellax-deployer --network testnet \
  -- upgrade --new_wasm_hash "$HASH_TRE"
stellar contract invoke --id "$STELLAX_TREASURY" --network testnet -- version
```

### Ω1.6 — Smoke-test the new entries

Run a single call against each upgraded entry to prove the ABI is live.

```bash
# Phase S — sub-account read (sub_id=1, expect 0)
stellar contract invoke --id "$STELLAX_VAULT" --network testnet \
  -- get_sub_balance --user "$STELLAX_DEPLOYER" --sub_id 1 --token_address "$STELLAX_USDC"

# Phase V — strategy read (id 999 → StrategyNotFound error is OK; ABI-present)
stellar contract invoke --id "$STELLAX_OPTIONS" --network testnet \
  -- get_strategy --strategy_id 999 || echo "expected StrategyNotFound"

# Phase U — lending pool getter (expect None)
stellar contract invoke --id "$STELLAX_TREASURY" --network testnet \
  -- get_lending_pool
```

### Ω1.7 — Update deployment manifest

Append a comment line in [deployments/testnet.env](../deployments/testnet.env)
recording the upgrade date:

```
# 2026-04-29 — Upgraded vault (Phase S+T), options (Phase V), treasury (Phase U)
```

✅ Phase Ω1 done.

---

## Phase Ω2 — Referrals decision

**Outcome**: the dangling `STELLAX_REFERRALS=` line in
[deployments/testnet.env](../deployments/testnet.env) is resolved.

**Estimated**: half-day.

### Path A — Deploy `stellax-referrals` (recommended)

1. Build: `make optimize` (already done in Ω1.2 if recent).
2. Deploy:
   ```bash
   REFERRALS_ID=$(stellar contract deploy \
     --wasm target/wasm32v1-none/release/stellax_referrals.optimized.wasm \
     --source stellax-deployer --network testnet)
   echo "referrals: $REFERRALS_ID"
   ```
3. Initialize (admin = deployer, treasury = `$STELLAX_TREASURY`):
   ```bash
   stellar contract invoke --id "$REFERRALS_ID" --source stellax-deployer \
     --network testnet -- initialize \
     --admin "$STELLAX_DEPLOYER" --treasury "$STELLAX_TREASURY"
   ```
4. Wire treasury → referrals:
   ```bash
   stellar contract invoke --id "$STELLAX_TREASURY" --source stellax-deployer \
     --network testnet -- set_referrals_contract --addr "$REFERRALS_ID"
   ```
5. Update [deployments/testnet.env](../deployments/testnet.env):
   ```
   STELLAX_REFERRALS=$REFERRALS_ID
   ```

### Path B — Defer (only if you do not want to ship referrals demo)

1. Search the SDK + frontend for `referrals` usage and gate behind a runtime
   feature flag that checks for non-empty env.
2. Add a comment in [deployments/testnet.env](../deployments/testnet.env)
   explaining the deferral.

✅ Phase Ω2 done — pick A unless you have a reason not to.

---

## Phase Ω3 — Frontend wiring of Phase S/T/U/V

**Outcome**: the React app exposes UI surfaces for sub-accounts (S),
spot atomic swaps (T), treasury lending (U), and option strategies (V).
Each surface calls the SDK methods added in those phases.

**Estimated**: 2 days.

### Ω3.1 — Refresh frontend SDK consumption

1. From repo root:
   ```bash
   pnpm -F @stellax/sdk build
   pnpm -F @stellax/frontend typecheck   # if script exists; else `tsc --noEmit`
   ```

✅ verify frontend typechecks against the new SDK methods.

### Ω3.2 — Phase S — Sub-accounts panel

Add to [packages/frontend/src/pages/DashboardPage.tsx](../packages/frontend/src/pages/DashboardPage.tsx)
(or split into `SubAccountsCard.tsx`):

UI:
- Sub-account picker (numeric input, default 1).
- Read row: `vault.getSubBalance(user, subId, USDC)` per token.
- Buttons: **Deposit to sub** / **Withdraw from sub** / **Transfer between subs**.

SDK calls already exist on `VaultClient`:
- `depositSub(user, subId, token, amount, opts)`
- `withdrawSub(user, subId, token, amount, opts)`
- `transferBetweenSubs(user, fromSubId, toSubId, token, amount, opts)`
- `getSubBalance(user, subId, token)`

`[AGENT]` prompt:
> Add a `SubAccountsCard` React component under
> `packages/frontend/src/pages/DashboardPage.tsx` that uses `VaultClient` from
> `@stellax/sdk` to read and mutate sub-account balances. Match existing
> dashboard card styling (`.glass-card`).

### Ω3.3 — Phase T — Atomic spot swap (Trade page)

Add a new tab on [packages/frontend/src/pages/TradePage.tsx](../packages/frontend/src/pages/TradePage.tsx)
called **Spot**:

UI:
- Two side-by-side inputs (token A → amount A | token B → amount B).
- Counterparty address input (the matched maker — for v1 user pastes manually
  or a CLOB endpoint suggests one).
- **Swap** button → `vault.atomicSwap(caller, partyA, partyB, tokenA, amountA, tokenB, amountB, opts)`.
- Note: `caller` must be an authorized vault caller — for the demo, route
  via the keeper relayer; for self-swap UX gate the button until that wiring
  is in place.

### Ω3.4 — Phase U — Treasury lending dashboard (admin-only)

Add a `LendingCard` (admin-gated by checking `connectedAddress === treasury.admin`):
- Display `treasury.getLendingPool()` and `treasury.getLendingDeposited(USDC)`.
- Buttons: **Set lending pool** / **Deposit** / **Withdraw**.

If non-admin, render an info card explaining the feature.

### Ω3.5 — Phase V — Strategy builder (Options page)

Add a new section on [packages/frontend/src/pages/OptionsPage.tsx](../packages/frontend/src/pages/OptionsPage.tsx)
called **Strategies**:

UI:
- Pre-baked templates: **Long Straddle**, **Iron Condor**, **Vertical Spread**.
- Each template populates a leg table the user can edit.
- "Submit Strategy" → `options.submitStrategy(owner, legs, opts)` — capture
  the returned `strategyId` in localStorage.
- "My Strategies" list driven by `options.getUserStrategies(user)` →
  `options.getStrategy(id)` per id; **Cancel** button per active row.

`[AGENT]` prompt:
> Build a `StrategyBuilder` React component using `OptionsClient` from
> `@stellax/sdk`. Provide three templates (long straddle, iron condor,
> bull-call spread) and a custom mode allowing up to 8 legs.

### Ω3.6 — Verify build

```bash
pnpm -F @stellax/frontend build
pnpm -F @stellax/frontend dev   # manual smoke in browser
```

✅ Phase Ω3 done when each surface fires a real signed transaction against
testnet from a Freighter-connected account.

---

## Phase Ω4 — Phase W frontend (deposit-anything + claimable)

**Outcome**: users can deposit any Stellar asset (XLM, native tokens) and
end up with USDC credited in the vault, in one signed transaction;
keeper-issued claimable balances appear in the dashboard.

**Estimated**: 2 days.

### Ω4.1 — Deposit-anything page

Create `packages/frontend/src/pages/DepositPage.tsx`:

1. Asset picker (XLM, USDC, AQUA, yXLM, …) sourced from a static allowlist.
2. Amount input.
3. On change, call Horizon's strict-receive paths endpoint:
   ```
   GET https://horizon-testnet.stellar.org/paths/strict-receive?
     destination_asset_type=credit_alphanum4&
     destination_asset_code=USDC&
     destination_asset_issuer=<USDC issuer>&
     destination_amount=<vault target>&
     source_account=<user G-addr>
   ```
4. Pick the cheapest path; pre-fill `sendMax` with 1% slippage.
5. Build the tx via `stellarNative.buildPathPaymentStrictReceive(...)` from
   `@stellax/sdk`.
6. Sign via Freighter, submit via Horizon, then call
   `vault.deposit(user, USDC, amount, opts)` to bring funds into Soroban
   accounting.

### Ω4.2 — Claimable balances surface

In `DashboardPage.tsx`, add a "Pending Payouts" panel:
1. Query Horizon `/claimable_balances?claimant=<user>` for the connected
   address.
2. Render rows with **Claim** buttons that call
   `stellarNative.buildClaimClaimableBalance(...)` then sign + submit.

### Ω4.3 — Service-worker icons

Replace placeholders so `manifest.webmanifest` resolves:
- `packages/frontend/public/images/icon-192.png`
- `packages/frontend/public/images/icon-512.png`

Use the existing logo SVG and export at the two sizes (any image tool).

### Ω4.4 — Verify

```bash
pnpm -F @stellax/frontend build
```

✅ Build passes; manual browser test on iOS Safari ("Add to Home Screen")
shows the StellaX icon and opens in standalone mode.

---

## Phase Ω5 — Telegram bot live

**Outcome**: a public testnet bot answers `/price`, `/position`, `/funding`,
`/help` with live data from the upgraded contracts.

**Estimated**: 1 day.

### Ω5.1 — Configure SDK in the bot

Edit [packages/telegram-bot/src/index.ts](../packages/telegram-bot/src/index.ts):

1. Build a shared `RpcExecutor` instance using `@stellar/stellar-sdk/rpc`'s
   `Server` and an unauth simulate-only path (reads only — no signing in
   the bot).
2. Replace the `/price` stub with:
   ```ts
   const oracle = new OracleClient(executor, env.STELLAX_ORACLE_ADDR);
   const p = await oracle.getPrice(symbol);   // PriceData { price, timestamp }
   ```
3. Replace the `/position` stub with:
   ```ts
   const perp = new PerpEngineClient(executor, env.STELLAX_PERP_ADDR);
   const positions = await perp.getUserPositions(addr);
   ```
4. Add `/funding <market_id>` → `funding.getFundingIndex(marketId)`.
5. Add `/health <addr>` → `risk.getAccountHealth(addr)`.

### Ω5.2 — Deploy

For a quick demo, run on a small VM (or `fly.io` / `railway`):

```bash
export TELEGRAM_BOT_TOKEN=...
export SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
export STELLAX_PERP_ADDR=$STELLAX_PERP_ENGINE
export STELLAX_ORACLE_ADDR=$STELLAX_ORACLE
pnpm -F @stellax/telegram-bot build
pnpm -F @stellax/telegram-bot start
```

Add a `Dockerfile` later if you need persistent hosting.

✅ Phase Ω5 done when `/price XLM` in Telegram returns a fresh price.

---

## Phase Ω6 — RWA markets launched

**Outcome**: BENJI, USDY, OUSG perp markets are live on testnet and tradable
from the frontend.

**Estimated**: half-day.

### Ω6.1 — Push initial NAV

For each symbol (example: BENJI):

```bash
STAMP=$(date +%s)
stellar contract invoke --id "$STELLAX_ORACLE" \
  --source stellax-deployer --network testnet \
  -- set_price --feed_id BENJI \
  --price 1000000000000000000 --timestamp "$STAMP"
```

Repeat for `USDY` (1.05e18) and `OUSG` (101.50e18).

### Ω6.2 — Register markets

```bash
stellar contract invoke --id "$STELLAX_PERP_ENGINE" \
  --source stellax-deployer --network testnet \
  -- add_market --market_id 100 --base_asset BENJI --is_active true

stellar contract invoke --id "$STELLAX_PERP_ENGINE" \
  --source stellax-deployer --network testnet \
  -- add_market --market_id 101 --base_asset USDY --is_active true

stellar contract invoke --id "$STELLAX_PERP_ENGINE" \
  --source stellax-deployer --network testnet \
  -- add_market --market_id 102 --base_asset OUSG --is_active true
```

### Ω6.3 — Conservative risk parameters

Set per [docs/rwa-perpetuals.md](rwa-perpetuals.md). Use `risk.set_market_params`
or whichever entry your risk contract exposes (verify name with
`stellar contract bindings ... | grep -i margin`).

### Ω6.4 — Frontend market list

Edit the static market registry the frontend uses (check
`packages/frontend/src/markets.ts` or equivalent) to include:
- `{ id: 100, label: "BENJI-PERP", badge: "RWA" }`
- `{ id: 101, label: "USDY-PERP",  badge: "RWA" }`
- `{ id: 102, label: "OUSG-PERP",  badge: "RWA" }`

Add a small **RWA** badge in the trade page header.

### Ω6.5 — Keeper NAV cadence

Append a daily cron entry to the keeper config (check `packages/keeper/`):
```
0 0 * * *  push-nav BENJI USDY OUSG
```

✅ Phase Ω6 done when frontend lets you open a small position on BENJI-PERP.

---

## Phase Ω7 — E2E harness covers S–V

**Outcome**: `pnpm -F @stellax/e2e test` (the existing vitest crate)
includes coverage for every Phase S/T/U/V entry against the upgraded
testnet contracts.

**Estimated**: 1 day.

### Ω7.1 — Audit existing e2e

```bash
ls packages/e2e/src/
cat packages/e2e/vitest.config.ts
```

Note the test runner pattern (env-gated network dispatch).

### Ω7.2 — Add Phase S e2e

Create `packages/e2e/src/phase-s-sub-accounts.test.ts`:
- deposit USDC into vault.
- `depositSub(user, 1, USDC, 100)` — assert master balance unchanged.
- `getSubBalance(user, 1, USDC)` returns 100.
- `transferBetweenSubs(user, 1, 2, USDC, 30)` — sub 1 = 70, sub 2 = 30.
- `withdrawSub(user, 2, USDC, 30)` — sub 2 = 0.

### Ω7.3 — Add Phase T e2e

Create `packages/e2e/src/phase-t-atomic-swap.test.ts`:
- two test accounts; vault-credit each via `bridge.bridge_collateral_in` or
  the keeper-relayed `vault.credit` admin path.
- Run `vault.atomicSwap(...)`; assert balances flipped on both sides.
- Negative case: same-token swap rejects.

### Ω7.4 — Add Phase U e2e

Create `packages/e2e/src/phase-u-lending.test.ts`:
- Deploy a mock lending contract (or skip — see note).
- Configure pool via `treasury.setLendingPool(...)`.
- `treasury.depositToLending(USDC, 100)`; assert
  `getLendingDeposited(USDC) === 100n`.
- `treasury.withdrawFromLending(USDC, 100)`; assert it goes back to 0.

> Note: deploying a mock lending contract from TS is non-trivial. For the
> demo gate, run this test only against a local quickstart node and skip on
> testnet (set `describe.skipIf(process.env.NETWORK === "testnet")`).

### Ω7.5 — Add Phase V e2e

Create `packages/e2e/src/phase-v-strategies.test.ts`:
- `options.submitStrategy(owner, [longCall, longPut])` (long straddle).
- Assert `getStrategy(id).legs.length === 2` and `active === true`.
- `cancelStrategy(owner, id)`; assert `active === false`.
- Negative: `submitStrategy(owner, [])` rejects.

### Ω7.6 — Run

```bash
pnpm -F @stellax/e2e test
```

✅ All four new specs green.

---

## Phase Ω8 — Demo runbook + smoke gate

**Outcome**: a single `make demo-smoke` (or a documented checklist) you
can run before any demo to prove the system end-to-end.

**Estimated**: half-day.

### Ω8.1 — Add `make demo-smoke` target

In the [Makefile](../Makefile) add:

```make
.PHONY: demo-smoke
demo-smoke:
	cargo test --workspace --quiet
	pnpm -F @stellax/sdk build
	pnpm -F @stellax/telegram-bot build
	pnpm -F @stellax/frontend build
	pnpm -F @stellax/e2e test
	@echo "✅ demo smoke green"
```

### Ω8.2 — Demo script

Walk-through (pin in your demo notes):
1. **Connect Freighter** on the frontend.
2. **Deposit-anything** — XLM → USDC into vault (Phase W).
3. **Sub-account** — split 100 USDC into sub 1 (Phase S).
4. **Open perp position** on BENJI-PERP (Phase Y).
5. **Submit a long-straddle strategy** on XLM-OPTIONS (Phase V).
6. **Spot swap** between two test wallets (Phase T).
7. **Telegram** — `/price XLM`, `/position <addr>` (Phase Ω5).
8. **Dashboard** shows position, sub-balances, strategy, claimable balances.

### Ω8.3 — Final gate

```bash
make demo-smoke
```

Then walk through Ω8.2 manually. If both pass, you have a credible
testnet demo.

✅ Items 1–6 done.

---

## Appendix A — Env vars cheat sheet

```bash
# Required for every step
export STELLAX_NETWORK=testnet
export STELLAX_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
export STELLAX_RPC_URL=https://soroban-testnet.stellar.org

# Loaded from deployments/testnet.env
source deployments/testnet.env

# Telegram bot
export TELEGRAM_BOT_TOKEN=...

# E2E
export NETWORK=testnet
```

---

## Appendix B — Common failure modes

| Symptom                                         | Likely cause                         | Fix                                                    |
|-------------------------------------------------|--------------------------------------|--------------------------------------------------------|
| `upgrade` invoke errors `Unauthorized`          | Wrong source account                 | Use the contract's stored admin (deployer)             |
| New entry returns `HostError: function not found` | Upgrade not applied                | Re-run Ω1.3/4/5; confirm `version()` bumped           |
| Frontend SDK call fails with `simulation error` | Stale TS build                       | `pnpm -F @stellax/sdk build` then refresh dev server   |
| `set_price` returns `Unauthorized`              | Wrong keeper key                     | Use the configured keeper, not the deployer           |
| Path-payment "no path"                          | Liquidity gap on testnet SDEX        | Lower destination amount or switch source asset       |
| Telegram `getUpdates` 401                       | Wrong bot token                      | Re-issue via @BotFather                                |
| `make optimize` produces no `.optimized.wasm`   | Missing `wasm-opt` (Binaryen)        | `brew install binaryen`                                |
| Vault `atomic_swap` rejects                     | Caller not in authorized list        | `vault.set_authorized_caller(<frontend relay>, true)` |

---

**Definition of Done for V3-extended**: all eight Ω-phases above check ✅,
`make demo-smoke` green, manual demo script Ω8.2 walks end-to-end without
errors against testnet from the deployed frontend.
