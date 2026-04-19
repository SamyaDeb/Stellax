# StellaX — Implementation Plan

## From Scratch to Production: A Senior Blockchain Engineer's Blueprint

> **Protocol**: StellaX — Unified Derivatives Exchange on Stellar/Soroban
> **Products**: Perpetual Futures, On-Chain Options, Structured Product Vaults
> **Integrations**: RedStone Oracle (push + pull), Axelar Cross-Chain (GMP + ITS)
> **Collateral**: USDC, XLM, RWA tokens (BENJI/FOBXX, USDY)
> **Target**: Stellar Mainnet (Protocol 23+, Soroban)

---

## Table of Contents

- [Phase 0 — Environment, Toolchain, and Project Scaffolding](#phase-0--environment-toolchain-and-project-scaffolding)
- [Phase 1 — Fixed-Point Math Library](#phase-1--fixed-point-math-library)
- [Phase 2 — Oracle Infrastructure (RedStone Integration)](#phase-2--oracle-infrastructure-redstone-integration)
- [Phase 3 — Collateral Vault System](#phase-3--collateral-vault-system)
- [Phase 4 — Perpetual Futures Engine](#phase-4--perpetual-futures-engine)
- [Phase 5 — Funding Rate Engine](#phase-5--funding-rate-engine)
- [Phase 6 — Risk Engine and Liquidation System](#phase-6--risk-engine-and-liquidation-system)
- [Phase 7 — Options Engine](#phase-7--options-engine)
- [Phase 8 — Structured Product Vaults](#phase-8--structured-product-vaults)
- [Phase 9 — Cross-Chain Bridge (Axelar GMP + ITS)](#phase-9--cross-chain-bridge-axelar-gmp--its)
- [Phase 10 — Governance and Treasury](#phase-10--governance-and-treasury)
- [Phase 11 — Keeper Infrastructure (Off-Chain Services)](#phase-11--keeper-infrastructure-off-chain-services)
- [Phase 12 — Frontend Application](#phase-12--frontend-application)
- [Phase 13 — Integration Testing and Security](#phase-13--integration-testing-and-security)
- [Phase 14 — Testnet Deployment and Stress Testing](#phase-14--testnet-deployment-and-stress-testing)
- [Phase 15 — Mainnet Deployment and Launch Operations](#phase-15--mainnet-deployment-and-launch-operations)
- [Appendix A — Contract Dependency Graph](#appendix-a--contract-dependency-graph)
- [Appendix B — Storage Strategy Reference](#appendix-b--storage-strategy-reference)
- [Appendix C — Soroban Resource Budget Per Operation](#appendix-c--soroban-resource-budget-per-operation)
- [Appendix D — Key External References](#appendix-d--key-external-references)

---

## Phase 0 — Environment, Toolchain, and Project Scaffolding

**Estimated Duration**: 3–5 days
**Dependencies**: None (starting point)

### 0.1 — Install Development Toolchain

1. Install Rust toolchain via `rustup` (minimum version: 1.84.0). Confirm with `rustc --version`.
2. Add the Soroban WASM compilation target: `wasm32v1-none`. This replaced the older `wasm32-unknown-unknown` target starting with Protocol 23.
3. Install Stellar CLI v26.0.0 via Homebrew (`brew install stellar-cli`) or Cargo (`cargo install --locked stellar-cli@26.0.0`). Confirm with `stellar --version`.
4. Install Docker (required for reproducible WASM builds and local Stellar node).
5. Install Node.js 20+ and npm (for frontend, TypeScript tests, and RedStone connector).
6. Install `wasm-opt` from Binaryen for WASM optimization (called by `stellar contract optimize`).

### 0.2 — Create Workspace and Project Structure

1. Initialize the Rust workspace using `stellar contract init stellax`.
2. Restructure into a multi-contract workspace. The root `Cargo.toml` must use `resolver = "2"` and declare `members = ["contracts/*"]`.
3. Create the following contract crate directories, each with its own `Cargo.toml`, `src/lib.rs`, and `src/test.rs`:
   - `contracts/stellax-math` — shared fixed-point math library (not a contract, a library crate)
   - `contracts/stellax-oracle` — RedStone price feed adapter
   - `contracts/stellax-vault` — multi-asset collateral manager
   - `contracts/stellax-perp-engine` — perpetual futures core
   - `contracts/stellax-funding` — funding rate calculator
   - `contracts/stellax-risk` — margin calculator + liquidation engine
   - `contracts/stellax-options` — options pricing and lifecycle
   - `contracts/stellax-structured` — structured product vaults
   - `contracts/stellax-bridge` — Axelar GMP/ITS integration
   - `contracts/stellax-governor` — protocol admin and governance
   - `contracts/stellax-treasury` — fee collection and distribution
4. Create a `packages/` directory for TypeScript components:
   - `packages/keeper` — off-chain oracle pusher, liquidation bot, funding rate updater
   - `packages/sdk` — TypeScript SDK for programmatic trading
   - `packages/frontend` — React trading interface
5. Create an `scripts/` directory for deployment and migration scripts.
6. Create a `tests/` directory for cross-contract integration tests.

### 0.3 — Configure Workspace Dependencies

1. Set workspace-level dependencies in root `Cargo.toml`:
   - `soroban-sdk = "22"` (current stable)
   - `soroban-token-sdk = "22"` (for SEP-41 token interactions)
   - `redstone = { git = "https://github.com/redstone-finance/rust-sdk", tag = "3.0.0", features = ["soroban"] }` (oracle SDK)
2. Each contract's `Cargo.toml` should set:
   - `crate-type = ["cdylib"]` under `[lib]` (required for WASM compilation)
   - `doctest = false` under `[lib]`
   - Dev dependencies: `soroban-sdk = { workspace = true, features = ["testutils"] }`
3. Set the release profile in root `Cargo.toml` for minimal WASM size:
   - `opt-level = "z"`, `overflow-checks = true`, `debug = 0`, `strip = "symbols"`, `panic = "abort"`, `codegen-units = 1`, `lto = true`
4. The `stellax-math` crate must NOT be `cdylib` — it is a standard Rust library (`lib`) consumed by other contract crates as a dependency via `path = "../stellax-math"`.

### 0.4 — Configure Stellar Network Identities

1. Generate a testnet keypair: `stellar keys generate stellax-deployer --network testnet --fund`.
2. Generate additional test accounts for multi-user testing: `stellax-trader-1`, `stellax-trader-2`, `stellax-keeper`, `stellax-admin`.
3. Store network configuration in `environments.toml` for the Scaffold Stellar tooling or equivalent config file.
4. Verify testnet connectivity: `stellar contract invoke` on any existing testnet contract to confirm RPC access.

### 0.5 — CI/CD Pipeline Setup

1. Configure GitHub Actions workflow:
   - On every push: `cargo test` (runs all unit tests), `stellar contract build` (compiles all WASMs), `cargo clippy` (linting).
   - On PR merge to `main`: build + optimize WASMs, run integration tests, archive WASM artifacts.
2. Add a Makefile or `justfile` with common commands:
   - `build` — compile all contracts
   - `test` — run all unit tests
   - `optimize` — optimize all WASM binaries via `stellar contract optimize`
   - `deploy-testnet` — deploy all contracts to testnet in dependency order
   - `deploy-mainnet` — deploy all contracts to mainnet (with confirmation prompt)
3. Set up pre-commit hooks: `cargo fmt --check`, `cargo clippy -- -D warnings`.

### 0.6 — Define Shared Types and Constants

1. In `stellax-math/src/lib.rs`, define the protocol-wide constants:
   - `PRECISION: i128 = 1_000_000_000_000_000_000` (10^18, for 18-decimal fixed-point)
   - `PRICE_PRECISION: i128 = 10_000_000` (10^7, matching Stellar's standard 7-decimal places)
   - `PERCENT_PRECISION: i128 = 1_000_000` (10^6, for basis points with sub-bps precision)
   - `MAX_LEVERAGE: u32 = 50`
   - `LIQUIDATION_THRESHOLD_BPS: u32 = 9000` (90% — position liquidated when margin < 10% of position)
   - `MAINTENANCE_MARGIN_BPS: u32 = 5000` (50%)
   - `MAX_FUNDING_RATE_PER_HOUR: i128` = 0.1% expressed in PRECISION
   - `DAY_IN_LEDGERS: u32 = 17280` (assuming 5-second ledger close)
   - `TTL_BUMP_PERSISTENT: u32 = 30 * DAY_IN_LEDGERS` (30 days)
   - `TTL_BUMP_INSTANCE: u32 = 7 * DAY_IN_LEDGERS` (7 days)
   - `TTL_BUMP_TEMPORARY: u32 = 1 * DAY_IN_LEDGERS` (1 day)
2. Define shared data types as `contracttype` structs in the math library or a shared `stellax-types` crate:
   - `Position { owner: Address, market_id: u32, size: i128, entry_price: i128, margin: i128, leverage: u32, is_long: bool, last_funding_idx: i128, open_timestamp: u64 }`
   - `Market { market_id: u32, base_asset: Symbol, quote_asset: Symbol, max_leverage: u32, maker_fee_bps: u32, taker_fee_bps: u32, max_oi_long: i128, max_oi_short: i128, is_active: bool }`
   - `PriceData { price: i128, timestamp: u64, confidence: u32 }`
   - `OptionContract { option_id: u64, strike: i128, expiry: u64, is_call: bool, size: i128, premium: i128, writer: Address, holder: Address, is_exercised: bool }`
   - `VaultEpoch { epoch_id: u32, start_time: u64, end_time: u64, total_deposits: i128, total_premium: i128, settled: bool }`

---

## Phase 1 — Fixed-Point Math Library

**Estimated Duration**: 5–7 days
**Dependencies**: Phase 0
**Contract**: `stellax-math` (library crate, not deployed)

### 1.1 — Core Arithmetic Operations

1. Implement `mul_div(a: i128, b: i128, denominator: i128) -> i128` — the fundamental building block for fixed-point multiplication. Must handle intermediate overflow by using a wider representation or checked arithmetic. This single function underpins every financial calculation in the protocol.
2. Implement `mul_precision(a: i128, b: i128) -> i128` — multiplies two 18-decimal fixed-point numbers: `a * b / PRECISION`.
3. Implement `div_precision(a: i128, b: i128) -> i128` — divides two 18-decimal fixed-point numbers: `a * PRECISION / b`.
4. Implement `to_precision(value: i128, from_decimals: u32, to_decimals: u32) -> i128` — converts between decimal representations (e.g., USDC 6-decimal to 18-decimal internal representation, Stellar native 7-decimal to 18-decimal).
5. Implement overflow-checked variants of all operations. Soroban's `overflow-checks = true` in release profile provides runtime panics, but explicit checked math gives cleaner error handling.

### 1.2 — Advanced Math Functions

1. Implement `pow(base: i128, exponent: u32) -> i128` — integer exponentiation for fixed-point numbers (used in funding rate formulas, borrow rate curves).
2. Implement `sqrt_fixed(x: i128) -> i128` — square root for fixed-point numbers using Newton's method (Babylonian method). Required for Black-Scholes volatility calculations. Iterate until convergence: `next = (guess + x / guess) / 2`. Typically converges in 15–20 iterations for i128 precision.
3. Implement `exp_fixed(x: i128) -> i128` — exponential function approximation using Taylor series or rational polynomial approximation. Required for Black-Scholes `e^(-rT)` term. Truncate series at sufficient terms for 18-decimal precision (typically 20 terms).
4. Implement `ln_fixed(x: i128) -> i128` — natural logarithm approximation. Required for Black-Scholes `d1`/`d2` calculation. Use the identity `ln(x) = 2 * atanh((x-1)/(x+1))` with series expansion.
5. Implement `normal_cdf(x: i128) -> i128` — cumulative normal distribution function. This is the single most critical function for options pricing. Use the Abramowitz & Stegun rational polynomial approximation (error < 7.5e-8). The approximation requires `exp_fixed` and `sqrt_fixed` as building blocks.

### 1.3 — Percentage and Basis Point Utilities

1. Implement `apply_bps(value: i128, bps: u32) -> i128` — applies a basis point fee: `value * bps / 10000`.
2. Implement `apply_haircut(value: i128, haircut_bps: u32) -> i128` — reduces collateral value: `value * (10000 - haircut_bps) / 10000`.
3. Implement `clamp(value: i128, min: i128, max: i128) -> i128` — used for funding rate capping.

### 1.4 — Testing the Math Library

1. Write unit tests comparing every function against known values calculated externally (use Python's `decimal` module or Wolfram Alpha for ground truth).
2. Test edge cases: zero inputs, maximum i128 values, negative numbers, precision loss at boundaries.
3. Test `normal_cdf` against a reference table of standard normal distribution values at 0.01 increments from -4.0 to +4.0.
4. Fuzz test `mul_div` with random inputs to ensure no panics from overflow.
5. Benchmark execution cost: wrap each function in a minimal Soroban contract, deploy to testnet, call via `simulateTransaction`, and record CPU instruction consumption. This establishes the computational budget for trade execution.

---

## Phase 2 — Oracle Infrastructure (RedStone Integration)

**Estimated Duration**: 7–10 days
**Dependencies**: Phase 0, Phase 1
**Contract**: `stellax-oracle`

### 2.1 — Understand RedStone's Soroban Architecture

1. Study RedStone's Rust SDK (`redstone` crate, git tag `3.0.0` with `soroban` feature). The SDK provides `process_payload()` which verifies cryptographic signatures from RedStone data providers and extracts price data.
2. Study the two integration models:
   - **Pull model**: Price data is attached to the transaction by the user/keeper as a `Bytes` argument. The contract calls `process_payload()` to verify signatures and extract prices inline. No on-chain storage needed — prices are verified and consumed in the same transaction.
   - **Push model**: A keeper bot periodically calls a `write_prices()` function on the oracle contract. The contract calls `process_payload()`, verifies signatures, and writes `PriceData { price: U256, package_timestamp: u64, write_timestamp: u64 }` to Soroban Persistent storage. Other contracts read prices via cross-contract call.
3. Review RedStone's audit reports (Veridise and Zellic) to understand the security model and any known limitations.

### 2.2 — Implement the Push-Model Oracle Contract

1. Define the contract's storage keys:
   - `DataKey::Config` (Instance storage) — stores `OracleConfig { signers: Vec<BytesN<33>>, signer_count_threshold: u32, max_timestamp_staleness_ms: u64, admin: Address }`
   - `DataKey::Price(Symbol)` (Persistent storage) — stores `PriceData { price: i128, package_timestamp: u64, write_timestamp: u64 }` per asset symbol (e.g., `Symbol::new("BTC")`)
   - `DataKey::LastUpdate` (Instance storage) — stores the ledger sequence of the last price update
2. Implement the constructor (`__constructor`):
   - Accept `admin`, `signers` (list of authorized RedStone signer public keys), `signer_count_threshold` (minimum signers for validity, e.g., 3-of-5), `max_timestamp_staleness_ms` (e.g., 60000 for 60 seconds).
   - Store config in Instance storage.
   - Extend Instance TTL on initialization.
3. Implement `write_prices(payload: Bytes)`:
   - This is the keeper-called function. The `payload` argument contains RedStone-signed price data.
   - Call `process_payload()` from the RedStone SDK, passing the payload, expected signers, threshold, and list of feed IDs.
   - The SDK returns verified `(feed_id, price, timestamp)` tuples.
   - For each feed: convert the U256 price to i128 (checking for overflow), validate timestamp is within staleness window, write `PriceData` to Persistent storage keyed by asset symbol.
   - Extend TTL on all written price entries (minimum 1 day for Persistent storage).
   - Emit an event: `(Symbol::new("price_update"), asset_symbol, price, timestamp)`.
4. Implement `get_price(asset: Symbol) -> PriceData`:
   - Read from Persistent storage.
   - Validate that the price is not stale: `env.ledger().timestamp() - price.write_timestamp < max_staleness`.
   - If stale, panic with a descriptive error (callers must handle this — no silent stale prices).
   - Extend TTL on the read entry.
5. Implement `get_prices(assets: Vec<Symbol>) -> Vec<PriceData>`:
   - Batch read for efficiency. A single cross-contract call fetches multiple prices.
   - Same staleness validation per price.

### 2.3 — Implement the Pull-Model Oracle Support

1. Implement `verify_price_payload(payload: Bytes, feed_id: Symbol) -> PriceData`:
   - This function does NOT write to storage. It verifies the RedStone payload inline and returns the price.
   - Used by other contracts when they want to include fresh prices in the trade transaction itself (lower latency, no dependency on keeper uptime).
   - Same signature verification via `process_payload()`.
   - Validate timestamp staleness against the on-chain ledger timestamp.
2. Design the pull-model integration pattern for consuming contracts:
   - The calling contract (e.g., `stellax-perp-engine`) accepts an optional `price_payload: Bytes` argument on trade functions.
   - If provided: call `oracle.verify_price_payload(payload, feed_id)` — one cross-contract call.
   - If not provided: call `oracle.get_price(asset)` to read the last pushed price — also one cross-contract call.
   - This dual-path approach provides resilience: pull for low-latency trades, push as fallback.

### 2.4 — Implement Fallback Oracle (Reflector)

1. For XLM-native pairs, implement a fallback path to the Reflector oracle (Stellar-native, operated by validators).
2. Define a `FallbackConfig` that maps asset symbols to Reflector contract addresses.
3. In `get_price()`, if RedStone price is stale AND a Reflector fallback is configured for that asset, attempt to read from Reflector.
4. If both sources fail, panic with an explicit error — never return a stale price silently.
5. Emit a distinct event when fallback is used: `(Symbol::new("fallback_oracle"), asset, source)`.

### 2.5 — Admin Functions

1. Implement `update_config(new_config: OracleConfig)`: admin-only, updates signer list, thresholds, staleness window. Requires `admin.require_auth()`.
2. Implement `update_admin(new_admin: Address)`: transfers admin role. Two-step pattern recommended (propose + accept) but single-step acceptable for v1.
3. Implement `pause()` and `unpause()`: emergency stop for price feeds. When paused, `get_price()` always panics.

### 2.6 — Testing the Oracle

1. Unit tests using `soroban-sdk` testutils: create mock RedStone payloads (the SDK's test utilities allow constructing signed price data), verify extraction, staleness rejection.
2. Test the push flow end-to-end: call `write_prices`, then `get_price`, verify values match.
3. Test staleness: advance ledger timestamp past the staleness window, verify `get_price` panics.
4. Test fallback: configure Reflector fallback, make RedStone stale, verify Reflector price is returned.
5. Integration test with actual RedStone testnet data: use the `@redstone-finance/stellar-connector` npm package to fetch real signed payloads, submit them via `stellar contract invoke`, verify on-chain prices match expected values.

---

## Phase 3 — Collateral Vault System

**Estimated Duration**: 7–10 days
**Dependencies**: Phase 0, Phase 1, Phase 2
**Contract**: `stellax-vault`

### 3.1 — Design the Collateral Model

1. Define supported collateral types and their parameters:
   - USDC: haircut 0% (100% value), 6 decimals on Stellar
   - XLM: haircut 15% (85% value), 7 decimals native
   - BENJI (Franklin Templeton FOBXX): haircut 5% (95% value) — tokenized US Treasury money market fund
   - USDY (Ondo): haircut 5% (95% value) — yield-bearing stablecoin backed by US Treasuries
2. Define the `CollateralConfig` struct: `{ token_address: Address, decimals: u32, haircut_bps: u32, max_deposit_cap: i128, is_active: bool }`.
3. Design the margin mode system:
   - **Cross-margin**: all positions share the user's total collateral. One balance per user, positions draw from it.
   - **Isolated-margin**: each position has its own locked collateral. Deposited separately per position.
   - Store a per-user `MarginMode` flag in Persistent storage. Default: cross-margin.

### 3.2 — Implement Deposit and Withdrawal

1. Implement `deposit(user: Address, token: Address, amount: i128)`:
   - `user.require_auth()` — the user must authorize the deposit.
   - Validate the token is in the supported collateral list and is active.
   - Transfer tokens from user to the vault contract using the Stellar token interface: invoke the token contract's `transfer(from, to, amount)`.
   - Convert the deposited amount to internal 18-decimal representation using `to_precision(amount, token_decimals, 18)`.
   - Update the user's balance in Persistent storage: key = `(DataKey::Balance, user, token)`, value = existing + deposited amount.
   - Extend TTL on the balance entry (30 days minimum).
   - Emit event: `(Symbol::new("deposit"), user, token, amount)`.
2. Implement `withdraw(user: Address, token: Address, amount: i128)`:
   - `user.require_auth()`.
   - Check that the user's free collateral (total collateral minus locked margin) is sufficient for the withdrawal.
   - This requires a cross-contract call to `stellax-risk` to compute the user's current margin requirement.
   - Convert from internal 18-decimal back to token-native decimals.
   - Transfer tokens from vault to user.
   - Update balance in storage.
   - Emit event: `(Symbol::new("withdraw"), user, token, amount)`.
3. Implement `get_balance(user: Address, token: Address) -> i128`: read balance from storage, return in 18-decimal representation.
4. Implement `get_total_collateral_value(user: Address) -> i128`:
   - Read balances for all supported tokens.
   - For each: get price from oracle, apply haircut, compute value: `balance * price * (10000 - haircut) / 10000`.
   - Sum all values. Return in USD-equivalent 18-decimal representation.

### 3.3 — Implement Margin Locking

1. Implement `lock_margin(user: Address, position_id: u64, amount: i128)`:
   - Called by the perp engine or options engine when a position is opened.
   - Verify the caller is an authorized protocol contract (not a random user).
   - In cross-margin mode: deduct from the user's free collateral (no actual token transfer — just an accounting entry).
   - In isolated mode: lock specific collateral to a position ID.
   - Store locked amounts: key = `(DataKey::LockedMargin, user, position_id)`, value = amount.
2. Implement `unlock_margin(user: Address, position_id: u64, amount: i128)`:
   - Called when a position is closed or reduced.
   - Release the locked margin back to free collateral.
3. Implement `transfer_margin(from: Address, to_insurance: bool, amount: i128)`:
   - Called during liquidation to move margin from the liquidated user to the insurance fund or liquidator.
   - Internal transfer only — no external token movements.

### 3.4 — Implement the RWA Collateral Adapter

1. For RWA tokens (BENJI, USDY), verify compatibility with Soroban's token interface:
   - These tokens must implement the SEP-41 `TokenInterface` (or Stellar Classic `transfer` via SAC — Stellar Asset Contract).
   - If they are Classic Stellar assets, they are accessible on Soroban via SAC wrappers automatically.
   - Test on testnet: attempt to invoke `transfer` on the SAC address of a Classic asset. Confirm it works.
2. Handle the case where RWA tokens have transfer restrictions (e.g., allowlists):
   - The vault contract address must be allowlisted by the RWA issuer to receive transfers.
   - If not allowlisted, the deposit will fail at the token contract level — handle this gracefully with a clear error message.
   - Document this as a prerequisite: "StellaX vault must be allowlisted by RWA issuers."
3. For yield-bearing tokens (USDY accrues value over time):
   - The oracle price feed must reflect the current NAV, not a fixed $1.
   - Configure the oracle to fetch USDY's NAV price from RedStone.
   - The haircut already accounts for price volatility risk.

### 3.5 — Storage TTL Management

1. Every function that reads a user's balance must also extend the TTL:
   - `env.storage().persistent().extend_ttl(&key, TTL_BUMP_PERSISTENT, TTL_BUMP_PERSISTENT)`.
   - This ensures active users never have their balances archived.
2. For inactive users (no interaction for > 30 days):
   - Balances will be archived by the network but NOT deleted.
   - Protocol 23 enables automatic restoration: if a user interacts again, archived entries are restored as part of `InvokeHostFunction`.
   - Cost: the user pays restoration fees in the transaction. No protocol action needed.
3. For the contract instance itself:
   - Extend Instance TTL in every public function: `env.storage().instance().extend_ttl(TTL_BUMP_INSTANCE, TTL_BUMP_INSTANCE)`.

### 3.6 — Testing the Vault

1. Unit tests: deposit, withdraw, balance tracking, haircut application, insufficient balance rejection.
2. Test margin locking: deposit → lock → verify free collateral reduced → unlock → verify free collateral restored.
3. Test multi-asset: deposit USDC + XLM, verify total collateral value is weighted sum with haircuts.
4. Test RWA path: mock a SAC-wrapped Classic asset, deposit, verify handling.
5. Test TTL: use testutils to advance ledger, verify TTL extension prevents archival.

---

## Phase 4 — Perpetual Futures Engine

**Estimated Duration**: 12–15 days
**Dependencies**: Phase 1, Phase 2, Phase 3
**Contract**: `stellax-perp-engine`

### 4.1 — Design the Market System

1. Define the market registry: a map of `market_id: u32 -> Market` stored in Instance storage (markets are protocol-level config, not per-user).
2. Initial markets to configure:
   - Market 0: XLM-PERP (XLM/USD perpetual)
   - Market 1: BTC-PERP (BTC/USD perpetual)
   - Market 2: ETH-PERP (ETH/USD perpetual)
   - Market 3: SOL-PERP (SOL/USD perpetual)
3. Per-market parameters:
   - `max_leverage`: 50 for BTC/ETH, 20 for alts
   - `maker_fee_bps`: 2 (0.02%)
   - `taker_fee_bps`: 5 (0.05%)
   - `max_oi_long` / `max_oi_short`: maximum open interest caps per side (prevents excessive risk)
   - `min_position_size`: minimum notional value (e.g., $10)
   - `price_impact_factor`: controls vAMM price impact per trade

### 4.2 — Implement the Virtual AMM (vAMM)

1. The vAMM provides price discovery for perpetuals without requiring actual liquidity. It simulates an AMM curve to calculate price impact based on trade size.
2. Design choice: use a constant-product formula `x * y = k` where `x` and `y` are virtual reserves, and `k` determines market depth.
   - Larger `k` = less price impact per trade = deeper market.
   - `k` is a configurable parameter per market, set by governance.
3. Store vAMM state per market in Persistent storage:
   - `VammState { base_reserve: i128, quote_reserve: i128, k: i128, cumulative_premium: i128 }`
4. Implement `get_mark_price(market_id: u32) -> i128`:
   - `mark_price = quote_reserve / base_reserve` (in 18-decimal fixed-point).
   - This is the vAMM's implied price — different from the oracle's index price.
5. Implement price impact calculation:
   - For a long trade of size `delta_base`: new `quote_reserve = k / (base_reserve - delta_base)`. The effective entry price = `(new_quote - old_quote) / delta_base`.
   - For a short trade: symmetric.
   - The price impact penalizes large trades relative to market depth — this is a natural slippage mechanism.
6. Implement `update_k(market_id: u32, new_k: i128)`: admin function to adjust market depth. Used during initial calibration and ongoing governance.

### 4.3 — Implement Position Management

1. Position storage: Persistent storage keyed by `(DataKey::Position, user, position_id)`.
   - `position_id` is a protocol-wide monotonically increasing counter stored in Instance storage.
   - One user can have multiple positions (one per market in cross-margin mode, or multiple isolated positions).
2. Implement `open_position(user: Address, market_id: u32, size: i128, is_long: bool, leverage: u32, max_slippage_bps: u32, price_payload: Option<Bytes>) -> u64`:
   - `user.require_auth()`.
   - Validate: market is active, leverage <= market.max_leverage, size >= min_position_size.
   - Fetch oracle price: if `price_payload` is provided, verify via pull model. Otherwise, read from push model.
   - Calculate entry price via vAMM. Validate slippage: `|entry_price - oracle_price| / oracle_price <= max_slippage_bps`.
   - Calculate required margin: `notional_value / leverage` where `notional_value = size * entry_price`.
   - Cross-contract call to `stellax-vault.lock_margin(user, position_id, required_margin)`.
   - Cross-contract call to `stellax-risk.validate_new_position(user, market_id, size, margin, leverage)` — checks total account risk.
   - Update vAMM state (adjust reserves based on trade direction and size).
   - Read current funding index from `stellax-funding.get_accumulated_funding(market_id)`.
   - Store the position with `last_funding_idx = current_funding_index`.
   - Update market open interest: `oi_long += size` or `oi_short += size`. Check against caps.
   - Charge taker fee: deduct from margin, add to treasury via cross-contract call.
   - Emit event: `(Symbol::new("position_opened"), user, position_id, market_id, size, entry_price, leverage, is_long)`.
   - Return `position_id`.
3. Implement `close_position(user: Address, position_id: u64, price_payload: Option<Bytes>)`:
   - `user.require_auth()`.
   - Read position from storage.
   - Fetch current oracle price.
   - Calculate exit price via vAMM (reverse direction of open).
   - Settle accumulated funding: `funding_pnl = (current_funding_idx - position.last_funding_idx) * position.size`.
   - Calculate PnL: `pnl = (exit_price - entry_price) * size` (for longs; inverted for shorts) + funding_pnl.
   - Update user's collateral: `new_balance = margin + pnl`.
   - If PnL is negative and exceeds margin: the position is insolvent. Cap loss at margin (user loses entire margin). Remainder is the "bad debt" — covered by insurance fund.
   - Cross-contract call to `stellax-vault.unlock_margin(user, position_id, margin)`.
   - Cross-contract call to `stellax-vault` to credit/debit PnL.
   - Update vAMM state.
   - Update market open interest.
   - Charge maker fee.
   - Delete position from storage (or mark as closed if you want historical data — but this costs storage rent, so prefer deletion).
   - Emit event: `(Symbol::new("position_closed"), user, position_id, exit_price, pnl)`.
4. Implement `modify_position(user: Address, position_id: u64, action: ModifyAction)`:
   - `ModifyAction` enum: `AddMargin(i128)`, `RemoveMargin(i128)`, `PartialClose(i128)`.
   - `AddMargin`: increase margin, lock additional collateral, effectively reduce leverage.
   - `RemoveMargin`: decrease margin (increase leverage). Must validate new leverage <= max and position still above maintenance margin.
   - `PartialClose`: close a portion of the position. Calculate proportional PnL, reduce size, adjust margin proportionally.

### 4.4 — Implement the Two-Phase Execution Pattern (Optional Enhancement)

1. For maximum frontrunning protection, implement GMX-style request-execute:
   - Phase 1: User calls `create_order(user, market_id, size, is_long, leverage, order_type, trigger_price)`. Order stored in Temporary storage (auto-expires if not executed).
   - Phase 2: Keeper calls `execute_order(order_id, price_payload)` within a time window (e.g., 30 seconds). Fetches oracle price, validates trigger conditions, executes the trade.
2. Order types:
   - `Market`: execute immediately at current price.
   - `Limit`: execute only if oracle price reaches the trigger price.
   - `StopLoss`: close position if oracle price reaches stop level.
   - `TakeProfit`: close position if oracle price reaches profit target.
3. Store orders in Temporary storage (TTL = 1 day). Unexecuted orders automatically expire without consuming persistent storage rent.
4. This is an optional enhancement — for v1, direct execution (single-transaction) is acceptable, with the two-phase pattern added in a subsequent version for production robustness.

### 4.5 — Position Query Functions

1. Implement `get_position(user: Address, position_id: u64) -> Position`: read from storage, extend TTL.
2. Implement `get_unrealized_pnl(position_id: u64) -> i128`: calculate current PnL using latest oracle price without closing the position.
3. Implement `get_positions_by_user(user: Address) -> Vec<(u64, Position)>`: requires maintaining an index of position IDs per user in Persistent storage.
4. Implement `get_market_info(market_id: u32) -> MarketInfo`: returns market config + current OI + current funding rate + mark price.

### 4.6 — Testing the Perp Engine

1. Test full lifecycle: open → check PnL → close, for both longs and shorts, in profit and at loss.
2. Test vAMM price impact: large trades should move the mark price, verify the magnitude is proportional to `k`.
3. Test leverage enforcement: opening at leverage > max must fail.
4. Test margin locking: verify vault balance decreases on open, increases on close.
5. Test OI caps: verify rejection when open interest exceeds market cap.
6. Test slippage protection: set tight slippage, submit a large trade, verify rejection.
7. Test partial close: close 50% of a position, verify remaining position has correct size and proportional margin.
8. Stress test with multiple concurrent positions across multiple markets.

---

## Phase 5 — Funding Rate Engine

**Estimated Duration**: 5–7 days
**Dependencies**: Phase 1, Phase 2, Phase 4
**Contract**: `stellax-funding`

### 5.1 — Understand the Funding Rate Mechanism

1. Funding rates keep the perpetual's mark price (from vAMM) aligned with the oracle's index price (spot).
2. When mark > index (longs dominate): longs pay shorts, incentivizing shorts to enter and push mark down.
3. When mark < index (shorts dominate): shorts pay longs.
4. Formula: `funding_rate = clamp((mark_price - index_price) / index_price, -MAX_RATE, +MAX_RATE)`.
5. Funding is settled per-position, event-driven (on every position interaction), not by a cron job.

### 5.2 — Implement the Accumulated Funding Index

1. Store per-market `FundingState` in Persistent storage:
   - `accumulated_funding_long: i128` — cumulative funding per unit of long position size
   - `accumulated_funding_short: i128` — cumulative funding per unit of short position size
   - `last_update_timestamp: u64` — last time the index was updated
   - `last_funding_rate: i128` — the most recently calculated hourly rate (informational)
2. Implement `update_funding(market_id: u32)`:
   - Called by the keeper periodically (every hour) AND lazily before any position interaction.
   - Calculate time elapsed since last update.
   - Get mark price from vAMM, index price from oracle.
   - `premium = (mark_price - index_price) * PRECISION / index_price`.
   - `hourly_rate = clamp(premium * FUNDING_FACTOR, -MAX_FUNDING_RATE, +MAX_FUNDING_RATE)`.
   - `FUNDING_FACTOR` is a sensitivity multiplier (e.g., 1x means premium maps directly to rate; higher values make funding more aggressive).
   - Prorate: `accumulated_delta = hourly_rate * time_elapsed / 3600`.
   - `accumulated_funding_long += accumulated_delta`.
   - `accumulated_funding_short -= accumulated_delta`.
   - Update `last_update_timestamp`.
   - Extend TTL on storage entries.
3. Implement `settle_funding(position: Position) -> i128`:
   - Called before any PnL calculation on a position.
   - `funding_delta = current_accumulated_funding - position.last_funding_idx`.
   - `funding_pnl = funding_delta * position.size / PRECISION`.
   - Returns the funding PnL (positive = position receives funding, negative = position pays funding).
   - The caller (perp engine) must update the position's `last_funding_idx` after settlement.

### 5.3 — Implement Funding Rate Queries

1. Implement `get_current_funding_rate(market_id: u32) -> i128`: calculate the instantaneous funding rate without updating state (view function).
2. Implement `get_accumulated_funding(market_id: u32) -> (i128, i128)`: returns `(accumulated_long, accumulated_short)`.
3. Implement `estimate_funding_payment(position_id: u64) -> i128`: calculate what a position would pay/receive if settled now.

### 5.4 — Testing the Funding Engine

1. Test rate calculation: set mark > index, verify positive rate (longs pay shorts). Set mark < index, verify negative rate.
2. Test clamping: set extreme price divergence, verify rate is clamped to MAX.
3. Test accumulation: update funding multiple times, verify accumulated index grows linearly.
4. Test settlement: open a long, advance time by 1 hour, settle funding, verify deduction from margin.
5. Test event-driven settlement: open position, update funding 3 times, close position — verify total funding matches sum of intervals.
6. Test zero-rate: mark == index, verify rate is 0 and no funding exchanged.

---

## Phase 6 — Risk Engine and Liquidation System

**Estimated Duration**: 10–12 days
**Dependencies**: Phase 1, Phase 2, Phase 3, Phase 4, Phase 5
**Contract**: `stellax-risk`

### 6.1 — Design the Margin Calculation System

1. Define margin requirements per market:
   - `initial_margin_ratio`: `1 / max_leverage` (e.g., 2% for 50x leverage).
   - `maintenance_margin_ratio`: half of initial (e.g., 1% for 50x leverage). If margin falls below this, the position is liquidatable.
   - `liquidation_fee_bps`: 50 (0.5%) — penalty taken from the liquidated position's remaining margin.
2. Design the cross-margin calculation:
   - `total_collateral_value = sum(collateral_i * price_i * (1 - haircut_i))` across all deposited assets.
   - `total_unrealized_pnl = sum(unrealized_pnl_j)` across all open positions.
   - `total_pending_funding = sum(pending_funding_j)` across all open positions.
   - `account_equity = total_collateral_value + total_unrealized_pnl + total_pending_funding`.
   - `total_maintenance_margin = sum(position_notional_j * maintenance_margin_ratio_j)`.
   - `margin_ratio = account_equity / total_maintenance_margin`.
   - If `margin_ratio < 1.0`: the account is liquidatable.
3. For isolated margin:
   - Each position has its own locked margin.
   - `position_equity = locked_margin + unrealized_pnl + pending_funding`.
   - `position_maintenance = notional * maintenance_margin_ratio`.
   - If `position_equity < position_maintenance`: that specific position is liquidatable.

### 6.2 — Implement Margin Validation

1. Implement `validate_new_position(user: Address, market_id: u32, notional: i128, margin: i128, leverage: u32) -> bool`:
   - Called by the perp engine before opening a position.
   - Calculate the new total maintenance margin including the proposed position.
   - Calculate the new account equity (current equity minus the margin being locked for the new position).
   - Verify the account remains above initial margin (not just maintenance — you need initial margin to OPEN, maintenance to KEEP).
   - Return true if valid, panic if invalid (with descriptive error).
2. Implement `validate_withdrawal(user: Address, withdrawal_amount: i128) -> bool`:
   - Called by the vault before allowing a withdrawal.
   - Calculate account equity after withdrawal.
   - Verify it remains above initial margin for all open positions.
3. Implement `get_account_health(user: Address) -> AccountHealth`:
   - Returns: `{ equity: i128, total_margin_required: i128, margin_ratio: i128, free_collateral: i128, liquidatable: bool }`.
   - This is the primary function the frontend calls to display the user's risk status.

### 6.3 — Implement the Liquidation Engine

1. Implement `liquidate(keeper: Address, user: Address, position_id: u64, price_payload: Option<Bytes>)`:
   - `keeper.require_auth()` — anyone can be a liquidation keeper (permissionless).
   - Read the position and current oracle price.
   - Settle pending funding for the position.
   - Calculate the position's equity (margin + unrealized PnL + funding PnL).
   - Verify the position is indeed below maintenance margin. If not, panic (prevent false liquidation).
   - Calculate the liquidation penalty: `penalty = notional * liquidation_fee_bps / 10000`.
   - Determine the keeper reward: a portion of the penalty (e.g., 50% to keeper, 50% to insurance fund).
   - Close the position at the oracle price (not vAMM price — liquidation must use a fair external price).
   - Distribute remaining margin: `remaining = margin + pnl - penalty`. If remaining > 0, credit to user. If remaining < 0, this is bad debt — draw from insurance fund.
   - Transfer keeper reward from the penalty.
   - Update vAMM state, market OI.
   - Emit event: `(Symbol::new("liquidation"), user, position_id, oracle_price, remaining_margin, keeper_reward)`.
2. Implement **partial liquidation** for large positions:
   - If position notional > a threshold (e.g., $100K), liquidate only 20% of the position per transaction.
   - This prevents excessive price impact from a single large liquidation.
   - The remaining position must be above maintenance margin after partial liquidation (add a buffer).
   - Set a cooldown (e.g., 30 seconds / 6 ledgers) before the next partial liquidation of the same position.
3. Implement **Auto-Deleverage (ADL)** as the final backstop:
   - Triggered when the insurance fund is depleted and bad debt occurs.
   - Rank all profitable positions in the same market by `(unrealized_pnl / margin) * leverage` (most profitable and most leveraged first).
   - Reduce the top-ranked position's size to cover the bad debt.
   - ADL settles the deleveraged position at the bankruptcy price, not mark price.
   - Emit a distinct event: `(Symbol::new("adl"), deleveraged_user, position_id, reduced_size)`.
   - ADL is a last resort — if it triggers, it means the system is under extreme stress. Log extensively.

### 6.4 — Implement the Insurance Fund

1. The insurance fund is a pool of USDC (primary collateral) that absorbs bad debt from liquidations.
2. Store the insurance fund balance in Persistent storage: `DataKey::InsuranceFund -> i128`.
3. Fund sources:
   - 50% of liquidation penalties.
   - A portion of trading fees (configurable, e.g., 30% of all taker fees).
   - Funding rate surplus (when funding rate payments don't perfectly net out between longs and shorts).
4. Fund drains:
   - Bad debt from insolvent liquidations.
   - ADL debt coverage.
5. Implement `get_insurance_fund_balance() -> i128` (public view function).
6. Implement a cap on the insurance fund: once it reaches a threshold (e.g., $1M), excess flows to the protocol treasury instead.

### 6.5 — Testing the Risk Engine

1. Test margin validation: open positions at exactly initial margin, verify acceptance. Try below initial margin, verify rejection.
2. Test liquidation trigger: open a leveraged position, move the oracle price against the position until maintenance margin is breached, call `liquidate`, verify success.
3. Test false liquidation: attempt to liquidate a healthy position, verify rejection.
4. Test partial liquidation: open a large position, liquidate 20%, verify remaining position is healthier.
5. Test ADL: drain the insurance fund, create bad debt, verify ADL triggers and reduces profitable positions.
6. Test cross-margin: open multiple positions, verify that profit from one position provides margin for another.
7. Test isolated margin: open an isolated position, verify liquidation does not affect other positions.
8. Stress test: simulate a 50% price crash with 20 open positions at various leverages, verify liquidation cascade processes correctly and insurance fund absorbs bad debt.

---

## Phase 7 — Options Engine

**Estimated Duration**: 15–18 days
**Dependencies**: Phase 1, Phase 2, Phase 3, Phase 6
**Contract**: `stellax-options`

### 7.1 — Design the Options Model

1. **European-style cash-settled options**: holders can only exercise at expiry, settlement is in USDC (no physical delivery of the underlying).
2. **Vanilla calls and puts only** for v1 (no exotic options).
3. Design the options lifecycle:
   - **Write**: a user deposits collateral and creates (writes) an option contract. They receive the premium.
   - **Buy**: another user purchases the option by paying the premium to the writer.
   - **Exercise**: at expiry, if the option is in-the-money, the holder receives the cash settlement value. If out-of-the-money, it expires worthless.
4. Initial markets: XLM options (weekly expiry), BTC options (weekly + monthly), ETH options (weekly + monthly).
5. Strike prices: generated as a ladder around the current spot price (e.g., 10 strikes above and below, spaced at 5% intervals).

### 7.2 — Implement On-Chain Black-Scholes Pricing

1. The Black-Scholes formula for a European call option:
   - `C = S * N(d1) - K * e^(-rT) * N(d2)`
   - `d1 = (ln(S/K) + (r + sigma^2/2) * T) / (sigma * sqrt(T))`
   - `d2 = d1 - sigma * sqrt(T)`
   - Where: S = spot price, K = strike, r = risk-free rate, T = time to expiry (in years), sigma = implied volatility, N() = cumulative normal distribution.
2. All of these must be computed in i128 fixed-point arithmetic using the math library from Phase 1:
   - `ln(S/K)` → use `ln_fixed()` from the math library.
   - `sigma^2` → use `mul_precision()`.
   - `sqrt(T)` → use `sqrt_fixed()`.
   - `e^(-rT)` → use `exp_fixed()`.
   - `N(d1)`, `N(d2)` → use `normal_cdf()`.
3. Implement `calculate_option_price(spot: i128, strike: i128, time_to_expiry: i128, volatility: i128, risk_free_rate: i128, is_call: bool) -> i128`:
   - Compute d1, d2, then the option price using the full formula.
   - For puts: use put-call parity: `P = C - S + K * e^(-rT)`.
   - Return the premium in 18-decimal fixed-point.
4. Implement the Greeks (optional for v1, valuable for v2):
   - Delta: `N(d1)` for calls, `N(d1) - 1` for puts.
   - Gamma: `N'(d1) / (S * sigma * sqrt(T))`.
   - Theta: time decay rate.
   - Vega: sensitivity to volatility.
   - These are informational — displayed in the UI but not used in core contract logic for v1.

### 7.3 — Implement Implied Volatility Feed

1. Implied volatility (IV) cannot be computed purely on-chain from market data — it requires iterative root-finding (solving BS formula backwards).
2. Design: an off-chain keeper computes IV from market data (CEX options markets, historical volatility) and pushes it on-chain.
3. Store IV per market in Persistent storage: `DataKey::ImpliedVol(market_id) -> VolatilitySurface`.
   - For v1: a single `sigma` per market (flat volatility surface — same IV for all strikes/expiries in that market).
   - For v2: per-strike, per-expiry IV using SVI parameterization (Derive/Lyra approach).
4. Implement `set_implied_volatility(market_id: u32, sigma: i128)`: keeper-only function. The keeper computes IV off-chain and pushes it periodically (e.g., every 15 minutes).
5. Implement staleness check: if IV hasn't been updated for > 1 hour, option writing/buying is paused.

### 7.4 — Implement Option Writing (Selling)

1. Implement `write_option(writer: Address, market_id: u32, strike: i128, expiry: u64, is_call: bool, size: i128) -> u64`:
   - `writer.require_auth()`.
   - Validate: market is active, expiry is in the future (and within allowed range, e.g., 1 day to 90 days), strike is within allowed range relative to current spot.
   - Calculate the premium using Black-Scholes.
   - Calculate required collateral:
     - For covered calls: writer must deposit `size` units of the underlying (or equivalent USD value).
     - For puts: writer must deposit `strike * size` in USD collateral.
     - Apply an additional safety margin (e.g., 120% of max loss) to protect against IV expansion.
   - Lock collateral via cross-contract call to `stellax-vault.lock_margin()`.
   - Create the `OptionContract` struct and store in Persistent storage: key = `(DataKey::Option, option_id)`.
   - Emit event: `(Symbol::new("option_written"), writer, option_id, market_id, strike, expiry, is_call, size, premium)`.
   - Return `option_id`.
2. Maintain an option ID counter in Instance storage.

### 7.5 — Implement Option Buying

1. Implement `buy_option(buyer: Address, option_id: u64)`:
   - `buyer.require_auth()`.
   - Read the option contract. Verify it's available for purchase (not already bought, not expired).
   - Deduct the premium from the buyer's collateral balance.
   - Credit the premium to the writer's collateral balance (minus protocol fee).
   - Update the option's `holder` field to the buyer's address.
   - Emit event: `(Symbol::new("option_bought"), buyer, option_id, premium_paid)`.
2. Implement an option orderbook or marketplace:
   - For v1: direct writer-buyer matching. The writer lists an option, a buyer takes it.
   - For v2: an AMM-style options market (like Lyra's approach) where the protocol is the counterparty. This is significantly more complex and requires sophisticated risk management.

### 7.6 — Implement Option Settlement

1. Implement `settle_option(option_id: u64, price_payload: Option<Bytes>)`:
   - Can be called by anyone after expiry (permissionless settlement).
   - Read the option contract. Verify `env.ledger().timestamp() >= option.expiry`.
   - Fetch the oracle price at settlement time.
   - Calculate settlement value:
     - Call: `max(0, oracle_price - strike) * size`
     - Put: `max(0, strike - oracle_price) * size`
   - If in-the-money: transfer settlement value from writer's locked collateral to holder.
   - If out-of-the-money: settlement value is 0. Release all locked collateral back to writer.
   - Mark the option as settled/exercised.
   - Emit event: `(Symbol::new("option_settled"), option_id, settlement_price, settlement_value)`.
2. Implement batch settlement: `settle_expired_options(option_ids: Vec<u64>)` — settle multiple options in one transaction. Keeper calls this after each expiry.
3. Handle the case where the writer's collateral is insufficient (if price moved dramatically):
   - This should be caught by the risk engine before it happens (writer's margin should be monitored).
   - If it somehow occurs: the writer's entire remaining collateral goes to the holder, and the shortfall is bad debt covered by the insurance fund.

### 7.7 — Testing the Options Engine

1. Test Black-Scholes pricing: compute option prices for known inputs and compare against external calculators (e.g., CBOE options calculator, Python's `scipy.stats.norm` + BS formula).
2. Test write flow: write a covered call, verify collateral locked, verify premium calculated.
3. Test buy flow: buy an option, verify premium transferred from buyer to writer.
4. Test settlement (in-the-money): write a call at strike $100, move oracle to $120, settle, verify holder receives $20 * size.
5. Test settlement (out-of-the-money): write a call at strike $100, move oracle to $80, settle, verify holder receives nothing, writer gets collateral back.
6. Test expiry: attempt to settle before expiry, verify rejection. Attempt to buy after expiry, verify rejection.
7. Test edge cases: deep in-the-money, deep out-of-the-money, at-the-money, very short time to expiry, very long time to expiry.
8. Benchmark Black-Scholes computation cost: use `simulateTransaction` to measure CPU instructions. If it exceeds ~2M instructions, optimize the math (precomputed tables, fewer Taylor series terms).

---

## Phase 8 — Structured Product Vaults

**Estimated Duration**: 8–10 days
**Dependencies**: Phase 3, Phase 7
**Contract**: `stellax-structured`

### 8.1 — Design the Vault Architecture

1. Structured products are automated strategies that abstract complex options trades into simple deposit/withdraw interfaces.
2. Vault types for v1:
   - **Covered Call Vault**: deposits the underlying asset, writes out-of-the-money calls weekly, earns premium as yield.
   - **Principal-Protected Note**: deposits stablecoin collateral, uses the yield (or a portion of principal) to buy call options, providing upside exposure with limited downside.
3. Each vault operates on an **epoch** basis (typically weekly):
   - Epoch start: vault writes options at the current optimal strike.
   - During epoch: options are active. No deposits/withdrawals (or queued for next epoch).
   - Epoch end: options expire, settlement occurs, vault rolls to next epoch.
4. Vault shares are **SEP-41 compliant tokens** — depositors receive share tokens that represent their pro-rata ownership. This makes vaults composable with other Stellar DeFi (they can be used as collateral in Blend, traded on DEXs, etc.).

### 8.2 — Implement the Covered Call Vault

1. Define vault state in Persistent storage:
   - `VaultConfig { underlying_asset: Address, quote_asset: Address, epoch_duration: u64, strike_delta_bps: u32, max_vault_cap: i128, performance_fee_bps: u32, management_fee_bps: u32 }`
   - `CurrentEpoch { epoch_id: u32, start_time: u64, end_time: u64, strike: i128, option_id: u64, total_deposits: i128, options_written: i128 }`
   - `PendingDeposits { user -> amount }` (queued for next epoch)
   - `PendingWithdrawals { user -> shares }` (queued for next epoch)
2. Implement `deposit(user: Address, amount: i128)`:
   - `user.require_auth()`.
   - Transfer the underlying asset from user to vault.
   - If mid-epoch: queue the deposit for the next epoch (store in Temporary storage).
   - If between epochs (roll period): process immediately — mint vault share tokens proportional to `amount / total_vault_value`.
   - Emit event.
3. Implement `withdraw(user: Address, shares: i128)`:
   - `user.require_auth()`.
   - If mid-epoch: queue the withdrawal for the next epoch.
   - If between epochs: burn share tokens, transfer proportional underlying back to user (minus any accrued fees).
4. Implement `roll_epoch()`:
   - Can be called by anyone (keeper will call this at epoch boundaries).
   - Settle the previous epoch's options (cross-contract call to `stellax-options.settle_option()`).
   - Process pending deposits and withdrawals.
   - Calculate new optimal strike: current spot price + `strike_delta_bps` (e.g., 10% OTM).
   - Write new options covering the vault's total underlying position (cross-contract call to `stellax-options.write_option()`).
   - Charge performance fee on profit (premium earned - any losses from options being exercised).
   - Update epoch state.
   - Emit event: `(Symbol::new("epoch_rolled"), epoch_id, new_strike, premium_earned)`.
5. Implement vault share token:
   - The vault contract itself acts as a token contract, implementing the SEP-41 `TokenInterface`.
   - Share token metadata: name = "StellaX CC Vault - XLM", symbol = "sxvXLM", decimals = 18.
   - `mint()`: called internally during deposit.
   - `burn()`: called internally during withdrawal.
   - `transfer()`, `balance()`, `approve()`, `allowance()`: standard SEP-41 functions. These allow vault shares to be traded or used as collateral elsewhere.

### 8.3 — Implement the Principal-Protected Note Vault

1. Similar epoch structure but different strategy:
   - At epoch start: take a small portion of the vault's stablecoin deposits (e.g., the projected weekly yield from RWA collateral, or 0.1% of principal) and use it to buy at-the-money call options.
   - At epoch end: if the call is in-the-money, holders gain the upside. If out-of-the-money, they lose only the premium (principal is protected).
2. This vault type specifically targets RWA holders who want to maintain their principal while getting crypto upside exposure.
3. Implementation mirrors the covered call vault but with reversed option direction (buying instead of writing) and stablecoin deposits instead of underlying.

### 8.4 — Testing Structured Products

1. Test full epoch lifecycle: deposit → roll_epoch → advance time → settle → verify premium earned → roll again.
2. Test share token math: deposit X, verify shares = X / (total_value / total_shares). Withdraw shares, verify proportional return.
3. Test queuing: deposit mid-epoch, verify funds are queued, verify they're processed on next roll.
4. Test performance fee: earn premium, verify fee is deducted correctly from profits.
5. Test loss scenario: options are exercised against the vault, verify the vault's NAV decreases and share price drops accordingly.
6. Test share composability: transfer vault shares to another address, verify they can be redeemed by the new holder.

---

## Phase 9 — Cross-Chain Bridge (Axelar GMP + ITS)

**Estimated Duration**: 10–12 days
**Dependencies**: Phase 3, Phase 4
**Contract**: `stellax-bridge`

### 9.1 — Understand the Axelar Stellar Architecture

1. Study the three Axelar contracts on Stellar:
   - **Gateway** (`stellar-axelar-gateway`): the entry/exit point for cross-chain messages. On Stellar testnet: `CCSNWHMQSPTW4PS7L32OIMH7Z6NFNCKYZKNFSWRSYX7MK64KHBDZDT5I`.
   - **Gas Service** (`stellar-axelar-gas-service`): handles gas payment for cross-chain relay. On Stellar testnet: `CAZUKAFB5XHZKFZR7B5HIKB6BBMYSZIV3V2VWFTQWKYEMONWK2ZLTZCT`.
   - **Interchain Token Service** (ITS): manages cross-chain token transfers (mint/burn/lock model).
2. Study the two integration patterns:
   - **GMP (General Message Passing)**: send arbitrary messages between chains. Use for cross-chain position management, liquidation notifications, governance.
   - **ITS (Interchain Token Service)**: transfer tokens between chains. Use for cross-chain collateral deposits.
3. Key dependency: the `AxelarExecutable` derive macro and `CustomAxelarExecutable` trait from Axelar's Stellar SDK.

### 9.2 — Implement the Bridge Contract (Inbound: EVM → Stellar)

1. Define the contract struct with `#[derive(AxelarExecutable)]`.
2. Implement `CustomAxelarExecutable` trait:
   - `__gateway(env: &Env) -> Address`: return the stored Gateway contract address.
   - `__execute(env: &Env, source_chain: String, message_id: String, source_address: String, payload: Bytes) -> Result<(), Error>`: handle inbound cross-chain messages.
3. Define the inbound message types (ABI-encoded payloads for EVM compatibility):
   - `ACTION_DEPOSIT = 1`: cross-chain collateral deposit. Payload: `(action_type, user_address, token_address, amount)`.
   - `ACTION_WITHDRAW = 2`: cross-chain withdrawal request. Payload: `(action_type, user_address, destination_chain, destination_address, amount)`.
4. In `__execute`, decode the payload using `alloy-sol-types` ABI decoding:
   - Parse the action type.
   - For `ACTION_DEPOSIT`: call `stellax-vault.deposit()` to credit the user's collateral balance. The actual tokens arrive via ITS separately.
   - For `ACTION_WITHDRAW`: call `stellax-vault.withdraw()` and initiate an outbound token transfer via ITS.
5. Store the bridge configuration in Instance storage:
   - `gateway_address: Address`
   - `gas_service_address: Address`
   - `its_address: Address`
   - `trusted_sources: Map<String, String>` — mapping of chain name to trusted contract address on that chain (e.g., `"ethereum" -> "0xABC..."`)
6. Validate that inbound messages come from trusted sources only: check `source_chain` and `source_address` against the `trusted_sources` map.

### 9.3 — Implement the Bridge Contract (Outbound: Stellar → EVM)

1. Implement `send_message(caller: Address, destination_chain: String, destination_address: String, payload: Bytes, gas_token: Option<Token>)`:
   - `caller.require_auth()`.
   - ABI-encode the payload.
   - Call `gas_service.pay_gas()` with the gas token (XLM on Stellar testnet).
   - Call `gateway.call_contract()` with destination chain, address, and encoded payload.
   - Emit event: `(Symbol::new("message_sent"), destination_chain, destination_address)`.
2. Use cases for outbound messages:
   - Notify EVM contracts of position state changes (for cross-chain liquidation).
   - Trigger token bridging back to EVM for withdrawals.
   - Future: governance vote results propagated to EVM.

### 9.4 — Implement Cross-Chain Collateral via ITS

1. Implement `bridge_collateral_in(user: Address, source_chain: String, token_id: BytesN<32>, amount: i128)`:
   - This is triggered by ITS when tokens arrive from another chain.
   - Verify the token_id maps to a supported collateral type.
   - Call `stellax-vault.deposit()` to credit the user's balance.
2. Implement `bridge_collateral_out(user: Address, destination_chain: String, token_id: BytesN<32>, amount: i128, gas_token: Option<Token>)`:
   - `user.require_auth()`.
   - Call `stellax-vault.withdraw()` to debit the user's balance.
   - Call ITS's `interchain_transfer()` to send tokens to the destination chain.
3. Token mapping: maintain a registry of `token_id -> local_token_address` for all bridgeable assets.

### 9.5 — Deploy the EVM Counterpart

1. Write a simple Solidity contract that acts as the EVM-side endpoint:
   - Inherits `AxelarExecutable` from Axelar's Solidity SDK.
   - Implements `_execute()` to handle messages from Stellar.
   - Implements `depositToStellar()`: user deposits ERC-20 collateral, sends GMP message + ITS token transfer to Stellar.
   - Implements `withdrawFromStellar()`: handles withdrawal messages from Stellar, releases tokens to user.
2. Deploy to Ethereum Sepolia (testnet) and Avalanche Fuji (testnet) for testing.
3. This EVM contract is intentionally simple — the core protocol logic lives entirely on Stellar.

### 9.6 — Testing the Bridge

1. Test inbound message decoding: construct ABI-encoded payloads, send via gateway (or mock), verify correct parsing.
2. Test trusted source validation: send a message from an untrusted source, verify rejection.
3. Test end-to-end (testnet): deposit USDC on Avalanche Fuji → bridge via Axelar → verify balance credited on Stellar testnet.
4. Test outbound: initiate withdrawal on Stellar → verify GMP message arrives at EVM contract on testnet.
5. Test failure cases: insufficient gas, invalid payload encoding, untrusted chain, token not supported.
6. Measure cross-chain latency: time from EVM tx submission to Stellar execution. Axelar typically takes 2-5 minutes.

---

## Phase 10 — Governance and Treasury

**Estimated Duration**: 5–7 days
**Dependencies**: Phase 0
**Contracts**: `stellax-governor`, `stellax-treasury`

### 10.1 — Implement Protocol Governance

1. For v1: multi-sig admin governance (not token-based voting — that's v2).
2. Define the governor contract:
   - `admin_multisig: Vec<Address>` — list of authorized admin addresses.
   - `threshold: u32` — minimum signatures required (e.g., 3-of-5).
   - `timelock_ledgers: u32` — delay between proposal and execution (e.g., 17280 = 1 day).
3. Implement the proposal system:
   - `propose(proposer: Address, action: GovernanceAction, target_contract: Address, calldata: Bytes) -> u64`: create a proposal. Store in Persistent storage with status = Pending.
   - `approve(signer: Address, proposal_id: u64)`: add an approval signature. Track approvals per proposal.
   - `execute(proposal_id: u64)`: execute the proposal if threshold met AND timelock expired.
4. Define `GovernanceAction` enum:
   - `UpdateMarketParams` — change leverage limits, fees, OI caps.
   - `UpdateCollateralConfig` — add/remove/modify supported collateral types and haircuts.
   - `UpdateOracleConfig` — change oracle signers, staleness thresholds.
   - `PauseMarket` / `UnpauseMarket` — emergency market pause.
   - `PauseProtocol` / `UnpauseProtocol` — global emergency stop.
   - `UpgradeContract` — deploy new WASM hash to a protocol contract.
   - `TransferAdmin` — change the admin multisig.
5. Implement **emergency pause** with a single-sig fast path:
   - Designate one address as the "guardian" with power to pause immediately (no timelock).
   - Unpause requires the full multisig + timelock.
   - This protects against exploits where waiting for the timelock would be catastrophic.

### 10.2 — Implement the Upgradeable Contract Pattern

1. All StellaX contracts must be upgradeable via WASM hash replacement:
   - Store `admin: Address` in each contract's Instance storage.
   - Implement `upgrade(new_wasm_hash: BytesN<32>)`: verify caller is admin (governor contract), then call `env.deployer().update_current_contract_wasm(new_wasm_hash)`.
   - The new WASM must be compatible with existing storage layout (or include migration logic).
2. Version tracking: store a `version: u32` in Instance storage. Increment on every upgrade. Emit event.
3. Migration pattern: if an upgrade changes the storage schema, implement a `migrate()` function that converts old data formats to new ones. Call `migrate()` immediately after `upgrade()`.

### 10.3 — Implement the Treasury

1. The treasury collects protocol revenue and distributes it.
2. Revenue sources (received via cross-contract calls):
   - Trading fees (from perp engine and options engine).
   - Liquidation penalties (portion from risk engine).
   - Epoch performance fees (from structured vaults).
   - Funding rate surplus (from funding engine).
3. Distribution split (configurable via governance):
   - 60% → Insurance fund (until cap reached, then 0%).
   - 20% → Protocol treasury (for operational costs, future development).
   - 20% → Staker rewards (distributed to users who stake the protocol's governance token — implemented in v2).
4. Implement `collect_fee(source: Address, token: Address, amount: i128)`:
   - Called by other protocol contracts when fees are generated.
   - Validate caller is an authorized protocol contract.
   - Record the fee in the treasury's ledger.
5. Implement `distribute()`:
   - Callable by anyone (keeper or governance).
   - Apply the distribution split.
   - Transfer insurance fund portion to the risk engine's insurance fund balance.
   - Hold treasury and staker portions in the treasury contract.
6. Implement `withdraw_treasury(destination: Address, token: Address, amount: i128)`:
   - Governance-only (requires governor proposal + execution).
   - Transfers protocol treasury funds out for operational purposes.

### 10.4 — Testing Governance and Treasury

1. Test multi-sig: propose → approve from 3 signers → execute. Verify action is applied.
2. Test timelock: propose → approve → attempt execute before timelock → verify rejection → advance ledger → execute.
3. Test emergency pause: guardian pauses, verify all trading functions revert. Multisig unpauses, verify functions resume.
4. Test upgrade: deploy a v2 WASM, execute upgrade via governance, verify new functionality works and old state is preserved.
5. Test treasury distribution: generate fees from trades, call distribute, verify correct split to insurance vs treasury vs stakers.

---

## Phase 11 — Keeper Infrastructure (Off-Chain Services)

**Estimated Duration**: 8–10 days
**Dependencies**: Phase 2, Phase 5, Phase 6, Phase 7, Phase 8
**Directory**: `packages/keeper`

### 11.1 — Design the Keeper Architecture

1. The keeper is a Node.js/TypeScript service that runs off-chain and performs time-sensitive operations that cannot be triggered by user transactions alone.
2. Use the `@stellar/stellar-sdk` and `@redstone-finance/stellar-connector` npm packages.
3. Design the keeper as a modular service with independent workers:
   - **Oracle Pusher**: pushes RedStone prices to the oracle contract at regular intervals.
   - **Funding Rate Updater**: calls `update_funding()` on the funding contract hourly.
   - **Liquidation Bot**: monitors positions and liquidates those below maintenance margin.
   - **Option Settler**: settles expired options after each expiry.
   - **Vault Roller**: calls `roll_epoch()` on structured vaults at epoch boundaries.
4. Each worker runs on its own interval and can be independently enabled/disabled.

### 11.2 — Implement the Oracle Pusher

1. Use `@redstone-finance/stellar-connector` to fetch signed price payloads from RedStone's data providers.
2. Configure feed IDs: BTC, ETH, XLM, SOL, LINK, EUR, XAU (and others as needed).
3. Every 10 seconds:
   - Fetch the latest signed price payload from RedStone.
   - Call `stellax-oracle.write_prices(payload)` via `stellar contract invoke` or direct SDK submission.
   - Log the transaction result and updated prices.
4. Implement retry logic: if the transaction fails (e.g., network congestion), retry with exponential backoff (max 3 retries).
5. Implement health monitoring: alert if prices haven't been updated for > 30 seconds.
6. Estimate costs: each price push is one Soroban transaction (~100 stroops base fee + compute + storage write fees). At 10-second intervals, that's ~8,640 transactions/day. Budget for ~0.5 XLM/day in keeper costs.

### 11.3 — Implement the Liquidation Bot

1. Every ledger close (~5 seconds):
   - Query all open positions (via RPC or indexer).
   - For each position: call `stellax-risk.get_account_health(user)` (read-only, via `simulateTransaction` — no tx fee).
   - If a position is below maintenance margin: submit a `stellax-risk.liquidate()` transaction.
2. Optimization: maintain a local cache of positions sorted by margin ratio. Only check positions within 20% of liquidation threshold on every cycle. Check all positions every 60 seconds.
3. Gas estimation: use `simulateTransaction` before submitting the liquidation tx to ensure it will succeed and to estimate the fee.
4. Implement keeper reward tracking: log each successful liquidation, the reward earned, and cumulative profit.
5. Implement priority queue: if multiple positions are liquidatable, process the most underwater first (highest bad debt risk).

### 11.4 — Implement the Funding Rate Updater

1. Every hour (every ~720 ledgers):
   - For each active market: call `stellax-funding.update_funding(market_id)`.
   - Log the new funding rate for each market.
2. This is a lightweight operation — one transaction per market per hour.

### 11.5 — Implement the Option Settler and Vault Roller

1. **Option Settler**:
   - Maintain a schedule of option expiries.
   - After each expiry timestamp: call `stellax-options.settle_expired_options(option_ids)` with all options expiring in that batch.
   - Run once per hour (options expire at fixed times, e.g., 08:00 UTC Fridays).
2. **Vault Roller**:
   - Maintain the epoch schedule per vault.
   - At each epoch boundary: call `stellax-structured.roll_epoch()` for each vault.
   - Run once per epoch (e.g., weekly).

### 11.6 — Monitoring and Alerting

1. Implement a health-check HTTP endpoint that reports:
   - Last successful oracle push timestamp.
   - Current funding rates per market.
   - Number of positions near liquidation.
   - Insurance fund balance.
   - Keeper wallet balance (alert if running low on XLM for fees).
2. Integrate with alerting: PagerDuty, Telegram bot, or Discord webhook for critical alerts:
   - Oracle feed stale > 60s.
   - Insurance fund below threshold.
   - Liquidation failed (tx rejected).
   - Keeper wallet balance < 100 XLM.

---

## Phase 12 — Frontend Application

**Estimated Duration**: 15–20 days
**Dependencies**: Phase 4, Phase 7, Phase 8 (contracts must be on testnet)
**Directory**: `packages/frontend`

### 12.1 — Project Setup

1. Initialize a React + TypeScript project using Vite (or use Scaffold Stellar's built-in React template).
2. Install dependencies:
   - `@stellar/stellar-sdk` — Stellar JS SDK for transaction building and signing.
   - `@stellar/freighter-api` — Freighter wallet integration (most popular Stellar wallet).
   - Auto-generated contract client packages from `stellar contract bindings typescript` — these provide type-safe interfaces to your deployed contracts.
3. Generate TypeScript bindings for each deployed contract:
   - `stellar contract bindings typescript --contract-id <ORACLE_ID> --output-dir packages/frontend/src/contracts/oracle --network testnet`
   - Repeat for each contract. These bindings provide typed function calls, removing the need to manually construct invocations.
4. Set up TailwindCSS and a charting library (Lightweight Charts by TradingView, or Recharts).

### 12.2 — Implement Wallet Connection

1. Implement a wallet connection module supporting:
   - **Freighter** (browser extension — primary wallet for Stellar).
   - **WalletConnect** (optional, for mobile wallets).
   - **Ledger** (optional, for hardware wallet users).
2. Wallet connection flow:
   - User clicks "Connect Wallet".
   - App requests connection via `freighter-api.isConnected()` and `freighter-api.getPublicKey()`.
   - Display truncated address and XLM balance.
   - Store connection state in React context.
3. Transaction signing:
   - All contract invocations go through `simulateTransaction` first (to estimate fees and check for errors).
   - Then `signTransaction` via Freighter.
   - Then `sendTransaction` to submit.
   - Display transaction status: pending → success/failure with explorer link.

### 12.3 — Implement the Trading Interface

1. **Market selector**: dropdown/tabs for available markets (XLM-PERP, BTC-PERP, etc.).
2. **Price chart**: real-time candlestick chart showing mark price history. Data source: index off-chain from oracle push events + vAMM state changes.
3. **Order form**:
   - Toggle: Long / Short.
   - Input: Size (in USD or base asset units).
   - Slider: Leverage (1x to max).
   - Calculated display: margin required, estimated entry price, liquidation price, fees.
   - Button: "Open Position" → triggers `stellax-perp-engine.open_position()`.
4. **Position panel**:
   - Table of open positions: market, size, entry price, current price, unrealized PnL, margin, leverage, liquidation price.
   - Actions per position: Close, Add Margin, Remove Margin, Partial Close.
   - PnL should update in real-time (poll oracle price every 5 seconds or use WebSocket for events).
5. **Account summary**:
   - Total equity, total margin used, free collateral, margin ratio, account health indicator (green/yellow/red).

### 12.4 — Implement the Options Interface

1. **Options chain**: table showing available options per market:
   - Columns: Strike, Expiry, Type (Call/Put), Premium (bid/ask), IV, Delta, OI.
   - Rows grouped by expiry date.
2. **Trade panel**: select an option → Write or Buy → confirm modal showing premium, required collateral, max loss.
3. **Portfolio view**: show active options (written and held), their current value, time to expiry, Greeks.

### 12.5 — Implement the Vault Interface

1. **Vault cards**: one card per structured product vault showing:
   - Strategy description, underlying asset, current APY (based on recent epoch performance), TVL, epoch schedule.
2. **Deposit/Withdraw**: simple form with amount input and confirmation.
3. **Epoch history**: table showing past epochs, premium earned, any exercise losses, net yield.

### 12.6 — Implement the Cross-Chain Deposit Interface

1. **Chain selector**: choose source chain (Ethereum, Arbitrum, Avalanche, etc.).
2. **Asset selector**: choose collateral to bridge (USDC, etc.).
3. **Bridge flow**:
   - User connects EVM wallet (MetaMask via wagmi/viem).
   - User approves and deposits on EVM side.
   - Display Axelar tracking link (`testnet.axelarscan.io/gmp/<TX_HASH>`).
   - Poll for completion on Stellar side.
   - Update collateral balance once bridging is confirmed.
4. **Withdraw flow**: reverse — initiate on Stellar, display tracking, confirm on EVM.

### 12.7 — Implement the Dashboard

1. **Protocol overview**: total TVL, total open interest, 24h volume, active traders.
2. **Markets overview**: table of all markets with price, 24h change, funding rate, OI.
3. **Insurance fund status**: current balance, percentage of target.
4. **Leaderboard** (optional): top traders by PnL (data from indexing contract events).

### 12.8 — Testing the Frontend

1. Component-level tests: use React Testing Library for form validation, wallet state management.
2. Integration tests: connect to testnet, open a position, close it, verify UI updates correctly.
3. Cross-browser testing: Chrome, Firefox, Safari (Freighter is Chrome-only, so test fallback behavior).
4. Mobile responsiveness: while primarily desktop, ensure the UI is usable on mobile browsers.
5. Error handling: test wallet disconnection mid-transaction, network errors, stale price warnings.

---

## Phase 13 — Integration Testing and Security

**Estimated Duration**: 10–14 days
**Dependencies**: All prior phases
**Directory**: `tests/`

### 13.1 — Cross-Contract Integration Tests

1. Write end-to-end test scenarios using `soroban-sdk` testutils that deploy ALL contracts in a simulated Soroban environment:
   - **Full trade lifecycle**: deploy oracle → push prices → deploy vault → deposit collateral → deploy perp engine → open position → advance time → update funding → close position → verify final balance.
   - **Liquidation cascade**: open 5 positions at various leverages → move oracle price against them → run liquidation bot logic → verify correct positions are liquidated in priority order → verify insurance fund receives penalties → verify remaining users are unaffected.
   - **Options lifecycle**: push IV → write option → buy option → advance to expiry → push settlement price → settle → verify payouts.
   - **Structured vault epoch**: deposit into vault → roll epoch → advance time → settle epoch → roll again → withdraw → verify yield.
   - **Cross-margin interaction**: open perp position + write option on same account → verify margin is shared → close perp at loss → verify option margin still adequate.
2. Implement test helpers:
   - `setup_protocol()`: deploys all contracts, configures them, returns handles.
   - `push_price(asset, price)`: pushes a mock oracle price.
   - `advance_time(seconds)`: advances the test environment's ledger timestamp.
   - `open_test_position(user, market, size, leverage)`: convenience wrapper for the full open flow.

### 13.2 — Adversarial Testing

1. **Reentrancy testing**: attempt to call back into the protocol from a malicious token contract during `transfer`. Soroban's execution model (no callbacks during cross-contract calls) should prevent this, but verify.
2. **Oracle manipulation**: submit a price payload with manipulated data (wrong signers, expired timestamps, out-of-range prices). Verify all are rejected.
3. **Overflow testing**: attempt to open positions with i128::MAX values, deposit absurd amounts. Verify graceful failure, not panics with unhelpful messages.
4. **Access control testing**: attempt to call admin functions from non-admin addresses. Attempt to call internal functions (like `lock_margin`) from external addresses.
5. **Frontrunning simulation**: in a two-phase execution model, attempt to extract value by observing pending orders and manipulating oracle prices.
6. **Storage exhaustion**: create many positions rapidly to see if storage limits are hit. Test the behavior when a user has 100+ open positions.

### 13.3 — Economic Simulation

1. Implement an off-chain simulation (Python or TypeScript) that models the protocol under various market conditions:
   - **Bull market**: steady price increase. Verify funding rates incentivize shorts, insurance fund grows.
   - **Bear market**: steady price decrease. Verify liquidation cascade is manageable, ADL triggers correctly.
   - **Flash crash**: 30% price drop in 1 minute. Verify all underwater positions are liquidated, insurance fund absorbs bad debt, ADL kicks in if needed.
   - **High volatility**: rapid price oscillations. Verify funding rate is stable, vAMM price doesn't deviate excessively from oracle.
   - **Low liquidity**: very few traders. Verify funding rate stays bounded, vault epoch rolls gracefully with minimal deposits.
2. Parameters to vary: number of traders (10, 100, 1000), average leverage (5x, 20x, 50x), market volatility (1%, 5%, 20% daily), insurance fund size.
3. Output: worst-case loss for the protocol, maximum bad debt, ADL frequency, insurance fund depletion probability.

### 13.4 — Gas and Resource Profiling

1. For every user-facing function, measure resource consumption via `simulateTransaction`:
   - CPU instructions consumed.
   - Number of ledger entries read/written.
   - Bytes read/written.
   - Transaction size (bytes).
2. Compare against mainnet limits. Identify any functions that approach limits.
3. Optimize hot paths:
   - `open_position` is the most complex: oracle read + risk validation + vault margin lock + vAMM update + position storage + OI update + fee transfer = potentially 4+ cross-contract calls and 8+ storage operations.
   - If this exceeds limits: refactor to reduce cross-contract calls (e.g., inline the risk check into the perp engine instead of a separate contract call).
4. Document the resource budget per operation in Appendix C.

### 13.5 — Security Checklist

Before deploying to mainnet, verify:

1. All `require_auth()` checks are present on every function that modifies user state.
2. All oracle prices include staleness checks (no stale prices used in any calculation).
3. All arithmetic uses checked operations (overflow-checks = true in release profile).
4. All cross-contract callers are validated (only authorized protocol contracts can call internal functions).
5. All storage entries have appropriate TTL extensions.
6. No floating-point math anywhere in the codebase (search for `f32`, `f64`).
7. All user inputs are validated (non-negative amounts, valid market IDs, leverage within bounds).
8. Emergency pause functionality works for all trading functions.
9. Upgrade mechanism requires governance approval and timelock.
10. No hardcoded secrets (private keys, API keys) in contract code or deployment scripts.

---

## Phase 14 — Testnet Deployment and Stress Testing

**Estimated Duration**: 7–10 days
**Dependencies**: Phase 13
**Network**: Stellar Testnet

### 14.1 — Deployment Order

Deploy contracts in dependency order (contracts that depend on others must be deployed last):

1. `stellax-math` — not deployed (library only, compiled into other contracts).
2. `stellax-governor` — deploy first (other contracts need admin reference).
3. `stellax-oracle` — deploy with admin = governor, configure RedStone signers.
4. `stellax-vault` — deploy with admin = governor, configure supported collateral.
5. `stellax-funding` — deploy with admin = governor.
6. `stellax-risk` — deploy with admin = governor, configure margin parameters.
7. `stellax-perp-engine` — deploy with references to oracle, vault, funding, risk contracts.
8. `stellax-options` — deploy with references to oracle, vault, risk contracts.
9. `stellax-structured` — deploy with references to options, vault contracts.
10. `stellax-bridge` — deploy with Axelar gateway and gas service addresses.
11. `stellax-treasury` — deploy with references to all fee-generating contracts.

For each deployment:
- `stellar contract build` to compile.
- `stellar contract optimize --wasm <path>` to minimize WASM size.
- `stellar contract deploy --wasm <path> --source-account stellax-deployer --network testnet --alias <name> -- <constructor_args>`.
- Verify deployment: `stellar contract invoke --id <alias> --network testnet -- <view_function>`.

### 14.2 — Post-Deployment Configuration

1. Register all contract addresses with each other (cross-references):
   - Set oracle address in perp engine, options engine.
   - Set vault address in perp engine, options engine, risk engine.
   - Set risk engine address in vault (for withdrawal validation).
   - Set perp engine and options engine as authorized callers in vault (for margin locking).
   - Set funding engine address in perp engine.
   - Set insurance fund reference in risk engine.
2. Configure initial market parameters via governance:
   - Add markets: XLM-PERP, BTC-PERP, ETH-PERP.
   - Set per-market: max leverage, fees, OI caps.
3. Configure collateral:
   - Add USDC (testnet address), XLM (native), test tokens for BENJI/USDY.
   - Set haircuts.
4. Start the keeper services:
   - Oracle pusher → verify prices appear on-chain.
   - Funding updater → verify funding rates update hourly.
   - Liquidation bot → run in monitoring mode (no liquidations yet).

### 14.3 — Testnet Stress Testing

1. **Load testing**: use the TypeScript SDK to submit 100 concurrent transactions:
   - 50 open positions, 30 close positions, 20 modify positions.
   - Measure: throughput (tx/s), latency (time from submit to confirmation), failure rate.
2. **Liquidation cascade test**:
   - Open 20 positions at 40x leverage in BTC-PERP.
   - Push a BTC price drop of 5% (enough to trigger liquidations at 40x).
   - Observe: how many ledgers does it take to liquidate all 20 positions? Is the keeper fast enough? Is the insurance fund correctly funded?
3. **Oracle failure test**:
   - Stop the oracle keeper.
   - Attempt to open a position → should fail with "stale price" error.
   - Restart the keeper → verify trading resumes.
4. **Cross-chain test (Axelar)**:
   - Deploy the EVM counterpart to Avalanche Fuji testnet.
   - Deposit USDC on Fuji → bridge via Axelar → verify collateral credited on Stellar testnet.
   - Measure: bridge latency, gas costs on both sides.
5. **Epoch rollover test**:
   - Deposit into structured vault.
   - Call `roll_epoch()`.
   - Advance time past expiry.
   - Settle and roll again.
   - Verify yield is correct and shares are correctly valued.
6. **Long-running soak test**: leave the system running on testnet for 72 hours with the keeper active. Monitor for:
   - Memory leaks in keeper.
   - Storage TTL issues (entries unexpectedly archived).
   - Oracle price drift or staleness.
   - Funding rate accumulation accuracy over many hours.

### 14.4 — Testnet Bug Bounty (Optional)

1. Publish testnet contract addresses and a guide for technical users.
2. Invite Stellar community members to attempt to break the protocol on testnet.
3. Reward findings proportional to severity.
4. Fix all discovered issues before mainnet deployment.

---

## Phase 15 — Mainnet Deployment and Launch Operations

**Estimated Duration**: 10–14 days
**Dependencies**: Phase 14 complete with no critical issues
**Network**: Stellar Mainnet

### 15.1 — Pre-Deployment Checklist

1. All testnet tests pass, including stress tests and cross-chain tests.
2. Security checklist (Phase 13.5) is 100% complete.
3. Apply for SCF Audit Bank (professional security audit by a third-party firm). If audit is complete, incorporate all findings. If audit is pending, deploy with conservative parameters and plan a parameter relaxation after audit completion.
4. Verify all WASM binaries are reproducibly buildable (same source code → same WASM hash).
5. Prepare mainnet deployment wallet:
   - Fund with sufficient XLM for deployment fees and initial keeper operations (~500 XLM).
   - Secure the deployment keypair (hardware wallet or multi-sig recommended).
6. Prepare the contract initialization parameters for mainnet:
   - Oracle: production RedStone signer public keys (not testnet signers).
   - Axelar: mainnet gateway and gas service addresses.
   - Markets: conservative initial parameters (lower leverage limits, higher margin requirements than final targets).
   - Collateral: USDC (via SAC), XLM (native). RWA tokens added after confirming mainnet compatibility with issuers.

### 15.2 — Phased Mainnet Deployment

Deploy in the same dependency order as testnet (Phase 14.1), but with additional caution:

1. **Day 1: Infrastructure contracts**
   - Deploy governor (multi-sig admin set to the core team's addresses).
   - Deploy oracle (configure production RedStone signers, set staleness to 60 seconds).
   - Deploy vault (USDC + XLM only initially — no RWA tokens until validated).
   - Deploy funding engine.
   - Deploy risk engine (conservative: max leverage 10x, high maintenance margin).
   - Start oracle keeper pushing mainnet prices.

2. **Day 2: Trading contracts**
   - Deploy perp engine with 2 initial markets: XLM-PERP and BTC-PERP only.
   - Configure low OI caps ($100K per side per market initially).
   - Deploy treasury.
   - Seed the insurance fund with protocol-owned capital (e.g., $5K USDC).

3. **Day 3-5: Internal testing on mainnet**
   - The core team opens real positions with small amounts ($10-$100).
   - Verify: prices correct, positions open/close, funding settles, fees collect.
   - Run the liquidation bot in production mode.
   - Monitor every transaction for unexpected behavior.

4. **Day 6-7: Soft launch**
   - Open to a limited set of trusted users (e.g., Stellar ecosystem builders, early supporters).
   - Keep OI caps low.
   - Gather feedback on UX, execution speed, price accuracy.
   - Fix any issues found.

5. **Day 8-10: Public launch**
   - Remove access restrictions.
   - Publish frontend at production URL.
   - Announce on Stellar community channels.
   - Gradually increase OI caps and leverage limits based on observed behavior.
   - Deploy options engine (markets: XLM calls/puts, weekly expiry).

6. **Day 11-14: Post-launch monitoring**
   - 24/7 monitoring of keeper health, oracle freshness, insurance fund.
   - Rapid response plan for any critical issues (emergency pause → diagnose → fix → upgrade → unpause).
   - Add ETH-PERP market.
   - Deploy structured vaults after sufficient options market liquidity.

### 15.3 — Progressive Parameter Relaxation

After each stability milestone, relax parameters via governance proposals:

| Milestone | Action |
|---|---|
| 1 week stable, no incidents | Increase max leverage to 20x |
| 2 weeks stable, >$50K OI | Increase OI caps to $500K per side |
| 1 month stable, audit complete | Increase max leverage to 50x, add SOL-PERP market |
| 2 months stable, >$500K OI | Add RWA collateral (BENJI, USDY) after issuer approval |
| 3 months stable | Deploy cross-chain bridge, launch structured vaults |

### 15.4 — Operational Runbooks

Prepare documented procedures for:

1. **Oracle failure**: if RedStone feed goes stale, emergency pause trading, notify RedStone team, fallback to Reflector for XLM pairs.
2. **Liquidation cascade**: if insurance fund drops below 50% of target, pause new position openings (allow closes only), trigger ADL if needed.
3. **Contract bug discovered**: emergency pause protocol, assess severity, prepare fix, deploy via governance fast-track (guardian pause + expedited multisig).
4. **Keeper failure**: keeper has a dead-man switch — if no heartbeat for 60 seconds, alerts fire. Backup keeper on a separate server auto-activates.
5. **Key compromise**: if a multisig key is compromised, immediately execute a key rotation proposal (remaining signers can do this if threshold is still met).

### 15.5 — Documentation Delivery

1. **Developer documentation**:
   - Contract API reference (auto-generated from Rust doc comments).
   - TypeScript SDK reference with usage examples.
   - Integration guide for other Stellar protocols wanting to build on StellaX (e.g., using vault shares as collateral in Blend).
2. **User documentation**:
   - How to trade perpetuals (with screenshots).
   - How to use options (explain concepts for non-expert users).
   - How to deposit into structured vaults.
   - Risk warnings and educational content.
3. **Operator documentation**:
   - Keeper setup guide.
   - Monitoring dashboard guide.
   - Runbook for incident response.

---

## Appendix A — Contract Dependency Graph

```
stellax-governor (standalone — no protocol dependencies)
    │
    ├── stellax-oracle (depends on: governor for admin)
    │       │
    ├── stellax-vault (depends on: governor, oracle, risk)
    │       │
    ├── stellax-funding (depends on: governor, oracle)
    │       │
    ├── stellax-risk (depends on: governor, oracle, vault, perp-engine, options, funding)
    │       │
    ├── stellax-perp-engine (depends on: oracle, vault, funding, risk)
    │       │
    ├── stellax-options (depends on: oracle, vault, risk)
    │       │
    ├── stellax-structured (depends on: options, vault)
    │       │
    ├── stellax-bridge (depends on: vault, Axelar gateway/gas-service)
    │       │
    └── stellax-treasury (depends on: governor, vault)
```

**Critical path**: oracle → vault → risk → perp-engine (these four must be built sequentially).
**Parallelizable**: options engine can be built in parallel with perp engine (both depend on oracle + vault + risk, but not on each other).

---

## Appendix B — Storage Strategy Reference

| Contract | Key | Storage Type | TTL Strategy | Size Estimate |
|---|---|---|---|---|
| oracle | `Price(Symbol)` | Persistent | Extend on every write (1 day min) | ~64 bytes per asset |
| oracle | `Config` | Instance | Extend on every call (7 days) | ~500 bytes |
| vault | `Balance(user, token)` | Persistent | Extend on every interaction (30 days) | ~48 bytes per entry |
| vault | `LockedMargin(user, pos_id)` | Persistent | Extend with position (30 days) | ~32 bytes |
| perp-engine | `Position(user, pos_id)` | Persistent | Extend on every interaction (30 days) | ~160 bytes |
| perp-engine | `Market(market_id)` | Instance | Extend on every call (7 days) | ~200 bytes per market |
| perp-engine | `VammState(market_id)` | Persistent | Extend on every trade (30 days) | ~64 bytes per market |
| perp-engine | `Order(order_id)` | Temporary | Auto-expire (1 day) | ~128 bytes |
| funding | `FundingState(market_id)` | Persistent | Extend on every update (30 days) | ~64 bytes |
| options | `Option(option_id)` | Persistent | Extend until expiry (matching expiry) | ~200 bytes |
| options | `ImpliedVol(market_id)` | Persistent | Extend on every update (1 day) | ~32 bytes |
| structured | `CurrentEpoch(vault_id)` | Persistent | Extend on every epoch (30 days) | ~128 bytes |
| structured | `PendingDeposit(user)` | Temporary | Auto-expire after epoch (1 day) | ~32 bytes |
| risk | `InsuranceFund` | Persistent | Extend on every interaction (30 days) | ~16 bytes |
| governor | `Proposal(id)` | Persistent | Extend on every approval (30 days) | ~256 bytes |
| treasury | `FeeBalance(token)` | Persistent | Extend on collection (30 days) | ~32 bytes |

---

## Appendix C — Soroban Resource Budget Per Operation

Estimated resource consumption per user-facing operation (to be validated via `simulateTransaction` on testnet):

| Operation | Cross-Contract Calls | Storage Reads | Storage Writes | Est. CPU Instructions | Est. Fee (stroops) |
|---|---|---|---|---|---|
| Deposit collateral | 1 (token transfer) | 3 | 2 | ~150K | ~50K |
| Withdraw collateral | 2 (risk check, token transfer) | 6 | 2 | ~250K | ~80K |
| Open perp position | 4 (oracle, vault, risk, funding) | 10 | 6 | ~700K | ~200K |
| Close perp position | 4 (oracle, vault, risk, funding) | 10 | 5 | ~650K | ~180K |
| Liquidate position | 4 (oracle, vault, risk, funding) | 10 | 6 | ~700K | ~200K |
| Write option | 3 (oracle, vault, risk) | 8 | 4 | ~900K (BS calc) | ~250K |
| Buy option | 2 (vault x2) | 6 | 3 | ~300K | ~100K |
| Settle option | 2 (oracle, vault) | 6 | 3 | ~200K | ~80K |
| Vault deposit | 1 (token transfer) | 4 | 3 | ~200K | ~70K |
| Roll vault epoch | 3 (options, vault, oracle) | 12 | 8 | ~1.2M | ~350K |
| Push oracle prices | 0 | 2 | N (N=num assets) | ~500K | ~150K |
| Update funding rate | 1 (oracle) | 4 | 2 | ~200K | ~70K |

**Mainnet limits for reference** (approximate, query `stellar network settings` for exact values):
- Max CPU per tx: ~100M instructions
- Max read entries: ~40
- Max write entries: ~25
- Max read bytes: ~200KB
- Max write bytes: ~65KB
- Max tx size: ~70KB

All operations are well within mainnet limits. The most expensive operation (`roll_vault_epoch` at ~1.2M CPU and 12 reads) uses ~1.2% of the CPU budget and 30% of read entries.

---

## Appendix D — Key External References

### Soroban / Stellar

| Resource | URL |
|---|---|
| Soroban Getting Started | https://developers.stellar.org/docs/build/smart-contracts/getting-started |
| Scaffold Stellar | https://scaffoldstellar.org/docs/quick-start |
| Soroban Example Contracts | https://github.com/stellar/soroban-examples (tag v23.0.0) |
| Soroban SDK Docs | https://docs.rs/soroban-sdk/latest/soroban_sdk/ |
| Custom Types | https://developers.stellar.org/docs/learn/encyclopedia/contract-development/types/custom-types |
| Storage & State Archival | https://developers.stellar.org/docs/learn/encyclopedia/storage/state-archival |
| Cross-Contract Calls | https://developers.stellar.org/docs/learn/encyclopedia/contract-development/contract-interactions/cross-contract |
| Token Standard (SEP-41) | https://developers.stellar.org/docs/build/smart-contracts/example-contracts/tokens |
| Fungible Token (OpenZeppelin) | https://developers.stellar.org/docs/build/smart-contracts/example-contracts/fungible-token |
| Resource Limits & Fees | https://developers.stellar.org/docs/networks/resource-limits-fees |
| Stellar Developer Discord | https://discord.gg/stellardev |

### RedStone Oracle

| Resource | URL |
|---|---|
| RedStone Introduction | https://docs.redstone.finance/docs/introduction |
| Stellar Landing Page | https://docs.redstone.finance/docs/dapps/non-evm/stellar |
| Soroban Rust Tutorial | https://docs.redstone.finance/docs/dapps/non-evm/stellar/rust-tutorial |
| TypeScript Connector | https://docs.redstone.finance/docs/dapps/non-evm/stellar/typescript-tutorial |
| Perpetuals Product | https://docs.redstone.finance/docs/dapps/redstone-perpetuals |
| Pull Model Docs | https://docs.redstone.finance/docs/dapps/redstone-pull |
| GitHub (stellar-connector) | https://github.com/redstone-finance/redstone-oracles-monorepo/tree/main/packages/stellar-connector |

### Axelar Cross-Chain

| Resource | URL |
|---|---|
| GMP Overview | https://docs.axelar.dev/dev/general-message-passing/overview |
| Stellar GMP Intro | https://docs.axelar.dev/dev/general-message-passing/stellar-gmp/intro |
| Stellar GMP Example | https://docs.axelar.dev/dev/general-message-passing/stellar-gmp/gmp-example |
| Stellar ITS | https://docs.axelar.dev/dev/send-tokens/stellar/intro |
| GitHub (amplifier-stellar) | https://github.com/axelarnetwork/axelar-amplifier-stellar |
| Multichain RWA Lending | https://blog.axelar.dev/multichain-rwa-lending-with-axelar-gmp |

### Derivatives Protocol Architecture References

| Resource | Why Study It |
|---|---|
| GMX V2 Docs (https://docs.gmx.io/) | Synthetic markets, two-phase execution, adaptive funding, ADL |
| Hyperliquid Docs (https://hyperliquid.gitbook.io/) | Orderbook design, cross-margin, partial liquidation, HLP backstop |
| Derive/Lyra Docs (https://docs.lyra.finance/) | Options pricing (Black-76/SVI), portfolio margin, Dutch auction liquidation |
| Synthetix V3 Docs (https://docs.synthetix.io/) | Multi-collateral, subaccounts, funding rate capping, ADL ranking |
| Perpetual Protocol V2 (https://support.perp.com/) | vAMM architecture (StellaX's perp model is based on this) |
| Opyn/Squeeth (https://opyn.gitbook.io/) | Power perpetuals, squeeth mechanics (future StellaX product) |

### DeFi Math

| Resource | Why |
|---|---|
| PRBMath (Solidity fixed-point library) | Patterns for integer-based math operations |
| Lyra Finance codebase (GitHub) | Reference for Black-Scholes in integer math |
| Abramowitz & Stegun Handbook | Normal CDF approximation formulas (Eq. 26.2.17) |

### Rust Language

| Resource | URL |
|---|---|
| The Rust Book | https://doc.rust-lang.org/book/ |
| Rust by Example | https://doc.rust-lang.org/rust-by-example/ |
| Rustlings | https://github.com/rust-lang/rustlings |

---

*This implementation plan represents the technical blueprint for building StellaX from scratch to production on Stellar/Soroban. Every phase is designed to be executed sequentially (respecting dependencies) with testable deliverables at each step. Total estimated duration: 20–26 weeks for a 2–3 person engineering team.*
