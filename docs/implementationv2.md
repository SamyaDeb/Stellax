
# StellaX V2 — End-to-End Implementation Plan

> **Target agent**: This document is a complete, self-contained blueprint for
> implementing StellaX V2 from first commit to mainnet-ready state.  
> Every section names the exact file to touch, the exact symbol to add/change,
> and the exact test to write. No guessing is required.
>
> **Current date**: April 2026  
> **Toolchain**: Rust 1.89, soroban-sdk 23, wasm32v1-none, Node 20, pnpm 9

---

## Table of Contents

1. [V1 Deployment Inventory (read-only reference)](#1-v1-deployment-inventory)
2. [V1 Codebase Map (what already exists)](#2-v1-codebase-map)
3. [V2 Architecture Overview](#3-v2-architecture-overview)
4. [Phase A — Oracle-Price Execution + Skew Fee (Replace vAMM)](#phase-a--oracle-price-execution--skew-fee)
5. [Phase B — Hybrid CLOB (Off-chain Orderbook + On-chain Settlement)](#phase-b--hybrid-clob)
6. [Phase C — Portfolio Margin + Options Greeks Aggregation](#phase-c--portfolio-margin)
7. [Phase D — Velocity-Based Funding Rate (Synthetix v3 Style)](#phase-d--velocity-based-funding)
8. [Phase E — SVI Volatility Surface + Batch IV Push](#phase-e--svi-volatility-surface)
9. [Phase F — Governance Token + Staking + Treasury Distribution](#phase-f--governance-token--staking)
10. [Phase G — Multi-Chain EVM Bridge Expansion](#phase-g--multi-chain-evm-bridge)
11. [Phase H — Event Indexer + WebSocket Keeper](#phase-h--event-indexer--websocket-keeper)
12. [Phase I — V2 Frontend (Orderbook UI + Portfolio View + Staking)](#phase-i--v2-frontend)
13. [Phase J — Integration Testing E2E](#phase-j--integration-testing)
14. [Phase K — Testnet Deployment + Upgrade](#phase-k--testnet-deployment)
15. [Phase L — Mainnet Deployment](#phase-l--mainnet-deployment)
16. [Appendix — New Contract Storage Layouts](#appendix)

---

## 1. V1 Deployment Inventory

These are live on **Stellar Testnet** and **Avalanche Fuji**. V2 upgrades them
in-place via `stellar contract upgrade` (same contract IDs, new WASM hash).

### Stellar Testnet Contract IDs
| Contract | Address |
|---|---|
| governor | `CB3VSLPIXYXEOZ34CGOOAHS5L5CW4YITAGBFODMMCZOA73KBM7OFL4PD` |
| oracle | `CCESFJNJ3HS6DH2ZOSGSPMHH2GHE4MWJCWQR5A3RGLZYVZ37E5WBZEXB` |
| vault | `CDDA3QFNHWZDX4IWHHNISPOI3R5KX4OPEUIQC5NA2RAB2HTMOS7YW4IM` |
| funding | `CBTHQWJUT3VITY7XXDJVR7IA4DPUECXIBW6V4DCCBSIQWDTY3VWT4JRI` |
| risk | `CBRF3VSZK2GOLKK4BHAH6GULEETDPAOZFLNTNQTHTCJEXVZF2V2FJWOX` |
| perp_engine | `CD3PV6GINVKT7VVM4HDBKUTWP2HJYJCCRWA2VJKWCP3B4SJQHE63MF7H` |
| options | `CBM3RVMH7EEJQUWEVHSKSDJFFBGDLLA7QVJMFWM46H2BUP6XODTJ7ZGT` |
| structured | `CCM5AQAZFBNG4R4SZDCZSQ6SZKX53QWNQ3EGKBXS7JNS5GP6LIKUYTPX` |
| treasury | `CCPGPJKOUTI5ES2DPFH5PPM2AP5RQPAESREHYEEPWJ46FY7JM6K7JUTF` |
| bridge | `CDTZX3CTVVHN67ONILVY7PHSQDGZHMKCP3EM4NHATYUYA5J5NYSDZMVL` |

### EVM Deployments
| Chain | Contract | Address |
|---|---|---|
| Avalanche Fuji | StellaXBridgeEVM | `0xcfae8a8305e2e2e603a785a38180aa542108819f` |

### Supporting Addresses
- **USDC token (testnet)**: `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`
- **Deployer key identity**: `stellax-deployer` in Stellar CLI keyring
- **Deployer pubkey**: `GAVFAXLV54GY7M4WZYIZQGP5NFRAJOUQA2LA4UDDUWVJCOIEPEMKYNQG`
- **RPC**: `https://soroban-testnet.stellar.org`

---

## 2. V1 Codebase Map

### Rust contracts (`contracts/`)
| Crate | Key types / functions | V2 change |
|---|---|---|
| `stellax-math` | `Position`, `Market`, `PriceData`, `OptionContract`, `VaultEpoch`, `MarginMode`; `mul_precision`, `div_precision`, `exp_fixed`, `ln_fixed`, `normal_cdf`, `sqrt_fixed`, `apply_bps`; constants `PRECISION=1e18`, `MAX_LEVERAGE=50`, `MAX_FUNDING_RATE_PER_HOUR` | Add new types: `LimitOrder`, `VolSurface`, `SkewState`, `PortfolioHealth` |
| `stellax-oracle` | `OracleConfig`, `PriceData`, `write_prices`, `get_price`, `verify_price_payload`; fallback to Reflector | Unchanged; feed `SKEW` symbol added to feed list |
| `stellax-vault` | `CollateralConfig`, `deposit`, `withdraw`, `lock_margin`, `unlock_margin`, `move_balance`, `get_total_collateral_value`, `get_free_collateral_value` | Add `credit`/`debit` entry points; add `get_balances_all` batch query |
| `stellax-perp-engine` | `VammState`, `open_position`, `close_position`, `modify_position`, `get_mark_price`, `register_market` | **Remove** `VammState`; replace with oracle-price execution + `SkewState`; add `create_order`, `execute_order`, `settle_matched_orders` |
| `stellax-funding` | `FundingState`, `update_funding`, `settle_funding`; funding rate = `(mark - index)/index` | Replace with velocity-based funding (separate Phase D) |
| `stellax-risk` | `AccountHealth`, `liquidate`, `adl`, `validate_new_pos_with_inputs`, insurance fund | Extend with portfolio margin; read options positions |
| `stellax-options` | `write_option`, `buy_option`, `settle_option`; flat IV (`VolatilitySurface { sigma }`) | Upgrade IV to SVI surface; add `set_vol_surface`, `get_implied_vol` |
| `stellax-structured` | Covered call + principal protected vaults; `roll_epoch`, SEP-41 shares | Mostly unchanged; wire to new options settlement |
| `stellax-bridge` | Axelar GMP+ITS; `execute`, `send_message`, `bridge_collateral_in/out`; action codes 1-4 | Add new chain configs; no logic change |
| `stellax-governor` | Multi-sig proposals + timelock + emergency pause | Add `RegisterStaking` action; register new CLOB contract |
| `stellax-treasury` | 60/20/20 split; `collect_fee`, `distribute` | Wire staker payout; add `distribute_staker_rewards` |

### New contracts to create (V2)
| Crate | Purpose |
|---|---|
| `contracts/stellax-clob` | On-chain limit-order settlement; verify off-chain signatures; match + execute |
| `contracts/stellax-staking` | Governance token staking; epoch reward distribution from treasury |

### TypeScript packages (`packages/`)
| Package | Key files | V2 change |
|---|---|---|
| `keeper` | `workers/oracle-pusher.ts`, `liquidation-bot.ts`, `funding-updater.ts`, `option-settler.ts`, `vault-roller.ts`, `bridge-keeper.ts` | Add `clob-matcher.ts` worker |
| `sdk` | `clients/{perp-engine,risk,vault,...}.ts`, `core/{client,executor,scval}.ts` | Add `ClobClient`; update `PerpEngineClient` for new entry points |
| `frontend` | `pages/TradePage.tsx`, `pages/OptionsPage.tsx`, `pages/VaultsPage.tsx` | Add orderbook panel, portfolio margin panel, staking page |

---

## 3. V2 Architecture Overview

```
EVM chains (Fuji, Arbitrum, Base, Optimism)
       │ Axelar GMP + ITS
       ▼
stellax-bridge  ─────────────────────────────────────────────┐
                                                             │ credit/debit
stellax-vault  (USDC, XLM, BENJI, USDY)                     │
     │ lock/unlock margin                                    │
     ├──────────────────────────────────────────────────┐    │
     ▼                                                  ▼    │
stellax-perp-engine (oracle-price + skew fee)   stellax-clob │
     │ settle_matched_orders ◄─────────────────────────┘    │
     ├── stellax-funding (velocity-based)                    │
     └── stellax-risk (portfolio margin: perps + options)    │
                  │                                          │
          stellax-options (SVI surface)                      │
                  │                                          │
          stellax-structured (epoch vaults)                  │

Keeper off-chain:
  oracle-pusher → oracle contract (every 10s)
  clob-matcher  → stellax-clob (per-ledger order matching)
  liquidation-bot → stellax-risk (every ledger)
  funding-updater → stellax-funding (every hour)
  option-settler  → stellax-options (at expiry)
  bridge-keeper   → stellax-bridge (15s poll)

stellax-governor (multisig+timelock) controls all contracts
stellax-treasury → stellax-staking (epoch staker rewards)
```

**Key V2 design decisions:**

1. **No vAMM** — price = oracle. Execution is always at oracle price adjusted by a
   skew fee that penalises the side adding open-interest imbalance. This is the
   GMX v2 / Synthetix Perps v3 model. Eliminates the testnet `MAX_SLIPPAGE_BYPASS`.

2. **CLOB via keeper** — a new `stellax-clob` contract stores signed `LimitOrder`
   structs. The keeper's `clob-matcher.ts` matches compatible orders off-chain
   and submits `settle_matched_orders(orders[])` in a single transaction.
   On-chain: verify Ed25519 signatures, check vault balances, move margin.

3. **Portfolio margin** — the risk engine aggregates net delta across all open
   perp positions and options for one user. A long perp + long put on the same
   asset reduces required margin because net delta is smaller.

4. **Velocity funding** — funding rate has inertia; it changes over time toward
   the premium/index ratio instead of jumping. Prevents funding rate
   manipulation.

5. **SVI volatility surface** — instead of one flat `sigma`, the options engine
   uses a Strike-Volatility Interpolation surface: `sigma(K, T)` from 5 SVI
   parameters per expiry. Enables fair pricing across the full strike ladder.

---

## Phase A — Oracle-Price Execution + Skew Fee

**Goal**: Replace `VammState` entirely. Perp trades execute at oracle price ± a
skew fee based on OI imbalance. This is the single most important V2 change.

**Files to modify**: `contracts/stellax-perp-engine/src/lib.rs`,
`contracts/stellax-math/src/types.rs`

### A.1 — Add `SkewState` to shared types

**File**: `contracts/stellax-math/src/types.rs`

Add after the `VaultEpoch` struct:

```rust
/// Per-market skew tracking for oracle-price perp execution.
/// Replaces VammState in V2.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkewState {
    /// Cumulative OI imbalance in base units (long - short), 18-dec.
    pub skew: i128,
    /// Governance-set scaling factor for skew fee (e.g. 1e14 = 0.01%).
    pub skew_scale: i128,
    /// Maker rebate in bps (negative fee for adding liquidity to the thin side).
    pub maker_rebate_bps: u32,
}
```

Also add to `constants.rs`:

```rust
/// Default skew scale: 1e14 (0.01% skew fee per 1:1 OI imbalance unit).
pub const DEFAULT_SKEW_SCALE: i128 = 100_000_000_000_000; // 1e14
```

### A.2 — Remove VammState; add SkewState from perp engine

**File**: `contracts/stellax-perp-engine/src/lib.rs`

1. **Delete** the `VammState` struct (lines ~64-70).
2. **Delete** `DataKey::Vamm(u32)` from the `DataKey` enum.
3. **Add** `DataKey::SkewState(u32)` to `DataKey`.
4. **Add** `SkewState` import from `stellax_math`.
5. **Delete** functions: `update_k`, `get_mark_price` (old vAMM version).
6. **Delete** `MarketParams::price_impact_factor` field; replace with nothing
   (price impact is now handled by skew fee, not AMM curves).
7. **Add** new helper `get_execution_price`:

```rust
/// Computes the trade execution price using oracle price adjusted by skew fee.
///
/// execution_price = oracle_price * (1 + skew_fee_rate)
/// where:
///   skew_fee_rate = (current_skew + delta_skew/2) / skew_scale
///   delta_skew = +size for long, -size for short (in base units)
///
/// If the trade reduces skew (maker), apply maker_rebate_bps instead (negative fee).
fn get_execution_price(
    oracle_price: i128,
    skew: &SkewState,
    size: i128,
    is_long: bool,
) -> Result<i128, PerpError> {
    let delta_skew = if is_long { size } else { -size };
    // Mid-fill skew: average of before and after
    let mid_skew = skew.skew.checked_add(delta_skew / 2).ok_or(PerpError::MathOverflow)?;
    
    let is_maker = (is_long && mid_skew < 0) || (!is_long && mid_skew > 0);
    
    if is_maker && skew.maker_rebate_bps > 0 {
        // Maker gets a rebate (price improvement)
        let rebate = apply_bps(oracle_price, skew.maker_rebate_bps);
        return Ok(if is_long {
            oracle_price.checked_sub(rebate).ok_or(PerpError::MathOverflow)?
        } else {
            oracle_price.checked_add(rebate).ok_or(PerpError::MathOverflow)?
        });
    }
    
    // Taker skew fee
    let skew_fee_numerator = mid_skew.unsigned_abs() as i128;
    let skew_fee = mul_precision_checked(
        div_precision_checked(skew_fee_numerator, skew.skew_scale).ok_or(PerpError::MathOverflow)?,
        oracle_price,
    ).ok_or(PerpError::MathOverflow)?;
    
    // Long trades pay above oracle; short trades pay below oracle
    Ok(if is_long {
        oracle_price.checked_add(skew_fee).ok_or(PerpError::MathOverflow)?
    } else {
        oracle_price.checked_sub(skew_fee).ok_or(PerpError::MathOverflow)?
    })
}
```

8. **Modify** `open_position`: replace `preview_trade` + `ensure_slippage` block with:

```rust
// V2: get execution price from oracle + skew
let skew = read_skew_state(&env, market_id)?;
let execution_price = get_execution_price(oracle_price.price, &skew, size, is_long)?;

// Slippage guard: user-provided max_slippage_bps still applies
ensure_slippage(execution_price, oracle_price.price, max_slippage_bps)?;

// Update skew state
let new_skew_val = if is_long {
    skew.skew.checked_add(size).ok_or(PerpError::MathOverflow)?
} else {
    skew.skew.checked_sub(size).ok_or(PerpError::MathOverflow)?
};
let updated_skew = SkewState { skew: new_skew_val, ..skew };
write_skew_state(&env, market_id, &updated_skew);
```

9. **Modify** `close_position`: when closing, reverse skew update (subtract
   `closed_size` from the skew in the direction of the position).

10. **Modify** `register_market`: remove `base_reserve`, `quote_reserve` params;
    add `skew_scale: i128`, `maker_rebate_bps: u32` params. Initialize
    `SkewState { skew: 0, skew_scale, maker_rebate_bps }`.

11. **Add** helper CRUD functions for skew state:
    `read_skew_state`, `write_skew_state` (using
    `env.storage().persistent().get/set(&DataKey::SkewState(market_id))`).

12. **Add** `get_skew_state(env, market_id) -> SkewState` as public function
    (read-only for frontend/keeper).

13. **Update** `get_mark_price` to simply return current oracle price
    (since there is no longer a vAMM mark price distinct from oracle):

```rust
pub fn get_mark_price(env: Env, market_id: u32) -> Result<i128, PerpError> {
    bump_instance_ttl(&env);
    let market = read_active_market(&env, market_id)?;
    let cfg = read_config(&env)?;
    let oracle = OracleClient::new(&env, &cfg.oracle);
    Ok(oracle.get_price(&market.base_asset).price)
}
```

14. **Update** `CONTRACT_VERSION` to `2`.

### A.3 — Update funding contract to use oracle price as mark

**File**: `contracts/stellax-funding/src/lib.rs`

The `current_funding_rate` function calls
`perp.get_mark_price(market_id)` and compares to oracle. Once Phase D is done
this will be replaced. For now, since `get_mark_price` now returns oracle price,
the rate will always be ~0 until Phase D (velocity funding) is implemented.
This is acceptable and correct: no vAMM divergence = no spurious funding.

### A.4 — Update tests

**File**: `contracts/stellax-perp-engine/src/lib.rs` (unit tests section)
**File**: `tests/tests/*.rs` (integration tests)

1. Remove all test code that constructs `VammState` or calls `update_k`.
2. Remove import of `sqrt_fixed` from perp engine (no longer needed).
3. Update `register_market` calls to pass `skew_scale`, `maker_rebate_bps`
   instead of `base_reserve`, `quote_reserve`.
4. In integration tests (`tests/src/lib.rs`), update `Protocol::setup()` to
   use new `register_market` signature.
5. Add test `test_skew_fee_increases_with_imbalance`: open long, then open
   another long, verify execution price is higher on second trade.
6. Add test `test_maker_rebate_for_thin_side`: open large long, then open short
   (reducing skew), verify short execution price is *better* than oracle.
7. Remove `MAX_SLIPPAGE_BYPASS` from
   `packages/frontend/src/pages/trade/OrderForm.tsx` line ~24 (no longer needed
   since oracle-price execution eliminates the testnet vAMM divergence).

---

## Phase B — Hybrid CLOB

**Goal**: Add a new `stellax-clob` Soroban contract for on-chain limit order
settlement. A keeper off-chain matches orders and submits batched fill
transactions. Also add request-execute (two-phase) pattern to perp engine for
MEV resistance.

### B.1 — New contract scaffold

```
contracts/stellax-clob/
  Cargo.toml
  src/
    lib.rs
```

**File**: `contracts/stellax-clob/Cargo.toml`

```toml
[package]
name = "stellax-clob"
version.workspace = true
edition.workspace = true
license.workspace = true

[lib]
crate-type = ["cdylib"]
doctest = false

[dependencies]
soroban-sdk = { workspace = true }
stellax-math = { workspace = true }

[dev-dependencies]
soroban-sdk = { workspace = true, features = ["testutils"] }
```

Add `"contracts/stellax-clob"` to the `members` array in root `Cargo.toml`.

### B.2 — `LimitOrder` struct (add to shared types)

**File**: `contracts/stellax-math/src/types.rs` — append:

```rust
/// Status of a limit order in the CLOB.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OrderStatus {
    Open,
    Filled,
    Cancelled,
    Expired,
}

/// A signed limit order placed off-chain and submitted to the CLOB contract.
/// The `signature` is an Ed25519 signature over the canonical hash of all
/// other fields (excluding `status` and `filled_size`).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LimitOrder {
    pub order_id:    u64,
    pub trader:      Address,
    pub market_id:   u32,
    pub size:        i128,       // 18-dec base units
    pub price:       i128,       // 18-dec limit price in USD
    pub is_long:     bool,
    pub leverage:    u32,
    pub expiry:      u64,        // ledger timestamp after which order is void
    pub nonce:       u64,        // prevents replay; monotonically increasing per trader
    pub signature:   BytesN<64>, // Ed25519 sig over Blake2b hash of above fields
    pub status:      OrderStatus,
    pub filled_size: i128,
}
```

### B.3 — Implement `stellax-clob/src/lib.rs`

Full implementation outline — implement each function body:

```rust
#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, contracterror,
                  symbol_short, Address, BytesN, Env, Vec};
use stellax_math::{LimitOrder, OrderStatus, PRECISION,
                   TTL_BUMP_INSTANCE, TTL_BUMP_PERSISTENT,
                   TTL_THRESHOLD_INSTANCE, TTL_THRESHOLD_PERSISTENT};

const CONTRACT_VERSION: u32 = 1;

#[contracttype]
enum DataKey {
    Config,
    Order(u64),
    TraderNonce(Address),    // last used nonce per trader
    NextOrderId,
    Version,
}

#[contracttype]
pub struct ClobConfig {
    pub admin:       Address,
    pub perp_engine: Address,
    pub vault:       Address,
    pub keeper:      Address,  // only keeper may call settle_matched_orders
}

#[contract]
pub struct StellaxClob;

#[contractimpl]
impl StellaxClob {
    /// Initialise once.
    pub fn __constructor(env: Env, admin: Address, perp_engine: Address,
                         vault: Address, keeper: Address) { ... }

    /// Trader submits a signed limit order. Verifies Ed25519 signature
    /// over `order_canonical_bytes(order)` using `env.crypto().ed25519_verify`.
    /// Stores order with status=Open in Temporary storage (TTL = order.expiry - now).
    pub fn place_order(env: Env, order: LimitOrder) -> u64 { ... }

    /// Trader cancels their own open order.
    pub fn cancel_order(env: Env, caller: Address, order_id: u64) { ... }

    /// Keeper submits a matched pair (or list of matched orders).
    /// For each pair:
    ///   1. Load both orders, verify status=Open, not expired.
    ///   2. Verify prices cross (buy.price >= sell.price).
    ///   3. Compute fill_size = min(buy.remaining, sell.remaining).
    ///   4. Compute fill_price = midpoint.
    ///   5. Call perp_engine.execute_clob_fill(buy_order_id, sell_order_id,
    ///                                         fill_size, fill_price).
    ///   6. Update order filled_size/status.
    pub fn settle_matched_orders(env: Env, caller: Address,
                                  buy_id: u64, sell_id: u64) -> i128 { ... }

    /// Read a single order by ID.
    pub fn get_order(env: Env, order_id: u64) -> LimitOrder { ... }

    /// Read current nonce for a trader (for off-chain order construction).
    pub fn get_nonce(env: Env, trader: Address) -> u64 { ... }
}

/// Canonical bytes to sign: [order_id(8) | market_id(4) | size(16) | price(16) |
///   is_long(1) | leverage(4) | expiry(8) | nonce(8)] = 65 bytes total.
fn order_canonical_bytes(env: &Env, order: &LimitOrder) -> BytesN<32> {
    // Assemble bytes, hash with env.crypto().sha256() or keccak256()
    // and return as BytesN<32> for ed25519_verify.
    ...
}
```

### B.4 — Add `execute_clob_fill` to perp engine

**File**: `contracts/stellax-perp-engine/src/lib.rs` — add new entry point:

```rust
/// Called by the CLOB contract only. Executes a matched fill between two orders
/// without requiring `user.require_auth()` (the auth happened in `place_order`).
/// The perp engine verifies `caller == cfg.clob` (add clob to PerpConfig).
pub fn execute_clob_fill(
    env: Env,
    caller: Address,
    buyer: Address,
    seller: Address,
    market_id: u32,
    fill_size: i128,
    fill_price: i128,
) -> Result<(u64, u64), PerpError> { ... }
```

Also add `clob: Address` field to `PerpConfig` struct.

### B.5 — Add request-execute (two-phase) orders to perp engine

Two-phase execution protects against oracle price frontrunning:

1. **Add** `DataKey::PendingOrder(u64)` to perp engine's `DataKey` enum.
2. **Add** `PendingOrder` struct:

```rust
#[contracttype]
pub struct PendingOrder {
    pub user:           Address,
    pub market_id:      u32,
    pub size:           i128,
    pub is_long:        bool,
    pub leverage:       u32,
    pub max_slippage:   u32,
    pub order_type:     OrderType,    // Market | Limit(price) | StopLoss(price) | TP(price)
    pub created_ledger: u32,
    pub expiry_ledger:  u32,          // auto-expire if not executed within N ledgers
}

#[contracttype]
pub enum OrderType {
    Market,
    Limit(i128),
    StopLoss(i128),
    TakeProfit(i128),
}
```

3. **Add** `create_order(env, user, market_id, size, is_long, leverage, max_slippage, order_type) -> u64`
   — stores `PendingOrder` in Temporary storage; no vault interaction yet.

4. **Add** `execute_order(env, caller, order_id, price_payload)` — callable by
   keeper; validates trigger conditions, then executes via full
   `open_position` logic. Keeper must call within the execution window
   (e.g. 30 ledgers ≈ 150 seconds).

5. **Add** `cancel_order(env, user, order_id)` — user cancels pending order.
   Requires `user.require_auth()`.

### B.6 — Keeper: CLOB matcher worker

**File**: `packages/keeper/src/workers/clob-matcher.ts` (create new file)

```typescript
/**
 * CLOB Matcher — reads open orders from on-chain CLOB contract,
 * matches compatible buy/sell pairs, and submits settle_matched_orders.
 *
 * Algorithm:
 *   1. Fetch all Open orders from the CLOB contract (via RPC batch read).
 *   2. Bucket by market_id.
 *   3. Sort buys descending by price, sells ascending by price.
 *   4. Walk both lists; match when buy.price >= sell.price.
 *   5. For each match, call clobClient.settleMatchedOrders(buyId, sellId).
 *
 * Runs every ledger close (~5 seconds).
 */
export class ClobMatcher extends BaseWorker {
  readonly name = "clob-matcher";
  async tick(): Promise<void> { ... }
}
```

Register this worker in `packages/keeper/src/index.ts` alongside existing workers.

### B.7 — Add SDK client for CLOB

**File**: `packages/sdk/src/clients/clob.ts` (create new):

```typescript
export class ClobClient extends ContractClient {
  async placeOrder(order: LimitOrder, opts: InvokeOptions): Promise<InvokeResult>
  async cancelOrder(caller: string, orderId: bigint, opts: InvokeOptions): Promise<InvokeResult>
  async settleMatchedOrders(caller: string, buyId: bigint, sellId: bigint, opts: InvokeOptions): Promise<InvokeResult>
  async getOrder(orderId: bigint): Promise<LimitOrder>
  async getNonce(trader: string): Promise<bigint>
}
```

Export from `packages/sdk/src/index.ts`.

---

## Phase C — Portfolio Margin

**Goal**: The risk engine aggregates net delta across perp positions AND option
positions for the same user. A long perp + long put reduces required margin.

### C.1 — Add portfolio margin types to shared types

**File**: `contracts/stellax-math/src/types.rs` — append:

```rust
/// Aggregated Greek values across all positions for a user.
/// Used by the risk engine to compute portfolio margin.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PortfolioGreeks {
    /// Net delta per market (market_id → net_delta in base units, 18-dec).
    /// Positive = net long, negative = net short.
    pub net_delta: Map<u32, i128>,   // soroban_sdk::Map
    /// Notional value of all open positions, USD 18-dec.
    pub total_notional: i128,
    /// Net portfolio delta magnitude (sum of |net_delta_i * price_i|), USD 18-dec.
    pub net_delta_notional: i128,
}

/// Result of portfolio-aware margin calculation.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PortfolioHealth {
    pub total_collateral_value: i128,
    pub portfolio_margin_required: i128,  // reduced vs sum of individual margins
    pub free_collateral:          i128,
    pub liquidatable:             bool,
    pub net_delta_usd:            i128,   // net directional exposure
}
```

Import `soroban_sdk::Map` in types.rs.

### C.2 — Extend risk engine

**File**: `contracts/stellax-risk/src/lib.rs`

1. **Add** `options_engine: Address` field to `RiskConfig`.
2. **Add** cross-contract trait for options:

```rust
#[contractclient(name = "OptionsEngineClient")]
pub trait OptionsEngineInterface {
    fn get_user_options(env: Env, user: Address) -> Vec<OptionContract>;
    fn get_option_delta(env: Env, option_id: u64) -> i128; // N(d1) for calls, N(d1)-1 for puts
}
```

3. **Add** `compute_portfolio_greeks(env, user) -> PortfolioGreeks`:
   - Fetch all perp positions via `PerpEngineClient::get_positions_by_user`.
   - Fetch all option contracts via `OptionsEngineClient::get_user_options`.
   - For each perp: `delta = position.size * (if is_long then 1 else -1)`.
   - For each option: `delta = OptionsEngineClient::get_option_delta(option_id) * option.size`.
   - Aggregate `net_delta` map per `market_id`.
   - Compute `net_delta_notional = sum(|net_delta[m]| * oracle_price[m])`.
   - Return `PortfolioGreeks`.

4. **Add** `get_portfolio_health(env, user) -> PortfolioHealth`:
   - Call `compute_portfolio_greeks`.
   - Portfolio margin = `net_delta_notional * initial_margin_ratio`
     instead of `sum(notional_i * initial_margin_ratio_i)`.
   - This can be 20-50% lower for hedged portfolios.
   - `free_collateral = total_collateral - portfolio_margin`.

5. **Modify** `validate_new_pos_with_inputs` to accept an optional
   `use_portfolio_margin: bool` flag. When true, use portfolio margin calculation.

6. **Modify** `get_account_health` to call `get_portfolio_health` when the user
   has both perp and option positions on at least one market.

7. **Add** `get_option_delta` to `stellax-options/src/lib.rs`:

```rust
/// Returns the Black-Scholes delta of an option position.
/// Call delta = N(d1), Put delta = N(d1) - 1.
pub fn get_option_delta(env: Env, option_id: u64) -> Result<i128, OptionsError> { ... }
```

### C.3 — Tests

1. Test `compute_portfolio_greeks`: create 1 long perp + 1 long put (same market);
   verify net delta is substantially lower than each individually.
2. Test `get_portfolio_health`: hedged portfolio should have lower margin
   requirement than same positions without hedging.
3. Test liquidation still works: force portfolio under maintenance; verify
   `liquidatable=true`.

---

## Phase D — Velocity-Based Funding Rate

**Goal**: Replace the instantaneous `(mark-index)/index` funding rate with a
velocity model. The rate is a state variable that drifts toward the premium
ratio, not jumps to it. This prevents manipulation and is the Synthetix v3
approach.

### D.1 — Extend `FundingState`

**File**: `contracts/stellax-funding/src/lib.rs`

Replace `FundingState` struct:

```rust
#[contracttype]
pub struct FundingState {
    pub accumulated_funding_long:  i128,
    pub accumulated_funding_short: i128,
    pub last_update_timestamp:     u64,
    pub last_funding_rate:         i128,
    /// V2 addition: current rate velocity (units: rate-per-second-per-second).
    pub funding_velocity:          i128,
    /// V2 addition: the current instantaneous funding rate (not recalculated
    /// each tick — it drifts via velocity integration).
    pub current_rate:              i128,
}
```

### D.2 — Velocity funding update logic

**File**: `contracts/stellax-funding/src/lib.rs` — replace `update_funding` inner logic:

```
New algorithm (per market per update tick):
  premium = (oracle_price - mark_price) / oracle_price
  // with oracle-price execution: mark_price ≈ oracle_price + skew_delta
  // so premium ≈ -skew_fee_rate

  velocity_delta = premium * funding_factor

  clamped_velocity = clamp(
      state.funding_velocity + velocity_delta * elapsed_secs,
      -MAX_FUNDING_VELOCITY, MAX_FUNDING_VELOCITY
  )

  new_rate = clamp(
      state.current_rate + clamped_velocity * elapsed_secs,
      -MAX_FUNDING_RATE_PER_HOUR, MAX_FUNDING_RATE_PER_HOUR
  )

  accumulated_delta = new_rate * elapsed_secs / SECS_PER_HOUR

  state.accumulated_funding_long  += accumulated_delta
  state.accumulated_funding_short -= accumulated_delta
  state.funding_velocity  = clamped_velocity
  state.current_rate      = new_rate
  state.last_funding_rate = new_rate
```

Add constants to `contracts/stellax-math/src/constants.rs`:

```rust
pub const MAX_FUNDING_VELOCITY: i128 = 3_000_000_000_000_000; // 0.3% / hour limit
pub const SECS_PER_HOUR: i128 = 3_600;
```

### D.3 — Add `get_funding_velocity` query

```rust
pub fn get_funding_velocity(env: Env, market_id: u32) -> Result<i128, FundingError>
```

Update `CONTRACT_VERSION` in funding contract to `2`.

### D.4 — Tests

1. Test velocity ramps up: call `update_funding` with mark > index 10 times;
   verify `current_rate` increases across calls (does not jump immediately).
2. Test reversal: flip to mark < index; verify rate decelerates then reverses.
3. Test clamping: extreme premium; verify rate never exceeds `MAX_FUNDING_RATE_PER_HOUR`.
4. Update existing funding tests to set initial `funding_velocity = 0`.

---

## Phase E — SVI Volatility Surface

**Goal**: Replace flat `VolatilitySurface { sigma }` in options with a
Strike-Volatility Interpolation surface (5 params per expiry bucket). Enables
correct pricing across the full strike ladder.

### E.1 — New SVI types

**File**: `contracts/stellax-math/src/types.rs` — append:

```rust
/// SVI (Stochastic Volatility Inspired) parameterisation for one expiry bucket.
/// σ²(k) = a + b*(ρ*(k - m) + sqrt((k - m)² + σ²))
/// where k = ln(K/F) (log-moneyness), F = forward price.
/// All params are 18-decimal fixed-point.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SviParams {
    pub a:         i128,   // vertical translation
    pub b:         i128,   // slope of wings
    pub rho:       i128,   // correlation (-1 to 1)
    pub m:         i128,   // ATM log-moneyness (typically ~0)
    pub sigma_svi: i128,   // ATM smoothness
    pub expiry:    u64,    // unix timestamp of this expiry bucket
    pub updated_at: u64,
}
```

### E.2 — Modify options engine storage

**File**: `contracts/stellax-options/src/lib.rs`

1. Replace `DataKey::ImpliedVol(u32)` with `DataKey::SviSurface(u32, u64)`
   (keyed by `market_id, expiry`).
2. Keep `DataKey::ImpliedVol(u32)` as legacy for V1 data migration.
3. Replace `VolatilitySurface` usage with `SviParams`.
4. Modify `set_implied_volatility` → rename to `set_vol_surface(market_id, params: SviParams)`:
   - Only keeper can call.
   - Validate: `sigma_svi > 0`, `|rho| < PRECISION` (i.e. |rho| < 1.0).
   - Store under `DataKey::SviSurface(market_id, params.expiry)`.

5. Add `get_implied_vol(market_id, strike, expiry) -> i128`:

```rust
/// Computes implied vol for a given strike and expiry using stored SVI params.
/// Falls back to flat sigma from legacy ImpliedVol if no SVI surface found.
pub fn get_implied_vol(
    env: Env,
    market_id: u32,
    strike: i128,
    expiry: u64,
) -> Result<i128, OptionsError> {
    // Load SVI params for (market_id, nearest expiry bucket).
    // Compute k = ln(strike / forward_price) using ln_fixed().
    // Compute w = a + b*(rho*(k - m) + sqrt((k - m)^2 + sigma_svi^2))
    // Return sqrt(w) as the implied vol.
    // Clamp result to [1%, 300%] for safety.
}
```

6. Update `calculate_option_price` to call `get_implied_vol(market_id, strike, expiry)`
   instead of reading flat `sigma`.

7. Update `write_option` and `settle_option` to use updated pricing.

8. **Migration function** for V2 upgrade: `migrate_v1_vol_to_svi(market_id)` — reads
   legacy `DataKey::ImpliedVol(market_id)`, constructs a flat SVI surface
   (set `b=0`, `a=sigma^2`, others=0), stores under new key.

### E.3 — Options Greeks: batch query

Add to options contract:

```rust
pub fn get_option_greeks(env: Env, option_id: u64) -> Result<OptionGreeks, OptionsError>
```

Add `OptionGreeks` to `stellax-math/src/types.rs`:

```rust
#[contracttype]
pub struct OptionGreeks {
    pub delta:   i128,   // N(d1) for call, N(d1)-1 for put
    pub gamma:   i128,   // PDF(d1) / (S * sigma * sqrt(T))
    pub vega:    i128,   // S * PDF(d1) * sqrt(T)
    pub theta:   i128,   // daily time decay
    pub iv:      i128,   // implied vol from SVI surface
}
```

### E.4 — Keeper: SVI IV push

**File**: `packages/keeper/src/workers/oracle-pusher.ts`

Extend the existing oracle pusher: after pushing prices, also push SVI params.

Add new function `pushSviSurface(marketId, expiryTimestamp)`:
- Fetch raw option market data from an external source (Deribit API or Derive/Lyra API).
- Fit SVI parameters to the vol surface using least-squares (TypeScript implementation).
- Call `options_contract.set_vol_surface(marketId, sviParams)`.

### E.5 — Tests

1. Test `get_implied_vol` ATM: set SVI params with `b=0` (flat vol = sqrt(a));
   verify returned vol equals sqrt(a).
2. Test smile: set meaningful SVI params (b > 0, |rho| < 1); verify OTM call
   has higher IV than ATM.
3. Test `calculate_option_price` uses SVI vol vs flat vol: expect different
   prices for OTM strikes.
4. Test migration: store V1 flat vol, call `migrate_v1_vol_to_svi`, verify
   new surface returns same ATM vol.

---

## Phase F — Governance Token + Staking

**Goal**: Create `stellax-staking` contract. Issue a governance token (STLX,
SEP-41 compliant). Stakers lock STLX for epochs to earn treasury fees.
Completes the 20% staker bucket in the treasury.

### F.1 — Create `stellax-staking` contract

```
contracts/stellax-staking/
  Cargo.toml
  src/
    lib.rs
```

**Cargo.toml**: mirror `stellax-clob/Cargo.toml`, change `name = "stellax-staking"`.
Add to root workspace `members`.

### F.2 — STLX token contract (SEP-41)

Rather than implementing a full SEP-41 in-contract, deploy on Stellar using the
standard Stellar Asset Contract (SAC) for a Classic asset with:
- Ticker: `STLX`
- Issuer: deployer account
- Decimals: 7 (Stellar Classic standard)

The staking contract interacts with the STLX SAC via
`soroban-token-sdk`'s `Token` client.

### F.3 — Staking contract entry points

```rust
#[contracttype]
pub struct StakingConfig {
    pub admin:        Address,
    pub stlx_token:   Address,   // STLX SAC address
    pub treasury:     Address,
    pub epoch_duration_secs: u64,
}

#[contracttype]
pub struct StakeEntry {
    pub staker:          Address,
    pub amount:          i128,   // STLX staked (7-dec)
    pub stake_epoch:     u32,
    pub last_claim_epoch: u32,
}

#[contracttype]
pub struct EpochRewardPool {
    pub epoch_id:        u32,
    pub total_staked:    i128,
    pub reward_token:    Address, // USDC
    pub reward_amount:   i128,    // total rewards deposited by treasury for this epoch
    pub claimed_amount:  i128,
}
```

Entry points:
- `stake(user: Address, amount: i128)` — transfer STLX from user to contract, record `StakeEntry`.
- `unstake(user: Address, amount: i128)` — return STLX after current epoch ends (locked until epoch boundary).
- `claim_rewards(user: Address)` — calculate `user_share = stake/total_staked * reward_amount` for unclaimed epochs; transfer USDC.
- `deposit_epoch_rewards(caller: Address, reward_token: Address, amount: i128)` — called by treasury only; funds a new `EpochRewardPool`.
- `get_stake(user: Address) -> StakeEntry`.
- `get_epoch_reward(epoch_id: u32) -> EpochRewardPool`.

### F.4 — Wire treasury to staking

**File**: `contracts/stellax-treasury/src/lib.rs`

1. Add `staking: Address` field to `TreasuryConfig`.
2. Modify `distribute()`: when distributing staker portion, call:
   `StakingClient::deposit_epoch_rewards(caller, usdc_token, staker_amount)`.
3. Add `StakingClient` trait:

```rust
#[contractclient(name = "StakingClient")]
pub trait StakingInterface {
    fn deposit_epoch_rewards(env: Env, caller: Address, token: Address, amount: i128);
}
```

### F.5 — Governance: add `RegisterStaking` action

**File**: `contracts/stellax-governor/src/lib.rs`

Add to `GovernanceAction` enum:

```rust
/// Register the staking contract address in treasury and other protocol contracts.
RegisterStaking,
/// Update STLX token address and distribution parameters.
UpdateStaking,
```

### F.6 — Tests

1. Test `stake` → `deposit_epoch_rewards` → `claim_rewards`: verify correct
   proportional USDC payout.
2. Test unstake cooldown: verify STLX not returned mid-epoch.
3. Test multi-staker: 3 stakers with different amounts; verify rewards proportional.

---

## Phase G — Multi-Chain EVM Bridge Expansion

**Goal**: Deploy `StellaXBridgeEVM.sol` on Arbitrum One, Base Mainnet, and
Optimism. Update Stellar bridge trusted sources.

### G.1 — EVM contract: no code changes needed

The existing `contracts/evm/src/StellaXBridgeEVM.sol` is chain-agnostic.
Only constructor parameters change per chain (gateway address, gasService address,
USDC address, stellarBridgeAddress).

### G.2 — Foundry deployments per chain

Create `contracts/evm/script/DeployMultiChain.s.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/StellaXBridgeEVM.sol";

contract DeployMultiChain is Script {
    struct ChainConfig {
        address gateway;
        address gasService;
        address usdc;
        string stellarBridge;
        string chainName;
    }

    function run() external {
        // Read chain config from environment or hardcoded per-chain values
        // Deploy StellaXBridgeEVM with correct addresses per chain
        // Verify and record deployed addresses
    }
}
```

Per-chain Axelar addresses (fill in from Axelar docs):
- **Arbitrum Mainnet**: gateway `0xe432150cce91c13a887f7D836923d5597adD8E31`, gasService `0x2d5d7d31F671F86C782533cc367F14109a082712`
- **Base Mainnet**: gateway `0xe432150cce91c13a887f7D836923d5597adD8E31`, gasService `0x2d5d7d31F671F86C782533cc367F14109a082712`
- **Optimism Mainnet**: gateway `0xe432150cce91c13a887f7D836923d5597adD8E31`, gasService `0x2d5d7d31F671F86C782533cc367F14109a082712`

USDC addresses per chain are the standard Circle USDC contract addresses.

### G.3 — Update Stellar bridge trusted sources

After EVM deployments, for each new chain, call on Stellar:

```bash
stellar contract invoke \
  --id <BRIDGE_CONTRACT_ID> \
  --source-account stellax-deployer \
  --network testnet \
  -- update_trusted_source \
  --chain_name "arbitrum" \
  --address "0x<ARBITRUM_BRIDGE_ADDRESS>"
```

Repeat for `base`, `optimism`.

### G.4 — Update keeper bridge-keeper config

**File**: `packages/keeper/src/workers/bridge-keeper.ts`

Add constant array of EVM bridge addresses to watch:

```typescript
const EVM_BRIDGES: Array<{ chain: string; address: string }> = [
  { chain: "Avalanche",     address: "0xcfae8a8305e2e2e603a785a38180aa542108819f" },
  { chain: "arbitrum",      address: "0x<ARBITRUM_BRIDGE>" },
  { chain: "base",          address: "0x<BASE_BRIDGE>" },
  { chain: "optimism",      address: "0x<OPTIMISM_BRIDGE>" },
];
```

The keeper polls the Axelar GMP API for each bridge contract and processes deposits.

### G.5 — Frontend: multi-chain source selector

**File**: `packages/frontend/src/pages/BridgePage.tsx` — update chain selector
dropdown to include Arbitrum, Base, Optimism alongside Avalanche Fuji.

---

## Phase H — Event Indexer + WebSocket Keeper

**Goal**: Replace the session-store position tracking in the frontend (which
loses positions on page refresh) with a proper off-chain indexer. Add
WebSocket streaming so the frontend gets real-time updates.

### H.1 — Create indexer package

```
packages/indexer/
  package.json
  tsconfig.json
  src/
    index.ts
    db.ts          # SQLite via better-sqlite3
    watcher.ts     # polls Soroban RPC event stream
    api.ts         # Express HTTP + WebSocket server
```

**`packages/indexer/src/watcher.ts`**:
- Use `@stellar/stellar-sdk`'s `server.getEvents({ filters: [...] })` to poll
  for all StellaX contract events in batches.
- Parse events by contract + topic: `pos_opened`, `pos_closed`, `liq`, `dep_in`,
  `dep_out`, `option_written`, `option_bought`, `option_settled`.
- Upsert into SQLite tables: `positions`, `trades`, `liquidations`, `deposits`.

**`packages/indexer/src/api.ts`**:
- REST endpoint: `GET /positions?user=<address>` → list open positions.
- REST endpoint: `GET /trades?user=<address>&limit=50` → trade history.
- WebSocket: on new event, push to all subscribed clients with:
  `{ type: "position_update" | "trade" | "liquidation", data: {...} }`.

### H.2 — Update keeper liquidation bot to use indexer

**File**: `packages/keeper/src/workers/liquidation-bot.ts`

Replace the `PositionSource` interface stub with an HTTP call to the indexer:

```typescript
export class IndexerPositionSource implements PositionSource {
  constructor(private readonly indexerUrl: string) {}
  async getOpenPositions(): Promise<PositionLike[]> {
    const resp = await fetch(`${this.indexerUrl}/positions`);
    return resp.json();
  }
}
```

### H.3 — Connect frontend to indexer

**File**: `packages/frontend/src/hooks/usePositions.ts` (create new):

```typescript
export function usePositions(address: string | null) {
  // WebSocket subscription to indexer
  // Falls back to session store if indexer unavailable
}
```

Remove `useSessionStore` position tracking from `TradePage.tsx` once indexer
is live. Session store can still be used as a write-through cache.

---

## Phase I — V2 Frontend

**Goal**: Upgrade the UI to reflect all V2 mechanics: orderbook panel, portfolio
margin display, staking page, live funding velocity, SVI vol surface.

### I.1 — Orderbook panel

**File**: `packages/frontend/src/pages/trade/OrderBook.tsx` (create new)

Display live bids/asks from the CLOB contract:
- Fetch all Open orders for the selected market from `ClobClient`.
- Aggregate by price level (group within 0.1% bands).
- Render as a classic depth table: red (asks/sells) above, green (bids/buys) below.
- Show user's own open orders highlighted.

**File**: `packages/frontend/src/pages/TradePage.tsx`

Add `<OrderBook marketId={selectedId} />` component to the trading layout.
Add tab switcher: "Market Order" | "Limit Order".

### I.2 — Limit order placement

**File**: `packages/frontend/src/pages/trade/OrderForm.tsx`

Add `LimitOrder` mode:
- Show limit price input when "Limit Order" tab is active.
- On submit: construct `LimitOrder` struct off-chain, sign with Freighter
  (`wallet.signMessage(canonicalBytes)`), call `ClobClient.placeOrder`.
- Show user's open limit orders in `PositionsTable` with a cancel button.

### I.3 — Portfolio margin display

**File**: `packages/frontend/src/pages/trade/AccountSummary.tsx`

Replace single `AccountHealth` display with `PortfolioHealth`:
- Show: Total Collateral | Portfolio Margin Required | Free Collateral | Net Delta USD.
- Add "Portfolio Margin Savings" line: `(sum_individual_margins - portfolio_margin) / sum_individual_margins * 100%`.

### I.4 — Funding velocity display

**File**: `packages/frontend/src/pages/TradePage.tsx`

Existing `Stat label="Funding"` → extend to show both current rate and velocity
direction with an arrow (↑ rate increasing, ↓ decreasing).

### I.5 — SVI vol surface chart in options page

**File**: `packages/frontend/src/pages/OptionsPage.tsx`

Add a volatility surface mini-chart (Recharts scatter plot):
- X axis: strike (as % of spot, e.g. 80% to 120%)
- Y axis: implied volatility %
- Data points: fetch from `OptionsClient.get_implied_vol` for 10 strike points

### I.6 — Staking page

**File**: `packages/frontend/src/pages/StakingPage.tsx` (create new)

UI panels:
- **STLX balance + stake/unstake form**
- **Current epoch reward pool**: total rewards, your share %, estimated payout
- **Claim history table**: past epochs, amounts claimed
- **Protocol stats**: total staked, APR estimate

Add route `/staking` in the app router (`packages/frontend/src/App.tsx`).

### I.7 — Remove testnet bypasses

**File**: `packages/frontend/src/pages/trade/OrderForm.tsx` line ~24.

Delete the line:
```typescript
const MAX_SLIPPAGE_BYPASS = 1_000_000_000;
```
Replace all usages with `DEFAULT_SLIPPAGE_BPS` (50 bps). This is now safe
because oracle-price execution (Phase A) eliminated the vAMM divergence.

---

## Phase J — Integration Testing

### J.1 — Update cross-contract integration test harness

**File**: `tests/src/lib.rs`

1. Add `clob: ContractId` and `staking: ContractId` to `Protocol` struct.
2. Update `Protocol::setup()`:
   - Register new `skew_scale`, `maker_rebate_bps` in `register_market`.
   - Deploy and wire `stellax-clob` and `stellax-staking`.
3. Add helper `Protocol::place_limit_order(user, market, size, price, is_long) -> u64`.
4. Add helper `Protocol::advance_epoch()` for staking epoch tests.

### J.2 — New integration test scenarios

**File**: `tests/tests/` — add new test files:

**`test_oracle_price_execution.rs`**:
- Open long, verify execution price ≈ oracle price (within 0.1%).
- Open second long, verify skew fee increases execution price.
- Open short (maker), verify execution price is better than oracle.

**`test_clob_lifecycle.rs`**:
- Place buy limit order.
- Place sell limit order at overlapping price.
- Call `settle_matched_orders`, verify both orders filled.
- Verify positions created in perp engine.
- Verify vault margin locked.

**`test_portfolio_margin.rs`**:
- Deposit collateral.
- Open 50x long BTC perp.
- Open BTC put option (same notional).
- Verify `get_portfolio_health` shows lower margin than sum of individual requirements.
- Verify neither position is individually liquidatable but combined they are healthy.

**`test_velocity_funding.rs`**:
- Open large long to create positive funding pressure.
- Call `update_funding` 10 times (advancing time).
- Verify funding rate increases gradually each call (not instantaneous jump).

**`test_svi_vol_surface.rs`**:
- Push SVI params for 3 expiry buckets.
- Write options at different strikes (ATM, 10% OTM call, 10% OTM put).
- Verify OTM options priced higher (smile effect).

**`test_staking_rewards.rs`**:
- Generate fees by opening/closing positions.
- Call `treasury.distribute()`.
- Verify staking contract received correct USDC amount.
- Stake STLX, wait epoch, claim rewards, verify payout proportional to stake.

### J.3 — Update existing tests

All existing tests under `tests/tests/` and unit tests in contract files that:
- Construct `VammState` → remove, replace with `SkewState`.
- Call `register_market` with old signature → update params.
- Call `get_mark_price` expecting vAMM price → update expectations to oracle price.
- Use `VolatilitySurface { sigma }` → update to `SviParams`.

Run `cargo test --workspace` to confirm all pass before moving to deployment.

---

## Phase K — Testnet Deployment + Upgrade

### K.1 — Build all V2 WASMs

```bash
# From workspace root
cargo build --target wasm32v1-none --release --workspace

# Optimize all WASMs
for crate in stellax-perp-engine stellax-funding stellax-risk \
             stellax-options stellax-bridge stellax-treasury \
             stellax-clob stellax-staking; do
  stellar contract optimize \
    --wasm target/wasm32v1-none/release/${crate//-/_}.wasm \
    --wasm-out target/wasm32v1-none/release/${crate//-/_}.optimized.wasm
done
```

### K.2 — Upgrade existing contracts

For each modified contract, use `stellar contract upgrade` (preserves contract
ID and all storage):

```bash
# 1. Upload new WASM (get hash back)
stellar contract upload \
  --wasm target/wasm32v1-none/release/stellax_perp_engine.optimized.wasm \
  --source-account stellax-deployer \
  --network testnet

# 2. Upgrade via governor proposal OR admin direct call (testnet: direct)
stellar contract invoke \
  --id <PERP_ENGINE_CONTRACT_ID> \
  --source-account stellax-deployer \
  --network testnet \
  -- upgrade \
  --new_wasm_hash <HASH_FROM_UPLOAD>
```

Repeat for: `perp-engine`, `funding`, `risk`, `options`, `structured`,
`treasury`, `bridge`.

### K.3 — Deploy new contracts

```bash
# Deploy stellax-clob
stellar contract deploy \
  --wasm target/wasm32v1-none/release/stellax_clob.optimized.wasm \
  --source-account stellax-deployer \
  --network testnet \
  --alias stellax-clob \
  -- \
  --admin <DEPLOYER_PUB_KEY> \
  --perp_engine <PERP_ENGINE_ID> \
  --vault <VAULT_ID> \
  --keeper <KEEPER_PUB_KEY>

# Deploy stellax-staking
stellar contract deploy \
  --wasm target/wasm32v1-none/release/stellax_staking.optimized.wasm \
  --source-account stellax-deployer \
  --network testnet \
  --alias stellax-staking \
  -- \
  --admin <DEPLOYER_PUB_KEY> \
  --stlx_token <STLX_SAC_ADDRESS> \
  --treasury <TREASURY_ID> \
  --epoch_duration_secs 604800
```

### K.4 — Post-upgrade wiring

After all contracts are upgraded/deployed:

```bash
# 1. Add clob to perp engine config
stellar contract invoke --id <PERP_ENGINE_ID> --source-account stellax-deployer --network testnet \
  -- set_clob --clob <CLOB_CONTRACT_ID>

# 2. Wire funding (no param change needed; velocity model uses same oracle/perp refs)
# Just call update_funding to initialize new FundingState fields:
stellar contract invoke --id <FUNDING_ID> --source-account stellax-deployer --network testnet \
  -- update_funding --market_id 0

# 3. Wire staking to treasury
stellar contract invoke --id <TREASURY_ID> --source-account stellax-deployer --network testnet \
  -- set_staking --staking <STAKING_CONTRACT_ID>

# 4. Wire options engine to risk engine
stellar contract invoke --id <RISK_ID> --source-account stellax-deployer --network testnet \
  -- set_options_engine --options <OPTIONS_CONTRACT_ID>

# 5. Migrate V1 flat vol to SVI (flat SVI = same ATM vol, no smile)
stellar contract invoke --id <OPTIONS_ID> --source-account stellax-deployer --network testnet \
  -- migrate_v1_vol_to_svi --market_id 0
```

### K.5 — Update deployments/testnet.json

After deployment, update `deployments/testnet.json`:
- Add `"clob": "<CLOB_CONTRACT_ID>"` and `"staking": "<STAKING_CONTRACT_ID>"` to `contracts`.
- Update all upgraded WASM hashes under `wasm_hashes`.

### K.6 — Testnet smoke tests

```bash
# Run full E2E test
./scripts/test-bridge-e2e.sh --keeper-only

# Run new V2-specific smoke test (create this script)
./scripts/test-v2-smoke.sh
```

**`scripts/test-v2-smoke.sh`** — create this file with:
1. Deposit USDC to vault.
2. Open a perp position (verify oracle-price execution, skew updated).
3. Place a limit order via CLOB.
4. Open an option (verify SVI vol surface used).
5. Check portfolio health (verify portfolio margin < sum of individual).
6. Simulate funding update (verify velocity model).
7. Run keeper CLOB matcher once.
8. Stake STLX, distribute treasury, claim rewards.

---

## Phase L — Mainnet Deployment

### L.1 — Pre-mainnet checklist

Before any mainnet action:
- [ ] All J.2 integration tests pass on testnet.
- [ ] `cargo clippy -- -D warnings` clean.
- [ ] `cargo audit` shows no critical CVEs.
- [ ] Phase K testnet smoke test passes 3 consecutive runs.
- [ ] Professional security audit (at minimum for Phase A + Phase B changes —
      the skew fee formula and off-chain order signature verification).
- [ ] `CONTRACT_VERSION` incremented to `2` in: perp-engine, funding, risk,
      options, clob (new), staking (new).
- [ ] `deployments/mainnet.json` created (template from `testnet.json`).
- [ ] STLX token Classic asset created and SAC deployed on mainnet.
- [ ] Keeper secrets rotated; new mainnet keeper wallet funded with ≥ 500 XLM.

### L.2 — Mainnet deployment order

Same as testnet (Phase K.2–K.4) but targeting `--network mainnet` with:
- Conservative initial params: `skew_scale = 1e15` (lower skew fee), `max_leverage = 10x` initially.
- Insurance fund pre-seeded with $5,000 USDC.
- STLX initial supply minted to deployer, 10% immediately staked by team.

### L.3 — Progressive parameter relaxation (post-launch)

| Milestone | Action |
|---|---|
| 1 week stable | Increase `max_leverage` to 20x; enable limit orders on perp markets |
| 2 weeks stable | Open CLOB to public (remove keeper restriction, allow partial matching) |
| 1 month, audit complete | Increase max leverage to 50x; extend to 5 markets |
| 2 months | Enable portfolio margin for all users; reduce maintenance margin for hedged portfolios |
| 3 months | Enable SVI-priced options (before: flat IV only) |
| 4 months | Launch staking with token distribution; first staker epoch payout |

---

## Appendix

### New contract storage keys summary

#### stellax-clob
| Key | Type | Description |
|---|---|---|
| `Config` | Instance | `ClobConfig` |
| `Order(u64)` | Temporary (TTL = order.expiry) | `LimitOrder` |
| `TraderNonce(Address)` | Persistent | `u64` last nonce |
| `NextOrderId` | Instance | `u64` counter |

#### stellax-staking
| Key | Type | Description |
|---|---|---|
| `Config` | Instance | `StakingConfig` |
| `StakeEntry(Address)` | Persistent | `StakeEntry` |
| `EpochPool(u32)` | Persistent | `EpochRewardPool` |
| `CurrentEpoch` | Instance | `u32` |
| `TotalStaked` | Instance | `i128` |

#### stellax-perp-engine (changed keys in V2)
| Key changed | Old | New |
|---|---|---|
| `Vamm(u32)` | `VammState` | **Removed** |
| `SkewState(u32)` | *new* | `SkewState` |
| `PendingOrder(u64)` | *new* | `PendingOrder` (Temporary) |

#### stellax-funding (changed in V2)
| Key | Change |
|---|---|
| `FundingState(u32)` | Extended with `funding_velocity: i128` and `current_rate: i128` |

#### stellax-options (changed in V2)
| Key changed | Old | New |
|---|---|---|
| `ImpliedVol(u32)` | `VolatilitySurface` | Legacy; kept for migration |
| `SviSurface(u32, u64)` | *new* | `SviParams` per market+expiry |

### Critical math formulas

**Skew fee execution price** (Phase A):
```
mid_skew = current_skew + delta_skew / 2
skew_fee_rate = |mid_skew| / skew_scale           (18-dec)
execution_price = oracle_price * (1 ± skew_fee_rate)  (+ for long, - for short)
```

**Velocity funding** (Phase D):
```
premium = (oracle_price - mark_price) / oracle_price
velocity_delta = premium * funding_factor            (per second)
new_velocity = clamp(old_velocity + velocity_delta * elapsed, -MAX_V, +MAX_V)
new_rate     = clamp(old_rate + new_velocity * elapsed, -MAX_R, +MAX_R)
accrued      = new_rate * elapsed / SECS_PER_HOUR    (funding settled on position)
```

**SVI vol surface** (Phase E):
```
k = ln(K / F)   where F = oracle_price (forward)
w = a + b * (rho * (k - m) + sqrt((k - m)^2 + sigma_svi^2))
implied_vol = sqrt(w)   (annualized vol, 18-dec)
```

**Portfolio margin** (Phase C):
```
net_delta[market] = sum(perp_size * sign) + sum(option_delta * option_size)
net_delta_usd     = sum(|net_delta[m]| * price[m])
portfolio_margin  = net_delta_usd * initial_margin_ratio
(vs gross_margin  = sum(notional[i] * initial_margin_ratio[i]))
```

### Dependency graph (V2 additions)

```
stellax-math  ← stellax-clob (new, for LimitOrder, OrderStatus)
stellax-math  ← stellax-staking (new, for StakeEntry)
stellax-clob  ← stellax-perp-engine (execute_clob_fill)
stellax-clob  ← stellax-vault (lock_margin)
stellax-options ← stellax-risk (get_option_delta, get_user_options)
stellax-staking ← stellax-treasury (deposit_epoch_rewards)
stellax-governor → all contracts (upgrade + new action types)
```

### EVM chain identifiers (Axelar naming)

| Chain | Axelar chain name |
|---|---|
| Avalanche Fuji (testnet) | `Avalanche` |
| Avalanche C-Chain (mainnet) | `Avalanche` |
| Arbitrum One | `arbitrum` |
| Base Mainnet | `base` |
| Optimism Mainnet | `optimism` |
| Ethereum Mainnet | `Ethereum` |

These strings must match exactly in `StellaXBridgeEVM.sol` `destinationChain` param
and in the Stellar bridge's `trusted_sources` map.

### Useful commands reference

```bash
# Build single contract
cargo build --target wasm32v1-none --release -p stellax-perp-engine

# Run all tests
cargo test --workspace

# Run specific test
cargo test test_skew_fee_increases --workspace -- --nocapture

# Optimize WASM
stellar contract optimize --wasm target/wasm32v1-none/release/stellax_clob.wasm

# Simulate a call (dry-run without fee)
stellar contract invoke --id <ID> --network testnet --simulate-only -- <FUNCTION> <ARGS>

# Check contract version
stellar contract invoke --id <ID> --network testnet -- version

# Keeper dev run
cd packages/keeper && pnpm dev

# Frontend dev run
cd packages/frontend && pnpm dev

# Full build (TypeScript)
pnpm --filter "./packages/**" build
```

---

*Total estimated implementation time: 12–16 weeks for 2–3 engineers.*  
*Critical path: Phase A (1w) → Phase B (2w) → Phase C (1w) → Phase J+K (2w) → Phase L (1w).*  
*Phases D, E, F, G, H, I can proceed in parallel with B and C.*
