# StellaX

> **Stellar's first unified derivatives exchange.**
> Perpetual futures · On-chain options · Structured product vaults
> Built on Soroban with RedStone oracles and Axelar cross-chain interop.

[![CI](https://github.com/stellax-protocol/stellax/actions/workflows/ci.yml/badge.svg)](https://github.com/stellax-protocol/stellax/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE-MIT)

---

## Why StellaX

Stellar holds **$200M+ in DeFi TVL** and **$937M+ in tokenized real-world assets**, yet there is **no production derivatives venue** on the network. StellaX closes that gap with three products under one roof:

| Product | Market | Status |
| --- | --- | --- |
| Perpetual futures | XLM, BTC, ETH, SOL with up to 50× leverage | Phase 4 |
| European options | Cash-settled calls and puts priced on-chain via Black-Scholes | Phase 7 |
| Structured vaults | Covered calls, cash-secured puts, principal-protected RWA notes | Phase 8 |

All products share a unified, multi-asset collateral vault that accepts USDC, XLM, and tokenized US-Treasury RWAs (BENJI, USDY).

## Architecture

```
                ┌────────────────────────────┐
                │  Frontend (React + Vite)   │
                └─────────────┬──────────────┘
                              │
                ┌─────────────▼──────────────┐
                │  TypeScript SDK            │
                └─────────────┬──────────────┘
                              │ Soroban RPC
   ┌──────────────────────────┼─────────────────────────────┐
   │                          │                             │
┌──▼──────────┐  ┌────────────▼─────────┐  ┌────────────────▼──────────┐
│ stellax-    │  │ stellax-perp-engine  │  │ stellax-options           │
│ oracle      │  │  (vAMM, positions)   │  │  (Black-Scholes, expiry)  │
│ (RedStone)  │  └──────────┬───────────┘  └────────────┬──────────────┘
└─────────────┘             │                           │
                ┌───────────▼─────────┐    ┌────────────▼────────────┐
                │ stellax-funding     │    │ stellax-structured      │
                │  (rate engine)      │    │  (vault strategies)     │
                └─────────┬───────────┘    └────────────┬────────────┘
                          │                             │
                ┌─────────▼─────────────────────────────▼─────────┐
                │ stellax-vault (USDC, XLM, RWA collateral)       │
                └────────────────────────┬────────────────────────┘
                                         │
                          ┌──────────────▼─────────────┐
                          │ stellax-risk (margin,      │
                          │ liquidations, insurance)   │
                          └──────────────┬─────────────┘
                                         │
                ┌────────────────────────▼─────────────────────────┐
                │ stellax-bridge (Axelar GMP + ITS)                │
                └──────────────────────────────────────────────────┘
```

## Repository layout

```
contracts/
  stellax-math/         shared fixed-point math library (rlib)
  stellax-oracle/       RedStone oracle adapter
  stellax-vault/        multi-asset collateral
  stellax-perp-engine/  perpetual futures
  stellax-funding/      funding rate engine
  stellax-risk/         margin & liquidations
  stellax-options/      options pricing & lifecycle
  stellax-structured/   structured product vaults
  stellax-bridge/       Axelar cross-chain
  stellax-governor/     governance & upgrades
  stellax-treasury/     fees & insurance fund
packages/
  sdk/                  TypeScript SDK
  keeper/               off-chain bots (price push, liquidations, funding)
  frontend/             React trading interface and landing page
scripts/                deployment helpers
tests/                  cross-contract integration suites
implementation.md       full 16-phase engineering plan
```

## Quick start

```bash
# Install toolchain (Rust 1.84, wasm32v1-none target, stellar CLI 26)
make install

# Build all contracts
make build

# Run unit tests
make test

# Optimize WASMs for deployment
make optimize

# Deploy to testnet
make deploy-testnet
```

## Status

This repository is in active development. The full implementation roadmap is in [`implementation.md`](./implementation.md). Current phase progress:

- [x] Phase 0 — Toolchain and project scaffolding
- [ ] Phase 1 — Fixed-point math library
- [ ] Phase 2 — RedStone oracle integration
- [ ] Phase 3 — Collateral vault
- [ ] Phase 4 — Perpetual futures engine
- [ ] Phase 5 — Funding rate engine
- [ ] Phase 6 — Risk engine and liquidations
- [ ] Phase 7 — Options engine
- [ ] Phase 8 — Structured product vaults
- [ ] Phase 9 — Axelar cross-chain bridge
- [ ] Phase 10 — Governance and treasury
- [ ] Phase 11 — Keeper infrastructure
- [ ] Phase 12 — Frontend application
- [ ] Phase 13 — Integration testing and security
- [ ] Phase 14 — Testnet deployment
- [ ] Phase 15 — Mainnet deployment

## License

Dual-licensed under MIT or Apache 2.0 at your option.
