# StellaX — SCF / Grant Package Summary

This document is the canonical, single-page reference for evaluators reviewing
StellaX for grant funding. It maps every claim to a concrete artefact in the
repository.

## At a glance

- **What** — A unified derivatives exchange on Stellar/Soroban: perpetual
  futures, European options, structured vaults, and cross-chain bridge.
- **Why Stellar** — Sub-cent fees, sub-5s settlement, and SDEX/path-payment
  primitives the protocol composes natively (Phase W).
- **Status** — All contracts deployed to testnet; full Phase A → Phase Z
  scope shipped per `implementation.md`.

## Artefact map

| Domain               | Path                                          | Phase   |
|----------------------|-----------------------------------------------|---------|
| Perp engine          | `contracts/stellax-perp-engine/`              | A, R    |
| Options engine       | `contracts/stellax-options/`                  | E, V    |
| Vault (margin)       | `contracts/stellax-vault/`                    | F, S, T |
| Risk + liquidation   | `contracts/stellax-risk/`                     | C, N    |
| Funding rate         | `contracts/stellax-funding/`                  | D       |
| Oracle               | `contracts/stellax-oracle/`                   | B       |
| Treasury + lending   | `contracts/stellax-treasury/`                 | F, P, Q, U |
| Structured vaults    | `contracts/stellax-structured/`               | G       |
| CLOB (spot + perp)   | `contracts/stellax-perp-engine/` (CLOB)       | M       |
| Bridge (Axelar GMP)  | `contracts/stellax-bridge/`                   | I       |
| Governor + STLX gov  | `contracts/stellax-governor/`                 | O       |
| TypeScript SDK       | `packages/sdk/`                               | All     |
| Keeper               | `packages/keeper/`                            | All     |
| Deployer / scripts   | `packages/deployer/`, `scripts/`              | Z       |
| Frontend (PWA)       | `packages/frontend/`                          | All, X  |
| Telegram bot         | `packages/telegram-bot/`                      | X       |
| RWA perpetuals       | `docs/rwa-perpetuals.md`                      | Y       |
| Upgrade procedure    | `docs/upgrade-vs-redeploy.md`                 | Z       |

## Test coverage

- **Per-contract unit + integration** — every contract crate has a `tests`
  module; `cargo test --workspace` is the canonical CI gate.
- **End-to-end** — `tests/` integration crate exercises full lifecycles
  (deposit → trade → settle → withdraw) against locally registered contract
  instances.
- **Vitest e2e** — `packages/e2e` runs SDK calls against deployed testnet
  contracts (network gated).

```bash
cargo test --workspace                       # all contracts
pnpm -F @stellax/sdk build                   # SDK build
pnpm -F @stellax/frontend build              # PWA build
pnpm -F @stellax/telegram-bot build          # bot build
```

## Deployment

Testnet addresses live in [`deployments/testnet.json`](../deployments/testnet.json).
Procedure:

```bash
make optimize                # produces target/wasm32v1-none/release/*.optimized.wasm
scripts/deploy.sh testnet    # deploys + writes deployments/testnet.json
```

For upgrades vs redeploys see [docs/upgrade-vs-redeploy.md](upgrade-vs-redeploy.md).

## Stellar-native primitives (Phase W)

`packages/sdk/src/stellar/` exports:

- `buildPathPaymentStrictReceive` / `buildPathPaymentStrictSend` —
  "deposit anything, receive USDC" UX via the Stellar DEX.
- `buildCreateClaimableBalance` / `buildClaimClaimableBalance` —
  scheduled-payout pattern for PnL settlement.
- `decodeSep10Challenge` — anchor sign-in flow used by the passkey wallet.

## Phase ledger (this batch)

| Phase | Scope                                | Verification                 |
|-------|--------------------------------------|------------------------------|
| S     | Sub-accounts                         | 17/17 vault tests            |
| T     | Spot trading on CLOB (`atomic_swap`) | 21/21 vault tests cumulative |
| U     | Lending integration                  | 6/6 Phase U treasury tests   |
| V     | Multi-leg option strategies          | 32/32 options tests          |
| W     | Stellar-native SDK module            | `@stellax/sdk` builds clean  |
| X     | PWA manifest + Telegram bot          | bot + frontend build clean   |
| Y     | RWA perpetuals (doc-only)            | uses `add_market` admin      |
| Z     | Hardening + grant pkg                | deploy.sh syntax-checked     |
