# StellaX V3 — Feature Expansion Implementation Plan (Testnet-First, Grant-Targeted)

> **Target agent**: This document is a self-contained, code-free blueprint for
> StellaX V3. It extends the V2 implementation (Phases A–L, completed and
> deployed to Stellar testnet on 23 April 2026) with the next generation of
> features that close the gap to top-tier CEXes (Binance, Deribit, Bybit) and
> top-tier perp DEXes (Hyperliquid, dYdX v4, GMX v2).
>
> **Strategic shift (29 April 2026)**: V3 is now executed entirely on
> **Stellar testnet** as a fully-functional grant-pitch demo (target:
> ≥ $100k USDC in grants from Stellar Community Fund / SDF / external
> ecosystem grants). All V3 features — including RWA collateral and RWA
> perpetuals — ship on testnet using **mock issuer-branded tokens backed by
> real-time NAV prices** from RedStone (USDY) and Ondo's public NAV API
> (BENJI). The on-chain code path is identical to mainnet; only the token
> contract is a mock. Mainnet (Phase L proper) is deferred until after grant
> funding is secured and issuer partnerships (Franklin Templeton, Ondo) are
> closed.
>
> **Prerequisite**: V2 testnet stable (already true since 23 April 2026).
> No mainnet deployment is gating V3 work.
>
> **Current date**: 29 April 2026
> **Toolchain**: Rust 1.89, soroban-sdk 23, wasm32v1-none, Node 20, pnpm 9
> **Existing contracts assumed live on testnet**: governor, oracle, vault,
> perp-engine, funding, risk, options, structured, treasury, bridge, clob,
> staking (12 Soroban contracts deployed at addresses recorded in
> `deployments/testnet.json`).

---

## Table of Contents

1. [V3 Goals & Design Philosophy](#1-v3-goals--design-philosophy)
2. [Existing Codebase Inventory (V2)](#2-existing-codebase-inventory-v2)
3. [V3 Feature Map & Priority](#3-v3-feature-map--priority)
4. [Phase M — RWA Collateral Activation (BENJI + USDY)](#phase-m--rwa-collateral-activation)
5. [Phase N — Isolated Margin Mode](#phase-n--isolated-margin-mode)
6. [Phase O — STLX-Weighted On-Chain Governance](#phase-o--stlx-weighted-on-chain-governance)
7. [Phase P — Insurance Fund Auto-Growth + ADL Refinement](#phase-p--insurance-fund-auto-growth)
8. [Phase Q — Referral / Affiliate Program](#phase-q--referral--affiliate-program)
9. [Phase R — Advanced Order Types (TWAP, Bracket, Trailing, Iceberg)](#phase-r--advanced-order-types)
10. [Phase S — Sub-Accounts / Master Wallet](#phase-s--sub-accounts--master-wallet)
11. [Phase T — Spot Trading on the CLOB](#phase-t--spot-trading-on-the-clob)
12. [Phase U — Lending / Yield on Idle Collateral](#phase-u--lending--yield-on-idle-collateral)
13. [Phase V — Options Strategies (Spreads, Straddles, Delta-Neutral Vault)](#phase-v--options-strategies)
14. [Phase W — Stellar-Native Integrations (AQUA, SEP-24, Reflector)](#phase-w--stellar-native-integrations)
15. [Phase X — Mobile + Telegram Bot](#phase-x--mobile--telegram-bot)
16. [Phase Y — RWA Perpetuals (BENJI-PERP, USDY-PERP)](#phase-y--rwa-perpetuals)
17. [Phase Z — V3 Testing, Audit, Mainnet Rollout](#phase-z--v3-testing-audit-mainnet)
18. [Appendix — Cross-Phase Dependencies & Sequencing](#appendix)

---

## 1. V3 Goals & Design Philosophy

V3 has four concurrent themes:

1. **Capital Efficiency** — make the same dollar of collateral do more work
   (isolated margin, lending on idle USDC, RWA yield on margin).
2. **Product Depth** — match feature parity with Deribit (option strategies),
   Binance (advanced order types, sub-accounts), and Hyperliquid (TWAP, bracket).
3. **Stellar Ecosystem Lock-in** — fiat on-ramp (SEP-24), AQUA mining, mobile
   reach. Make StellaX the obvious choice for any Stellar user, not just
   crypto-native traders.
4. **Grant-Ready Testnet Demo** — every feature in V3 must be demonstrable
   end-to-end on Stellar testnet by a non-technical reviewer (grant committee
   member). The judge clicks a Freighter button, deposits a real-priced mock
   T-bill token, opens a 10× BTC perp using it as collateral, watches yield
   drip in real time, and closes the trade — all from the public testnet URL.

### Demo-First (Mock Token, Real Price) Strategy

Real BENJI / USDY tokens are permissioned (Stellar `AUTH_REQUIRED`,
KYC-gated transfers, US-person restrictions). Acquiring them requires
legal partnerships with Franklin Templeton and Ondo — a multi-month
biz-dev process. To unblock V3 immediately, every RWA-touching phase uses
the **mock-token-with-real-price** pattern:

| Layer | Mainnet target | Testnet implementation (V3 today) |
|---|---|---|
| Token contract | Real BENJI/USDY SAC | StellaX-issued SEP-41 mock SAC, decimals & symbol identical to mainnet |
| Authorisation flag | `AUTH_REQUIRED` set by issuer | No auth flag — open trustlines on testnet, plus an opt-in `AUTH_SIM` mode for one demo asset to prove our error-handling works |
| NAV price feed | Issuer-signed daily attestation | RedStone signed `USDY/USD` feed (already supported) + Ondo public NAV HTTP API for BENJI, both pushed by `oracle-pusher` |
| Yield accrual | Token balance grows on chain via issuer rebase | New `yield-simulator` keeper worker drips tokens to holders at the **real USDY/BENJI APY** read from issuer APIs |
| Bridge flow | Real BENJI on Avalanche → Stellar via Axelar ITS | Mock BENJI ERC-20 on Avalanche Fuji ↔ mock BENJI SAC on Stellar testnet (same code path) |
| Liquidation receiving RWA | Issuer KYCs liquidator | No-op on testnet; documented gap for mainnet |

This approach lets V3 ship the **complete code path** (vault registration,
haircut math, oracle wiring, bridge config, frontend tiles, risk monitoring,
yield drip, RWA-PERP market) on testnet with behaviour indistinguishable
from mainnet for any UI or contract test. The only honest disclosure in the
pitch deck is: *"On testnet today, RWA tokens are StellaX-issued mocks
backed by real-time issuer NAV. On mainnet, real BENJI/USDY ship after
issuer partnerships close."*

Design rules carried forward from V2:
- **No floating point**. Every economic value is `i128` 18-decimal fixed-point.
- **In-place upgrades**. Existing contract IDs preserved; only WASM hash changes.
- **Backwards-compatible storage**. New `DataKey` variants added; old keys
  migrated lazily or kept as legacy fallbacks.
- **Single source of types**. All new shared types go into
  `contracts/stellax-math/src/types.rs`.
- **Keeper as off-chain glue**. Anything that doesn't need to be on-chain runs
  in `packages/keeper`.
- **Grant-judge-friendly**. Every phase must produce a 30-second visible
  artefact (UI tile, dashboard chart, working transaction on testnet
  explorer) that a non-engineer can verify.

---

## 2. Existing Codebase Inventory (V2)

### Soroban contracts (`contracts/`)
| Crate | Status after V2 |
|---|---|
| `stellax-math` | Shared types + 18-dec math. `CONTRACT_VERSION = 2` for libs. |
| `stellax-oracle` | Multi-feed prices, RedStone signer set, Reflector fallback. |
| `stellax-vault` | Multi-asset (USDC 0% haircut, XLM 15% haircut). `CollateralConfig` map. |
| `stellax-perp-engine` | Oracle-price + skew fee. CLOB hook (`execute_clob_fill`). |
| `stellax-funding` | Velocity-based funding (Synthetix v3 model). |
| `stellax-risk` | Portfolio margin (perps + options aggregated). Insurance fund. |
| `stellax-options` | SVI vol surface, batch IV push, full Greeks. |
| `stellax-structured` | Covered-call + principal-protected epoch vaults. |
| `stellax-bridge` | Axelar GMP+ITS. `CONTRACT_VERSION = 1` (cosmetic gap). |
| `stellax-clob` | Off-chain matched, on-chain settled, Ed25519-verified. |
| `stellax-staking` | Epoch-based STLX → USDC rewards. |
| `stellax-governor` | Multisig + timelock + emergency pause. **No token voting.** |
| `stellax-treasury` | 60/20/20 split (LP/insurance/stakers). |

### TypeScript packages (`packages/`)
| Package | Status after V2 |
|---|---|
| `keeper` | 7 workers running: oracle-pusher, clob-matcher, liquidation-bot, funding-updater, option-settler, svi-pusher, bridge-keeper. |
| `sdk` | Clients for all 12 contracts + Freighter integration. |
| `frontend` | 8 pages: Trade, Options, Vaults, Staking, Bridge, Dashboard, Governance, Landing. |
| `indexer` | SQLite + Express + WebSocket; tracks all contract events. |
| `e2e` | Vitest E2E harness against testnet. |
| `deployer` | Deploy/upgrade scripts. |

### What V2 explicitly did **not** include
- RWA collateral activation (BENJI, USDY are documented but not registered).
- Isolated-margin user choice (only cross + portfolio margin exists).
- STLX governance voting (governor still admin-multisig only).
- Insurance fund auto-growth from fees.
- Referral fee splits.
- Advanced order types beyond Limit/Market/SL/TP.
- Sub-accounts.
- Spot trading.
- Lending on idle collateral.
- Multi-leg option strategies in one tx.
- AQUA / SEP-24 / Reflector-as-primary integrations.
- Mobile/Telegram surface.
- Any RWA perp markets.

V3 fills exactly these gaps.

---

## 3. V3 Feature Map & Priority

Phases ordered by **value-to-grant-pitch ratio**. The actual dependency
chain is in the Appendix.

| Phase | Feature | Effort | Grant-pitch impact | Testnet blocker? |
|---|---|---|---|---|
| **M** | Mock RWA collateral with real-time NAV + yield drip | Low–Medium | **Critical** | None (mock token + RedStone/Ondo feeds) |
| **N** | Isolated margin | Medium | High | None |
| **O** | STLX governance voting | Medium | High | None (STLX testnet token already live) |
| **P** | Insurance fund auto-growth | Low | Medium | None |
| **Q** | Referral program | Low | Medium | None |
| **R** | Advanced order types | Medium | Medium | Phase B (CLOB) live |
| **S** | Sub-accounts | Medium | Medium | None |
| **T** | Spot trading on CLOB | Medium | High | None |
| **U** | Lending on idle collateral | High | High | Deferred until first grant tranche funds audit |
| **V** | Options strategies | Medium | Medium | Phase E (SVI) live |
| **W** | Stellar-native (AQUA, SEP-24, Reflector) | Low–Medium | High | Anchor sandbox accounts only on testnet |
| **X** | Mobile + Telegram bot | Medium | Medium | None |
| **Y** | RWA perpetuals (mock-NAV-backed BENJI-PERP, USDY-PERP) | Medium | **Critical** | None on testnet (Phase M.3 oracle reused) |

Suggested execution order on testnet (parallelisable, target 8–12 weeks to
grant submission):
- **Sprint 1** (weeks 1–3): **M** (mock RWA + yield drip + frontend), **P**, **Q** — the grant-pitch core.
- **Sprint 2** (weeks 3–6): **S**, **N**, **R**, **W** (SEP-24 sandbox + wallet expansion), **X** PWA.
- **Sprint 3** (weeks 6–9): **O** (governance voting), **T** (spot CLOB), **V** (option strategies), **Y** (RWA perps on testnet).
- **Sprint 4** (weeks 9–12): grant submission package (Z.2), 4-week public beta, demo recording, pitch finalisation.
- **Phase U** (lending): deferred until grant tranche funds the dedicated audit.

---

## Phase M — RWA Collateral Activation (Mock Token, Real Price)

**Goal**: Enable users on Stellar testnet to post **mock BENJI** (Franklin
Templeton T-bill stand-in) and **mock USDY** (Ondo T-bill stand-in) as
margin collateral, with NAV prices fetched live from real issuer feeds and
yield accruing at the real published APY. From the user's and the
contract's perspective, behaviour is identical to mainnet.

**Why first**: Lowest implementation effort (config + one keeper) but
highest narrative value. The "earn T-bill yield while trading 20× BTC"
pitch is unique in DeFi and is the centrepiece of the grant deck.

### M.1 — Mock token issuance on testnet
- Issue two SEP-41 / Soroban-native tokens from a dedicated
  `stellax-rwa-issuer` Stellar account on testnet:
  - `BENJI` — symbol `BENJI`, 6 decimals (matches Franklin's mainnet token).
  - `USDY` — symbol `USDY`, 6 decimals (matches Ondo's mainnet token).
- Both deployed as standard Soroban Asset Contracts (SACs); record SAC
  addresses in `deployments/testnet.json` under a new `mock_rwa` key.
- **No** `AUTH_REQUIRED` flag on the default deployment so any testnet
  account can hold them — keeps the demo friction-free.
- Optionally also issue `BENJI_AUTH` and `USDY_AUTH` variants **with**
  `AUTH_REQUIRED` set, used by one integration test to verify the perp
  engine and liquidator gracefully handle authorisation failures (proves
  mainnet-readiness).
- Mint a starting supply (e.g. 10M each) to a faucet account; expose a
  one-click "Get test BENJI/USDY" button on the frontend that calls the
  faucet via SEP-10-authenticated API.
- Document in the UI and pitch deck: *"Testnet mock; mainnet uses real
  BENJI/USDY post-issuer-partnership."*

### M.2 — Vault registration
- Register the two mock SAC addresses in `stellax-vault` `CollateralConfig`
  map using the existing `register_asset` admin entry point (zero contract
  code change).
- Haircut bps:
  - BENJI: 700 (7%) — slight buffer for redemption-gate risk on mainnet.
  - USDY: 500 (5%) — Ondo allows secondary-market trading.
- Per-asset deposit caps: $500k each on testnet (parameterised via
  governor); raised by governance proposal as part of the demo.
- Decimals: 6 for both (matches mainnet conventions).
- Concentration cap: max 10% of any user's total collateral may be a
  single RWA asset (enforced in `risk.validate_new_pos_with_inputs`).

### M.3 — Real-time NAV oracle wiring
- Extend `stellax-oracle` feed registry with two new entries: `BENJI/USD`
  and `USDY/USD`.
- Extend `packages/keeper/src/workers/oracle-pusher.ts` with two new
  feed sources:
  - **USDY**: read from RedStone's existing signed `USDY/USD` feed (no new
    signers needed — RedStone already supports it).
  - **BENJI**: HTTP fetch from Ondo's public NAV endpoint
    (`nav.ondo.finance` style URL — confirmed during M.1) plus a fallback
    scrape of DeFiLlama's BENJI tracker. Both go through a
    `RwaNavFetcher` adapter that signs the value with our keeper's
    Ed25519 key before submitting to `stellax-oracle.push_price`.
- Push frequency: every 10 minutes (more than fast enough for T-bills,
  visually "live" enough on the trade UI for demos).
- Staleness window: 2 hours (vs 60 s for crypto). After staleness, vault
  pauses new RWA deposits but honours existing positions.
- Fallback chain: RedStone → Ondo API → DeFiLlama → Reflector → freeze
  at last-known.
- Persist a 30-day NAV history in the indexer for the dashboard chart.

### M.4 — Yield drip simulator (NEW, demo-critical)
- New keeper worker `packages/keeper/src/workers/yield-simulator.ts`:
  - Reads the **real** current published APY from issuer feeds
    (USDY ~5.1%, BENJI ~5.0% as of Apr 2026; refreshed daily).
  - Computes per-block accrual rate: `apy / blocks_per_year`.
  - At each daily epoch (or every 1 hour for snappier demos), iterates
    the indexer's list of accounts holding mock BENJI/USDY and calls
    a new `stellax-rwa-issuer.credit_yield(holder, amount)` admin entry
    point that mints tiny amounts of the mock token to each holder
    proportional to their balance × elapsed time.
  - Emits `RwaYieldCredited` event for indexer / frontend animation.
- Yield is credited even while collateral is locked as margin (matches
  mainnet behaviour where the underlying T-bill keeps accruing during
  the trade).
- Worker is idempotent: every epoch it computes the cumulative
  expected balance and credits the delta, so reorgs / restarts don't
  double-pay.
- Result on the demo: a user deposits 1 000 BENJI, opens a 10× BTC long,
  comes back the next morning, sees `1 000.137 BENJI` in their balance,
  and the dashboard tile reads `+$0.137 yield earned · 5.0% APY`.

### M.5 — Bridge config (mock cross-chain BENJI)
- Deploy a mock BENJI ERC-20 on Avalanche Fuji from the existing
  `contracts/evm/` workspace.
- Update `stellax-bridge` trusted-asset map with the Fuji ERC-20 ↔ Stellar
  SAC mapping for mock BENJI.
- Update `packages/keeper/src/workers/bridge-keeper.ts` watch list.
- Demo flow: judge mints 100 mock BENJI on Fuji → calls
  `lockAndSendToStellar` → 30-60 s later sees the same balance on the
  StellaX bridge UI on Stellar testnet → uses it as collateral.
- E2E script `scripts/test-rwa-bridge-e2e.sh` automates the full round-trip
  for CI.

### M.6 — Frontend surfacing
- Add BENJI, USDY tiles to `packages/frontend/src/pages/VaultsPage.tsx`
  deposit UI with:
  - Live NAV badge (refreshed via WebSocket from indexer): `$1.0532`.
  - Yield-bearing badge tied to live APY: `Earning 5.05% APY · T-Bill backed`.
  - 30-day NAV history sparkline (Recharts).
  - Haircut tooltip explaining "effective collateral = balance × (1 − 7%)"
    with a worked example.
  - `Get test BENJI` faucet button (links to M.1 faucet).
  - Mainnet-readiness disclosure banner: "Testnet mock — real BENJI ships
    on mainnet after Franklin Templeton partnership."
- TradePage collateral selector: shows effective margin value post-haircut
  in real dollars next to the asset name.
- DashboardPage: new "RWA Earnings" tile listing cumulative yield credited
  to the connected account (sourced from `RwaYieldCredited` events).

### M.7 — Risk monitoring
- Keeper alert (Slack / Discord webhook) if BENJI/USDY NAV deviates >0.5%
  from $1.00 peg in 1 hour — early warning of an issuer event on the real
  feed.
- Auto-pause new deposits if a single user's RWA exposure would exceed 10%
  of total portfolio collateral value (concentration risk hardcoded in
  risk engine).
- Daily indexer cron: cross-check the sum of `credit_yield` mints against
  the expected APY × TVL — divergence alert.

### M.8 — Tests & demo rollout
- Unit tests (Soroban): deposit, lock margin, withdraw with mock BENJI;
  verify haircut applies; verify `credit_yield` is admin-only.
- Integration test `tests/tests/test_rwa_collateral_lifecycle.rs`:
  faucet → deposit → open BTC-PERP 10× → 7 simulated days of yield drip
  → close → withdraw → assert balance > original by expected APY.
- Integration test `tests/tests/test_rwa_auth_required.rs`: same flow with
  `BENJI_AUTH` variant; assert graceful failure with clear error code.
- E2E (Vitest in `packages/e2e/`): full bridge + deposit + trade + yield
  + close path against testnet.
- Frontend Playwright: judge-script that walks through the demo end-to-end
  in <90 seconds — used as the recorded demo for the grant submission.
- Soft launch: 5 whitelisted grant-pitch testers run the demo for 1 week,
  feedback gates broader public testnet announce.
- Public testnet announce + governance proposal raising caps to $5M each
  after 2 weeks of stable operation.

---

## Phase N — Isolated Margin Mode

**Goal**: Let users opt a position into "isolated" mode where its loss is
capped at the collateral allocated to that single position. Cross/portfolio
margin remains the default.

**Why**: Standard feature on every CEX. Critical for market makers and risk-
averse users. Currently `MarginMode` enum exists in `stellax-math/src/types.rs`
but the vault treats all collateral as fungible.

### N.1 — Storage model
- Decide between two implementation patterns:
  - **Pattern A — sub-bucket inside vault**: extend `vault` storage so
    `LockedMargin(Address, position_id)` is a separate bucket from the
    user's free balance. Used when isolated.
  - **Pattern B — synthetic sub-account**: each isolated position has a
    derived sub-account address (Phase S). Position lives there.
- **Recommendation**: Pattern A first, then Phase S can layer on top.

### N.2 — Vault changes
- New `DataKey::IsolatedMargin(Address, u64)` keyed by user + position_id.
- New entry points: `lock_isolated`, `unlock_isolated`, `realize_isolated_pnl`.
- `get_total_collateral_value` continues to ignore isolated buckets in the
  user's cross calculation (isolated margin is "spoken for").
- Liquidations on isolated positions only consume the isolated bucket; never
  touch the cross collateral.

### N.3 — Perp engine changes
- Extend `Position` struct with `margin_mode: MarginMode` field (enum:
  `Cross`, `Isolated { collateral: i128 }`).
- `open_position` accepts a `margin_mode` parameter. If Isolated, caller
  specifies the collateral amount; that amount is locked in the isolated
  bucket; leverage = notional / collateral.
- `add_collateral_to_position` and `remove_collateral_from_position` admin
  user-only entry points to top up or reduce isolated bucket without closing.

### N.4 — Risk engine changes
- `get_account_health` returns separate health objects per isolated position
  plus one for the cross book.
- Liquidation logic loops: liquidate isolated positions independently when
  their bucket falls below maintenance.
- `validate_new_pos_with_inputs` rejects opening isolated when the requested
  collateral is below the minimum (e.g. $10 USDC equivalent).

### N.5 — Frontend
- Add "Cross / Isolated" toggle in `OrderForm.tsx`.
- For isolated, show explicit collateral input separate from leverage.
- Position table shows margin mode badge.
- Add UI for top-up / withdraw from a specific isolated position.

### N.6 — Tests
- Open isolated long; price moves against, only isolated bucket consumed.
- Cross book unaffected by isolated liquidation.
- User has both cross and isolated positions; verify margin segregation.
- Switching position from isolated → cross (close + reopen, since direct
  conversion is risky to support initially).

---

## Phase O — STLX-Weighted On-Chain Governance

**Goal**: Replace admin-multisig governance with token-weighted voting where 1
STLX = 1 vote. Currently `stellax-governor` only checks multisig signers.

### O.1 — Vote-power source
- Voting power = `staking.get_stake(user).amount` (already-staked STLX).
- This naturally aligns governance with long-term holders, not flash-borrowed
  tokens (no flash-loan voting attacks).
- Snapshot vote power at proposal-creation block, not at vote time, to prevent
  vote-then-unstake.

### O.2 — Governor changes
- New `Proposal` struct: id, action (existing `GovernanceAction` enum), creator,
  snapshot_epoch, votes_for, votes_against, status (Pending/Active/Passed/Failed/Executed/Cancelled).
- New entry points: `create_proposal`, `cast_vote`, `tally_and_execute`.
- Quorum threshold: 4% of total staked STLX must vote.
- Pass threshold: simple majority (> 50% of votes cast).
- Voting period: 3 days. Timelock after pass: 2 days. Total proposal lifetime ~5 days.
- Emergency pause keeps multisig: 3-of-5 council can pause without vote.

### O.3 — Staking contract integration
- Add `get_stake_at_epoch(user, epoch_id) -> i128` view to `stellax-staking`
  for snapshot reads.
- Treat `stake_epoch` as the snapshot anchor.

### O.4 — Frontend Governance page
- `pages/GovernancePage.tsx` already exists — extend it:
  - Tab: "Active Proposals" with countdown, vote bars, your vote-power.
  - Form: "Create Proposal" requires minimum stake to submit (anti-spam).
  - Vote button calls `cast_vote`.
  - Past proposals archive.

### O.5 — Migration
- Existing multisig proposals stay valid until each is executed or expires.
- New proposals after upgrade go through token vote.
- Document the cutover date in the governance page banner.

### O.6 — Tests
- Create proposal, cast votes from 3 stakers, verify tally proportional.
- Quorum failure (low turnout) → proposal fails even with 100% in favour.
- Snapshot integrity: stake → propose → unstake before vote ends → vote power
  remains at snapshot value.
- Emergency pause path still works.

---

## Phase P — Insurance Fund Auto-Growth

**Goal**: The insurance fund currently depends on initial seed + manual
top-ups. Make it self-sustaining by routing a slice of every fee to the fund,
with a target cap.

### P.1 — Fee routing
- Treasury already has 60/20/20 split (LP/insurance/stakers). Confirm
  the 20% bucket actually transfers USDC to the risk contract's insurance
  reserves (this wiring may need a dedicated `top_up_insurance` call).
- Add `InsuranceTarget { soft_cap, hard_cap }` configurable by governance.
- When fund is below `soft_cap`: 20% routing continues.
- When between soft and hard cap: 10% routes to insurance, extra 10% goes to
  stakers.
- When above `hard_cap`: 0% to insurance, full 20% to stakers (or buy-and-burn
  STLX, governance choice).

### P.2 — Risk engine changes
- Add `insurance_balance: i128` view.
- Add `insurance_top_up(amount)` callable only by treasury.
- Add `insurance_payout(amount, recipient)` for ADL/socialised loss scenarios.

### P.3 — ADL refinement
- Currently `stellax-risk` has ADL stub. When insurance < 0 (impossible, so
  when insurance can't cover the bad debt), socialise loss across profitable
  positions starting from highest-PnL leveraged positions first.
- Add events: `InsuranceTopUp`, `InsurancePayout`, `AdlTriggered`.

### P.4 — Frontend
- Dashboard tile: "Insurance Fund" with current balance, target, and 7-day
  growth.
- Trade page warning banner if insurance drops below 50% of soft cap.

### P.5 — Tests
- Force liquidation that exceeds liquidator buffer; verify insurance covers.
- Force loss exceeding insurance; verify ADL kicks in deterministically.
- Top up from treasury; verify routing math at boundaries.

---

## Phase Q — Referral Program

**Goal**: Pay 10% of taker fees to whoever referred the trader. Standard CEX
mechanic, low effort.

### Q.1 — Referral storage
- Add `DataKey::Referrer(Address)` in vault (or a new `stellax-referrals`
  contract). Stored once, immutable per user.
- Set on first vault deposit by passing optional `referrer: Option<Address>`.
- Referral codes: off-chain mapping from short codes (e.g. "ALICE99") to
  Stellar addresses, stored in indexer DB.

### Q.2 — Fee splitting in treasury
- When `treasury.collect_fee(trader, amount)` is called, look up
  `referrer(trader)` from vault.
- If present, route 10% of fee to referrer's vault free balance (USDC).
- Remaining 90% goes through normal 60/20/20 split.

### Q.3 — Referrer tiers (optional)
- Tier by total referred volume:
  - Bronze (< $100k): 10%
  - Silver ($100k–$1M): 15%
  - Gold (> $1M): 20%
- Track referred-volume in indexer; treasury reads it via cross-contract or
  governance updates the tier per address.

### Q.4 — Frontend
- New `pages/ReferralPage.tsx`: shows your code, referred users, lifetime
  earnings, tier progress.
- Referral capture: URL query param `?ref=ALICE99` stored in localStorage,
  applied on next deposit.

### Q.5 — Indexer
- New events: `ReferralSet`, `ReferralPaid`. Indexer aggregates per referrer
  for the dashboard.

### Q.6 — Tests
- User deposits with referral code, opens trade, closes. Verify referrer
  vault balance increased by 10% of taker fee.
- Self-referral rejected.
- Referrer change attempt rejected (immutable after first set).

---

## Phase R — Advanced Order Types

**Goal**: Beyond Market/Limit/SL/TP, add TWAP, Bracket, Trailing Stop, and
Iceberg orders. Most logic lives in the keeper; on-chain only stores the
parent order intent.

### R.1 — TWAP orders
- New `OrderType::Twap { total_size, slice_count, interval_secs }` variant in
  `stellax-perp-engine`'s `OrderType` enum.
- Stored as a single PendingOrder; keeper executes a slice each interval.
- On-chain: `execute_twap_slice(parent_id, slice_idx)` callable by keeper.
- Each slice updates `executed_size`; when full, status → Filled.

### R.2 — Bracket orders
- Atomic combo: entry order + stop-loss + take-profit, all related.
- New `BracketOrder { entry, sl, tp }` struct stored together.
- On entry fill, SL and TP are auto-promoted to active conditional orders.
- On either SL or TP fill, the other is auto-cancelled (OCO logic).

### R.3 — Trailing stop
- `OrderType::TrailingStop { trail_distance_bps }`.
- Keeper tracks the high-water mark (for longs) and re-evaluates trigger
  price each ledger.
- On-chain stores only `trigger_price`; keeper updates it via `update_trigger`
  entry point (admin-keeper only).

### R.4 — Iceberg orders
- CLOB-native: a parent limit order with `visible_size < total_size`. CLOB
  shows only `visible_size` to other traders.
- After a fill consumes the visible slice, the next slice is exposed.
- Implementation: extend `LimitOrder` with `visible_size: Option<i128>` and
  `parent_order_id: Option<u64>` for child slices.

### R.5 — Keeper additions
- New worker `advanced-order-engine.ts` runs every ledger:
  - Iterate all PendingOrders, evaluate trigger conditions.
  - Submit `execute_order` for triggered ones.
  - Update trailing stops.
  - Slice TWAP parents.

### R.6 — Frontend
- `OrderForm.tsx` gets a "Order Type" dropdown beyond Market/Limit:
  TWAP, Bracket, Trailing Stop, Iceberg.
- Each shows the relevant extra fields.
- Position table displays parent + child slices for TWAP/Iceberg.

### R.7 — Tests
- TWAP: open 100 BTC over 10 slices in 10 minutes; verify slices fired on schedule.
- Bracket: entry fills, market moves to TP price, TP fills, SL auto-cancels.
- Trailing: long entered at $100, trail 5%, price rises to $120, drops to $114
  → triggers (5% off the $120 high).
- Iceberg: parent 100 BTC, visible 10 BTC; verify each fill exposes next slice.

---

## Phase S — Sub-Accounts / Master Wallet

**Goal**: One Stellar key controls N logically-separate trading accounts.
Critical for market makers running multiple strategies.

### S.1 — Sub-account derivation
- A sub-account is identified by `(master_address, sub_id: u32)`.
- All vault and position storage keys augmented to include `sub_id`.
- `sub_id = 0` is the master (default, backwards-compatible with V2).

### S.2 — Vault changes
- Storage keys re-keyed: `Balance(Address, AssetSymbol, sub_id)`.
- Migration: on first read for a `sub_id != 0`, lazy-init from zero.
- Master address authorises all sub-account actions (no separate keys per sub).
- Add transfer entry point: `transfer_between_subs(from_sub, to_sub, asset, amount)`.

### S.3 — Perp / risk / clob changes
- Position struct gains `sub_id: u32`.
- Position queries by user filter on `(user, sub_id)`.
- CLOB orders carry `sub_id` in the canonical signed payload.
- Risk health is computed per `(user, sub_id)`.

### S.4 — Frontend
- Top-bar account switcher: "Master | Sub 1 | Sub 2 | + New Sub".
- Each sub has its own positions list, balance, P&L history.
- Internal-transfer modal for moving funds between subs.

### S.5 — SDK
- `Client` accepts an optional `subId` field in invoke options; injected into
  every contract call.

### S.6 — Tests
- Create 3 subs, deposit into each, open separate positions.
- Liquidation on sub 1 doesn't touch sub 2.
- Transfer between subs preserves total balance.
- Old V2 users (sub_id 0) continue working unchanged.

---

## Phase T — Spot Trading on the CLOB

**Goal**: Extend the CLOB to settle direct token-to-token swaps, not just
perp position changes. Leverages existing infrastructure for a new product.

### T.1 — Order extension
- `LimitOrder` gains `kind: OrderKind` enum: `Perp` (existing) or `Spot { base_asset, quote_asset }`.
- For Spot orders, no perp position is created; instead vault balances move:
  buyer's quote → seller, seller's base → buyer.

### T.2 — CLOB settlement extension
- `settle_matched_orders` branches on `OrderKind`:
  - Perp → existing `execute_clob_fill`.
  - Spot → new `vault.atomic_swap(buyer, seller, base_asset, quote_asset, base_amount, quote_amount)`.
- Vault gets a new `atomic_swap` admin-CLOB-only entry point that does both
  legs atomically.

### T.3 — Spot pairs registry
- Admin-managed list of allowed spot pairs (e.g. USDC/XLM, USDC/BENJI,
  XLM/BENJI). Prevents arbitrary asset spoofing.
- Stored under `DataKey::SpotPair(base, quote)` in CLOB.

### T.4 — Stellar DEX bridge (optional / advanced)
- Stellar Classic has its own DEX with deep XLM/USDC liquidity. Add a
  keeper that mirrors top-of-book from Stellar DEX into the StellaX CLOB,
  arbitraging the spread. This routes Stellar DEX liquidity into our orderbook
  without users ever leaving the StellaX UI.

### T.5 — Frontend
- New `pages/SpotPage.tsx` mirroring TradePage layout but for spot pairs.
- Or unify under TradePage with a "Perp / Spot" tab switcher.

### T.6 — Tests
- Place buy USDC/XLM, sell USDC/XLM, settle. Vault balances move atomically.
- No-position-created assertion on perp engine after spot fill.
- Cross-product orderbook isolation: BTC-PERP order can't match a USDC/XLM order.

---

## Phase U — Lending / Yield on Idle Collateral

**Goal**: USDC sitting idle in the vault (not locking margin) earns yield by
being lent out. Comparable to GMX's GLP or Aave's pool.

> **High-effort, audit-critical phase.** Treat as a standalone product line.

### U.1 — Architecture choice
- **Option A — internal lending pool**: build a dedicated `stellax-lending`
  contract that vault routes idle balances into. Borrowers (in time, perp
  traders themselves) draw against it.
- **Option B — integrate with existing Stellar lending**: e.g. Blend Capital
  has a Soroban lending protocol. Vault deposits idle USDC there; collects
  yield; withdraws on demand.
- **Recommendation**: Option B first (faster, less audit surface), then build
  Option A later for fee capture.

### U.2 — Vault hook
- Track `idle_balance(asset) = total_balance(asset) - locked_margin(asset)`
  per user.
- Aggregate idle balances per asset across all users.
- Configurable `utilisation_target` (e.g. 70%): keep 30% liquid for
  withdrawals/margin demands; lend the rest.
- `rebalance()` admin entry point invoked by keeper periodically.

### U.3 — Yield distribution
- Yield accrues to a per-asset pool.
- Distribute pro-rata to depositors based on their idle balance × time.
- Snapshot mechanism: track each user's cumulative idle-balance-time integral.
- Add `claim_yield(user)` entry point.

### U.4 — Withdrawal liquidity
- If withdrawal requested > liquid buffer: trigger withdrawal from lending
  protocol synchronously.
- If lending protocol is illiquid (Aave-style "utilisation > 100% queued"):
  fall back to forcing the user to wait, with clear UI signal.
- Maintain reserve floor: never lend more than 90% of total deposits.

### U.5 — Risk: counterparty exposure
- Lending introduces counterparty risk on the lending protocol.
- Insurance fund partially covers (governance-set ratio).
- Add a per-protocol cap (e.g. max $5M to Blend) to prevent concentration.

### U.6 — Frontend
- Vault page shows two lines per asset: "In trading" + "Earning N% APR".
- Toggle: "Auto-yield ON/OFF". OFF means pure idle, no lending.

### U.7 — Tests + audit
- All flows including emergency withdrawal under partial illiquidity.
- Re-entrancy: external lending call must use checks-effects-interactions.
- Audit by external firm specifically for the lending integration.

---

## Phase V — Options Strategies (Spreads, Straddles, Delta-Neutral Vault)

**Goal**: Single-transaction multi-leg option positions. Currently each leg
requires a separate `write_option`/`buy_option` call.

### V.1 — Strategy templates
- New `stellax-options` entry points:
  - `open_call_spread(market, expiry, long_strike, short_strike, size)` —
    buy call at low strike, sell call at high strike.
  - `open_put_spread(market, expiry, long_strike, short_strike, size)`.
  - `open_straddle(market, expiry, strike, size)` — buy call + buy put at same strike.
  - `open_strangle(market, expiry, call_strike, put_strike, size)`.
- Each constructs N child option contracts in one tx.
- `Strategy { id, kind, child_options: Vec<u64> }` aggregator stored under
  `DataKey::Strategy(u64)`.

### V.2 — Margin treatment
- Risk engine treats a strategy as a single risk unit.
- E.g. a call spread has bounded loss = `(short_strike - long_strike) * size - net_debit`.
  Risk engine recognises this and demands only the bounded-loss margin, not
  the gross of both legs.
- Hardcode the recognised structures (call spread, put spread, straddle,
  strangle, iron condor) with closed-form max-loss formulae.

### V.3 — Delta-neutral structured vault
- New vault type in `stellax-structured`: deposit USDC, vault
  - sells weekly ATM straddles
  - hedges accumulated delta with perp positions every hour
  - distributes premium income to depositors at epoch close.
- Re-uses Phase E SVI surface for fair pricing.
- New keeper worker `dn-vault-roller.ts` rebalances hedge.

### V.4 — Frontend
- Options page gets a "Strategies" sub-tab with templates: Call Spread,
  Straddle, etc. with payoff diagrams (Recharts).
- Auto-suggest strikes based on current ATM and IV.
- Vaults page gets the new "Delta-Neutral Vault" tile.

### V.5 — Tests
- Open call spread: verify only `(short - long) * size - net_debit` margin
  required, not gross.
- Settle each leg at expiry: verify net P&L matches manual calculation.
- DN vault: simulate full epoch, verify hedge tracking error < threshold.

---

## Phase W — Stellar-Native Integrations

**Goal**: Tie StellaX into the broader Stellar ecosystem to capture native users.

### W.1 — AQUA liquidity mining
- AQUA (Aquarius DEX governance token) rewards Stellar liquidity providers.
- Strategy: stake LP receipts (e.g. STLX-USDC pool) on Aquarius for AQUA emissions.
- Treasury sells AQUA → USDC quarterly, adds to staker rewards (boosts STLX APR).
- Implementation: keeper worker `aqua-collector.ts` claims AQUA, swaps via
  Stellar DEX, calls `treasury.deposit_extra`.

### W.2 — SEP-24 fiat on-ramp
- Integrate one or two Stellar anchors (MoneyGram, Settle Network, Stellar
  Aid Assist, etc.) that support SEP-24.
- Frontend shows "Deposit USD" → opens anchor's hosted SEP-24 widget → user
  receives USDC on Stellar → auto-deposits into vault.
- No on-chain code change; pure frontend + anchor onboarding (legal).

### W.3 — Reflector as primary oracle for Stellar pairs
- For XLM/USD specifically, Reflector (decentralised Stellar-native oracle)
  may have better latency/stake quality than RedStone.
- Make oracle config per-asset configurable: `OracleSource::RedStone | Reflector | Hybrid`.
- For Hybrid, take median of the two.
- No new contract; just `oracle` config change.

### W.4 — Stellar wallet support
- Currently only Freighter. Add Lobstr (large Stellar mobile wallet),
  Albedo (web), Hana, Rabet.
- Use `@stellar/wallet-sdk` connector.
- Wallet sign-in for SEP-10 auth lets the indexer associate sessions with
  accounts (for personalised feeds / WebSocket notifications).

### W.5 — Tests
- AQUA collection cycle from staking → swap → distribute.
- SEP-24 deposit completes on testnet anchor.
- Reflector failover: simulate RedStone outage; verify oracle reads from
  Reflector and trade still executes.

---

## Phase X — Mobile + Telegram Bot

**Goal**: Reach mobile users (~70% of crypto traffic) without a full native app.

### X.1 — Frontend PWA
- The Vite frontend already runs on mobile browsers; promote to full PWA:
  service worker, manifest, install banner, push notifications.
- Bottom-tab navigation on mobile breakpoint.
- Compact orderbook + chart in single-column layout.

### X.2 — Telegram bot
- New package `packages/telegram-bot/`:
  - User links Stellar address via signed challenge.
  - Bot subscribes to indexer WebSocket for that address.
  - Push notifications: order filled, liquidation warning, funding paid,
    option expiry.
  - Slash commands: `/positions`, `/balance`, `/close <market>`, `/cancel <id>`.
- Trade execution: bot can either (a) read-only and prompt user to open the
  PWA to confirm, or (b) hold an authorised session key for one-tap close
  (require explicit opt-in due to risk).

### X.3 — Discord bot (parallel)
- Same logic as Telegram, different transport.
- Useful for trader communities.

### X.4 — Tests
- Manual user-flow: link account, place trade in PWA, get TG notification.
- Bot rate-limit handling.
- Notification deduplication (don't spam if same event arrives twice).

---

## Phase Y — RWA Perpetuals

**Goal**: Trade leveraged exposure to BENJI/USDY NAV. Marketed as the
first RWA perpetual market in DeFi. **Now demoable on testnet from day
one** because Phase M already wires real NAV feeds — no oracle blocker
remains for the testnet pitch.

> **Mainnet caveat**: launching real BENJI-PERP / USDY-PERP on mainnet
> still requires an issuer-signed NAV attestation chain for legal /
> regulatory comfort. On testnet the M.3 keeper-signed feed (RedStone +
> Ondo API) is the production-equivalent oracle.

### Y.1 — RWA NAV oracle (already solved on testnet by Phase M.3)
- Phase M.3 already pushes signed `BENJI/USD` and `USDY/USD` prices every
  10 minutes from RedStone + Ondo API. That same feed is the index price
  for the perp markets.
- **Mainnet hardening** (post-grant, parallel to issuer talks):
  - Add a second independent signer (Pyth or a custom Chainlink CCIP
    relay) and require 2-of-3 quorum.
  - Publish a public attestation schema so issuers can sign directly
    once partnerships close.
  - Document the oracle SLA in a dedicated audit annex.

### Y.2 — Market registration
- Once feed live: register `BENJI-PERP` and `USDY-PERP` markets in
  `stellax-perp-engine` via standard `register_market`.
- Conservative parameters: max leverage 3×, OI cap $250k, very high skew_scale
  (RWA volatility is tiny — fee should still penalise OI imbalance).

### Y.3 — Funding rate considerations
- For RWA perps, funding rate should converge to the difference between the
  perp price and the underlying yield curve.
- May need a custom funding factor per RWA market.

### Y.4 — Risk parameters
- Maintenance margin tighter for RWAs (less volatility, tighter liquidation).
- Insurance fund per-market sub-bucket since RWA black-swan events are
  qualitatively different (issuer halt) from crypto crashes.

### Y.5 — Frontend
- New market category "RWA" in Trade page market selector.
- Tooltips explaining RWA-specific risks (issuer redemption gate, NAV vs market
  price gap, etc.).

### Y.6 — Tests + audit
- Long BENJI-PERP, NAV ticks +0.01% daily, verify funding flows correct.
- Stress: simulate issuer halt — NAV feed pauses; ensure positions can be
  closed at last-known NAV with appropriate widened spreads.
- Full external audit before mainnet, as this is novel territory.

---

## Phase Z — V3 Testnet Hardening, Grant Submission, Mainnet Path

Phase Z is reframed: instead of "audit + mainnet rollout" it is now
**"testnet hardening + grant submission package + mainnet readiness plan"**.
Audit and mainnet rollout follow grant funding.

### Z.1 — Per-phase testing gate (testnet)
Each phase above has its own test list; this phase aggregates and adds
cross-phase scenarios on testnet:
- Isolated margin + sub-account interaction.
- Referral payouts with isolated and cross trades.
- Governance proposal upgrading insurance auto-growth thresholds.
- Spot trade + perp trade in the same tx (atomic batch).
- Lending pool drain attempt under heavy withdrawal pressure.
- **RWA-specific**: NAV staleness handling, yield drip during margin
  lock, mock-bridge round-trip, RWA-PERP funding rate convergence to
  yield-curve delta over a 7-day simulation.

### Z.2 — Grant submission package
Deliverables produced specifically for the ≥$100k grant pitch:
- **Live testnet URL** (`testnet.stellax.fi`) wired to all V3 phases.
- **90-second recorded demo video** walking the full RWA-collateral +
  RWA-perp flow.
- **Pitch deck** (10 slides, model already drafted) plus this V3 plan as
  the technical annex.
- **Public testnet block-explorer links** for every key transaction in
  the demo (deposit, trade, liquidation, yield credit, governance vote).
- **Open-source repo + reproducible setup script** (`make grant-demo`)
  that boots the full stack against testnet in <10 minutes.
- **Quantified traction metrics** from a 4-week public testnet beta:
  unique testnet wallets, total mock-RWA TVL, perp volume, options volume,
  bridge throughput, governance proposals passed.
- **Risk + compliance memo**: explicit list of what is mock vs real, plus
  the mainnet partnership roadmap for Franklin / Ondo / Stellar anchors.

Target grant tracks (apply to all in parallel):
| Track | Indicative size | Fit |
|---|---|---|
| Stellar Community Fund (SCF) — Build Award | $25k–$150k USDC | Direct fit; Soroban-native, RWA narrative |
| SDF Activation Award | up to $100k | Post-mainnet but milestone-gated; submit reservation now |
| Stellar RWA Initiative grants | $50k–$250k | Bullseye fit for RWA collateral + perps |
| External (Axelar, RedStone, Ondo ecosystem) | $10k–$50k each | Earned via integration deliverables |

### Z.3 — External audit scope (post-grant, pre-mainnet)
Funded by the first grant tranche:
- Mandatory: lending (U), governance (O), RWA perps (Y), advanced order types (R).
- Recommended: isolated margin (N), spot CLOB extension (T), strategy margin (V).
- Choose two reputable Soroban-experienced firms (not the same one twice).
- Audit budget reserved at ~$80–120k from grant proceeds.

### Z.4 — Bug bounty (post-audit, pre-mainnet)
- Open Immunefi-style program: $50k critical / $20k high / $5k medium.
- Bounty fund seeded from treasury (governance proposal).

### Z.5 — Mainnet rollout (post-grant, post-audit)
| Wave | Phases shipped | Trigger |
|---|---|---|
| Mainnet wave 0 | Existing V2 (A–K) | Audit clean + 1 month testnet stability + grant tranche received |
| Mainnet wave 1 | M (real BENJI/USDY), P, Q, S | Issuer partnerships closed (Franklin / Ondo authorisation of vault address) |
| Mainnet wave 2 | N, O, R, T, W | Mainnet wave 1 stable 30 days |
| Mainnet wave 3 | U, V, X | Lending audit clean |
| Mainnet wave 4 | Y (real RWA perp) | NAV oracle attestation chain signed by issuers |

### Z.6 — Communication & go-to-market
- One blog post per V3 phase shipped to testnet (drives grant evaluator
  attention).
- Public testnet leaderboard (top traders, top referrers) — gamifies the
  beta.
- Pin governance forum threads for each new parameter so token holders
  ultimately set them.
- Coordinate with Stellar Foundation on co-marketing for SEP-24 and AQUA
  integration launches.
- Reach out to Franklin Templeton and Ondo BD teams immediately upon
  grant award announcement — the funded testnet demo is the credibility
  artefact for those conversations.

---

## Appendix

### Cross-phase dependencies
| Phase | Depends on | Blocks |
|---|---|---|
| M (mock RWA collateral) | Vault `register_asset` (V1), oracle feed config (V1), new `stellax-rwa-issuer` admin contract for `credit_yield`, new `yield-simulator` keeper | Y (testnet RWA-PERP reuses M.3 feed) |
| N (isolated margin) | Vault sub-buckets | S (sub-accounts re-uses) |
| O (governance voting) | Staking (V2 Phase F), STLX SAC live | All param-tuning phases |
| P (insurance auto-growth) | Treasury (V1), Risk insurance (V1) | None |
| Q (referrals) | Treasury (V1), Vault (V1) | None |
| R (advanced orders) | CLOB (V2 Phase B), PendingOrder (V2 Phase B.5) | None |
| S (sub-accounts) | Vault key restructuring | All — best done early or it's a big migration |
| T (spot CLOB) | CLOB (V2 Phase B), Vault `atomic_swap` | None |
| U (lending) | Vault idle accounting | Audit (post-grant) |
| V (option strategies) | Options + SVI (V2 Phase E), Risk (V2 Phase C) | None |
| W (Stellar-native) | None — pure additive | None |
| X (mobile/TG) | Indexer (V2 Phase H) | None |
| Y (RWA perp on testnet) | M.3 NAV feed, M.4 yield drip | None on testnet; mainnet wave gated on issuer attestation |

### Recommended sequencing flowchart (testnet-first)
```
V2 testnet stable (today)
        │
        ├─── Sprint 1 (parallel) ─── M (mock RWA + real NAV + yield drip) ── P ── Q
        │
        ├─── Sprint 2 (parallel) ─── S ─ N ─ R ─ W (SEP-24/wallets) ─ X PWA
        │
        ├─── Sprint 3 (parallel) ─── O ─ T ─ V ─ Y (RWA-PERP on mock NAV)
        │
        └─── Sprint 4 ──────────── Z.2 grant package + public beta + demo recording
                                                                                  │
                                                                                  ▼
                                                                       Grant submission ($≥100k)
                                                                                  │
                                                                                  ▼
                                                  Audit (Z.3) → Mainnet rollout (Z.5) → U lending
```

### Storage migration risk register
| Phase | Storage change | Migration strategy |
|---|---|---|
| N | Vault adds `IsolatedMargin(Address, position_id)` | Lazy init; existing balances unaffected |
| S | All keys re-keyed with `sub_id` | Default `sub_id = 0` reads existing keys; no rewrite |
| O | Governor adds `Proposal` + `Vote` keys | Additive; old multisig actions still work |
| P | Insurance reads existing `RiskConfig` | Additive |
| T | CLOB orders gain `kind: OrderKind` | Old orders default to `Perp` via Option<>/None |
| U | Vault tracks `IdleBalance` integrals | Lazy init from current snapshot |
| V | Options adds `Strategy(u64)` | Additive |
| Y | Perp engine `register_market` for new IDs | Pure addition, no existing data touched |

### Contracts touched per phase (file paths)
| Phase | Soroban contracts | TS packages |
|---|---|---|
| M | new `stellax-rwa-issuer` (mock SAC + `credit_yield`), oracle, vault, bridge | new keeper `yield-simulator`, oracle-pusher (extend), bridge-keeper (extend), frontend (VaultsPage, DashboardPage RWA tile, faucet button), indexer (NAV history, yield events) |
| N | math (types), vault, perp-engine, risk | sdk, frontend (OrderForm, PositionsTable) |
| O | math (Proposal types), governor, staking | sdk (governorClient), frontend (GovernancePage) |
| P | risk, treasury | keeper (none), frontend (Dashboard) |
| Q | vault (or new stellax-referrals), treasury | indexer, frontend (ReferralPage) |
| R | math, perp-engine, clob | keeper (advanced-order-engine), frontend (OrderForm) |
| S | vault, perp-engine, risk, clob, options | sdk, frontend (account switcher) |
| T | math, vault, clob | sdk, frontend (SpotPage) |
| U | new stellax-lending OR vault hook | keeper (rebalancer), frontend (VaultsPage) |
| V | math, options, structured, risk | keeper (dn-vault-roller), frontend (Options Strategies tab) |
| W | oracle (config) | new keeper worker (aqua-collector), frontend (wallet connector, SEP-24 sandbox) |
| X | none | new packages/telegram-bot, frontend (PWA manifest) |
| Y | math, oracle (reuses Phase M.3), perp-engine, risk | keeper (rwa-nav-pusher uses M.3 feed), frontend (RWA market category) |

### Estimated headcount × duration per phase (testnet, grant-pitch scope)
| Phase | Engineers | Duration |
|---|---|---|
| M | 1 backend + 1 frontend (+ keeper) | 3 weeks (mock issuer + oracle + yield drip + UI) |
| N | 2 backend + 1 frontend | 4 weeks |
| O | 2 backend + 1 frontend | 4 weeks |
| P | 1 backend | 2 weeks |
| Q | 1 backend + 1 frontend | 2 weeks |
| R | 2 backend + 1 frontend | 4 weeks |
| S | 2 backend + 1 frontend | 4 weeks |
| T | 2 backend + 1 frontend | 3 weeks |
| U | 3 backend + 1 frontend + 1 auditor | **deferred** until grant tranche funds audit |
| V | 2 backend + 1 frontend | 5 weeks |
| W | 1 backend + 1 frontend | 3 weeks |
| X | 1 fullstack | 4 weeks |
| Y | 1 backend + 1 frontend (oracle reused from M.3) | 3 weeks (testnet); legal + 2nd-signer hardening deferred to mainnet wave |
| Z (grant package) | 1 fullstack + 1 designer | 2 weeks (recording, deck polish, repo cleanup) |

### Pre-grant-submission checklist additions per phase
For every phase, in addition to standard V2 testnet checks:
- New unit tests added under the relevant contract crate.
- New integration tests in `tests/tests/test_<phase>_*.rs`.
- New keeper worker has graceful-shutdown + retry logic.
- New frontend route has loading/error states + telemetry.
- `CONTRACT_VERSION` bumped on any changed contract.
- `deployments/testnet.json` updated; mainnet section left as `pending`.
- Governance proposal drafted (and passed on testnet) for any new parameter.
- Public testnet explorer link captured for the demo video.
- Phase entry added to the grant-package one-pager (Z.2).

---

*Total estimated V3 testnet implementation (grant-pitch ready): 8–12 weeks for 2–3 engineers + 1 designer.*
*Mainnet hardening + audit + rollout: additional 3–4 months post grant.*
*Critical path to grant pitch: M (mock RWA + real price + yield drip) → P → Q → frontend polish → recorded demo → submission.*
*Phases N, O, R, S, T, V, W, X, Y parallelisable on testnet — none gated on mainnet, audit, or external partnerships.*
*Phase U (lending) deliberately deferred until after the first grant tranche pays for its dedicated audit.*
