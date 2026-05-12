//! StellaX perpetual futures engine — V2.
//!
//! V2 replaces the constant-product virtual AMM with oracle-price execution
//! plus a skew fee that penalises the side that increases OI imbalance.
//! This is the GMX v2 / Synthetix Perps v3 model.

#![no_std]
#![allow(deprecated)]
#![allow(clippy::too_many_arguments)]

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, Address,
    Bytes, BytesN, Env, Symbol, Vec,
};
use stellax_math::{
    apply_bps, div_precision_checked, mul_div_checked, mul_precision_checked, Market, Position,
    PriceData, SkewState, BPS_DENOMINATOR, MAX_LEVERAGE, PRECISION,
    TTL_BUMP_PERSISTENT, TTL_THRESHOLD_PERSISTENT,
};

const CONTRACT_VERSION: u32 = 2;

/// Phase 4 — maximum number of concurrent open positions per user.
/// Prevents a griefing attack where a single account creates thousands of
/// positions, making keeper iteration unbounded.
const MAX_POSITIONS_PER_USER: u32 = 50;

/// Phase 4 — maximum age (in seconds) of an oracle price before it is
/// considered stale.  Prices older than this are rejected at open/close time.
const MAX_PRICE_AGE_SECS: u64 = 120;

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum PerpError {
    AlreadyInitialized = 1,
    Unauthorized = 2,
    InvalidConfig = 3,
    MarketExists = 4,
    MarketNotFound = 5,
    MarketInactive = 6,
    InvalidLeverage = 7,
    InvalidSize = 8,
    SlippageExceeded = 9,
    OpenInterestExceeded = 10,
    PositionNotFound = 11,
    NotPositionOwner = 12,
    InsufficientMargin = 13,
    InvalidAction = 14,
    MathOverflow = 15,
    OrderNotFound = 16,
    OrderExpired = 17,
    OrderConditionNotMet = 18,
    // Phase R — advanced order types.
    BracketNotFound = 19,
    TwapNotFound = 20,
    IcebergNotFound = 21,
    InvalidTrailingStop = 22,
    InvalidPlan = 23,
    PlanComplete = 24,
    /// Phase SLP — profit waterfall exhausted: treasury, SLP, and insurance
    /// all lack sufficient balance to pay a trader's profit.
    InsufficientLiquidity = 25,
    /// Phase 4 — contract is paused by admin; all trading entry-points reject.
    Paused = 26,
    /// Phase 4 — user has reached the maximum number of concurrent open positions.
    TooManyPositions = 27,
    /// Phase 4 — oracle price timestamp is older than MAX_PRICE_AGE_SECS.
    OraclePriceTooOld = 28,
    /// Phase 4 — oracle returned a non-positive price (data error / circuit-break).
    InvalidOraclePrice = 29,
    /// HLP — SLP vault address has not been configured via set_slp_vault.
    SlpVaultNotConfigured = 30,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PerpConfig {
    pub admin: Address,
    pub oracle: Address,
    pub vault: Address,
    pub funding: Address,
    pub risk: Address,
    pub treasury: Address,
    pub settlement_token: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketParams {
    pub min_position_size: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpenInterest {
    pub oi_long: i128,
    pub oi_short: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketInfo {
    pub market: Market,
    pub params: MarketParams,
    pub oi_long: i128,
    pub oi_short: i128,
    pub mark_price: i128,
    pub funding_rate: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ModifyAction {
    AddMargin(i128),
    RemoveMargin(i128),
    PartialClose(i128),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PositionEntry {
    pub position_id: u64,
    pub position: Position,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RiskCloseResult {
    pub user: Address,
    pub market_id: u32,
    pub closed_size: i128,
    pub released_margin: i128,
    pub trade_pnl: i128,
    pub funding_pnl: i128,
    pub remaining_size: i128,
    pub remaining_margin: i128,
    pub position_closed: bool,
}

/// Phase B — order type for two-phase pending orders (request-execute pattern).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OrderType {
    /// Execute at the current oracle price (subject to slippage guard).
    Market,
    /// Execute only when oracle_price <= limit_price (long) or >= limit_price (short).
    Limit(i128),
    /// Execute only when oracle_price <= stop_price (long) or >= stop_price (short).
    StopLoss(i128),
    /// Execute only when oracle_price >= tp_price (long) or <= tp_price (short).
    TakeProfit(i128),
    /// Phase R — trailing stop. `(offset, anchor)`:
    ///   * `offset` — trigger distance in oracle scale (1e8). Constant.
    ///   * `anchor` — moving high-water (long) / low-water (short) mark.
    /// The keeper updates `anchor` via `update_trailing_anchor` as the price
    /// moves favourably; trigger price = `anchor - offset` (long) or
    /// `anchor + offset` (short).
    Trailing(i128, i128),
}

/// Phase B — a two-phase pending order stored by a user, executed by the keeper.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingOrder {
    pub order_id: u64,
    pub user: Address,
    pub market_id: u32,
    pub size: i128,
    pub is_long: bool,
    pub leverage: u32,
    pub max_slippage: u32,
    pub order_type: OrderType,
    /// Ledger sequence number at creation.
    pub created_ledger: u32,
    /// Auto-expire if keeper does not execute within this many ledgers (~30 = 150s).
    pub expiry_ledger: u32,
}

// ─── Phase R — advanced order containers ─────────────────────────────────────

/// Phase R — bracket group linking an entry order to a take-profit and a
/// stop-loss order. When any one of `tp_id` / `sl_id` triggers, the keeper
/// must cancel the sibling. The on-chain group is informational only — the
/// matching of "one fills, the other is cancelled" is enforced by the
/// keeper using `cancel_bracket_sibling`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BracketGroup {
    pub parent_id: u64,
    pub tp_id: u64,
    pub sl_id: u64,
    pub user: Address,
    pub active: bool,
}

/// Phase R — TWAP plan: split a parent order into `slices` equal-sized
/// child orders released at a fixed `interval_ledgers` cadence. The keeper
/// calls `release_twap_slice` to mint the next pending order.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TwapPlan {
    pub plan_id: u64,
    pub user: Address,
    pub market_id: u32,
    pub total_size: i128,
    pub is_long: bool,
    pub leverage: u32,
    pub max_slippage: u32,
    pub slices: u32,
    pub slices_released: u32,
    pub interval_ledgers: u32,
    pub start_ledger: u32,
    pub expiry_ledger: u32,
    pub active: bool,
}

/// Phase R — iceberg plan: only `display_size` of `total_size` is visible at
/// a time. After a slice fills, the keeper calls `release_iceberg_slice` to
/// mint the next visible chunk. The `entry_price` mirrors a Limit order.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IcebergPlan {
    pub plan_id: u64,
    pub user: Address,
    pub market_id: u32,
    pub total_size: i128,
    pub display_size: i128,
    pub size_filled: i128,
    pub is_long: bool,
    pub leverage: u32,
    pub max_slippage: u32,
    pub entry_price: i128,
    pub expiry_ledger: u32,
    pub active: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum DataKey {
    Config,
    NextPositionId,
    Market(u32),
    MarketParams(u32),
    SkewState(u32),
    OpenInterest(u32),
    Position(u64),
    UserPositions(Address),
    MarketPositions(u32),
    Version,
    /// Phase B: two-phase pending orders (stored in Temporary storage).
    PendingOrder(u64),
    /// Phase B: monotonic counter for pending order IDs.
    NextOrderId,
    /// Phase B: address of the CLOB settlement contract (stored separately
    /// to avoid migrating the PerpConfig struct after V2 upgrade).
    ClobAddress,
    // Phase R — advanced order types.
    /// Bracket group: `BracketGroup` keyed by parent order id.
    Bracket(u64),
    /// TWAP plan: `TwapPlan` keyed by plan id.
    TwapPlan(u64),
    /// Iceberg plan: `IcebergPlan` keyed by plan id.
    IcebergPlan(u64),
    /// Monotonic counter for plan ids (TWAP + Iceberg share).
    NextPlanId,
    /// Phase SLP — address of the SLP vault contract. Stored separately so
    /// `PerpConfig` serialisation is unaffected by the upgrade.  Set
    /// post-upgrade via `set_slp_vault`. Read by `settle_position_close` to
    /// route the profit waterfall (Phase 1).
    SlpVault,
    /// Phase SLP — address of the funding-pool sub-account in the vault.
    /// Payments to/from continuous funding go through this account.
    FundingPool,
    /// Phase 4 — boolean flag; present and `true` when the protocol is paused.
    /// Absent or `false` means live.  Stored in Instance storage for fast reads.
    Paused,
}

#[contractclient(name = "OracleClient")]
pub trait OracleInterface {
    fn get_price(env: Env, asset: Symbol) -> PriceData;
    fn verify_price_payload(env: Env, payload: Bytes, feed_id: Symbol) -> PriceData;
    fn submit_pyth_update(env: Env, update_data: Bytes, assets: Vec<Symbol>) -> u32;
}

#[contractclient(name = "VaultClient")]
pub trait VaultInterface {
    fn lock_margin(env: Env, caller: Address, user: Address, position_id: u64, amount: i128);
    fn unlock_margin(env: Env, caller: Address, user: Address, position_id: u64, amount: i128);
    fn move_balance(
        env: Env,
        caller: Address,
        from: Address,
        to: Address,
        token_address: Address,
        amount: i128,
    );
    fn get_balance(env: Env, user: Address, token_address: Address) -> i128;
}

#[contractclient(name = "FundingClient")]
pub trait FundingInterface {
    fn update_funding(env: Env, market_id: u32);
    fn get_accumulated_funding(env: Env, market_id: u32) -> (i128, i128);
    fn get_current_funding_rate(env: Env, market_id: u32) -> i128;
}

#[contractclient(name = "RiskClient")]
pub trait RiskInterface {
    fn validate_new_pos_with_inputs(
        env: Env,
        user: Address,
        notional: i128,
        margin: i128,
        leverage: u32,
        max_leverage: u32,
        existing_initial_margin: i128,
        existing_unrealized_pnl: i128,
        total_collateral: i128,
    );
    /// Phase SLP — pay `amount` of settlement token from the insurance fund
    /// to `recipient` (typically the perp-engine acting as vault caller).
    /// Returns the insurance balance after the payout.  Reverts if balance is
    /// insufficient.
    fn insurance_payout(env: Env, recipient: Address, amount: i128) -> i128;
}

/// HLP — SLP vault entry points called by the perp engine to keep NAV in sync.
#[contractclient(name = "SlpVaultClient")]
pub trait SlpVaultInterface {
    /// Increment TotalAssets by `amount` (18dp internal). No token movement —
    /// the caller has already done vault.move_balance(... → slp_vault).
    fn credit_pnl(env: Env, caller: Address, amount: i128) -> Result<(), soroban_sdk::Error>;
    /// Decrement TotalAssets by `amount` and move USDC from the SLP sub-account
    /// to `recipient` via vault.move_balance inside the SLP vault.
    /// Reverts with InsufficientLiquidity if TotalAssets < amount.
    fn draw_pnl(
        env: Env,
        caller: Address,
        recipient: Address,
        amount: i128,
    ) -> Result<(), soroban_sdk::Error>;
    /// Decrement TotalAssets by `amount` with no token movement (bad-debt
    /// absorption during liquidation).
    fn record_loss(env: Env, caller: Address, amount: i128) -> Result<(), soroban_sdk::Error>;
}

#[contract]
pub struct StellaxPerpEngine;

#[contractimpl]
impl StellaxPerpEngine {
    pub fn __constructor(
        env: Env,
        admin: Address,
        oracle: Address,
        vault: Address,
        funding: Address,
        risk: Address,
        treasury: Address,
        settlement_token: Address,
    ) -> Result<(), PerpError> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(PerpError::AlreadyInitialized);
        }

        let cfg = PerpConfig {
            admin,
            oracle,
            vault,
            funding,
            risk,
            treasury,
            settlement_token,
        };
        env.storage().instance().set(&DataKey::Config, &cfg);
        env.storage()
            .instance()
            .set(&DataKey::NextPositionId, &1u64);
        env.storage()
            .instance()
            .set(&DataKey::Version, &CONTRACT_VERSION);
        bump_instance_ttl(&env);
        Ok(())
    }

    pub fn version(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Version)
            .unwrap_or(CONTRACT_VERSION)
    }

    /// Register a new perpetual market.
    ///
    /// V2: accepts `skew_scale` and `maker_rebate_bps` instead of AMM reserve
    /// parameters. `skew_scale` is the OI imbalance (in 18-decimal base units)
    /// at which the skew fee equals 100% of oracle price — set it large relative
    /// to expected market depth (e.g. 1_000_000 * PRECISION for a deep market).
    pub fn register_market(
        env: Env,
        market: Market,
        min_position_size: i128,
        skew_scale: i128,
        maker_rebate_bps: u32,
    ) -> Result<(), PerpError> {
        bump_instance_ttl(&env);
        let cfg = read_config(&env)?;
        cfg.admin.require_auth();

        if env
            .storage()
            .instance()
            .has(&DataKey::Market(market.market_id))
        {
            return Err(PerpError::MarketExists);
        }

        validate_market(&market, min_position_size, skew_scale)?;

        env.storage()
            .instance()
            .set(&DataKey::Market(market.market_id), &market);
        env.storage().instance().set(
            &DataKey::MarketParams(market.market_id),
            &MarketParams { min_position_size },
        );

        write_skew_state(
            &env,
            market.market_id,
            &SkewState {
                skew: 0,
                skew_scale,
                maker_rebate_bps,
            },
        );
        write_open_interest(
            &env,
            market.market_id,
            &OpenInterest {
                oi_long: 0,
                oi_short: 0,
            },
        );

        env.events().publish(
            (symbol_short!("regmkt"), market.market_id),
            market.base_asset,
        );
        Ok(())
    }

    /// Returns the current oracle price for the market (V2: no vAMM divergence).
    pub fn get_mark_price(env: Env, market_id: u32) -> Result<i128, PerpError> {
        bump_instance_ttl(&env);
        let market = read_active_market(&env, market_id)?;
        let oracle_price = read_price(&env, &market.base_asset, None)?;
        Ok(oracle_price.price)
    }

    /// Returns the current skew state for a market (for frontend / keeper).
    pub fn get_skew_state(env: Env, market_id: u32) -> Result<SkewState, PerpError> {
        bump_instance_ttl(&env);
        read_skew_state(&env, market_id)
    }

    pub fn get_market(env: Env, market_id: u32) -> Result<Market, PerpError> {
        bump_instance_ttl(&env);
        read_market(&env, market_id)
    }

    /// Admin migration for markets registered before V2 storage was introduced.
    ///
    /// Existing V1 markets can have readable `Market` records while missing or
    /// incompatible V2 runtime records. This initializes the V2 records without
    /// re-registering the market.
    pub fn migrate_market_v2_state(
        env: Env,
        market_id: u32,
        min_position_size: i128,
        skew_scale: i128,
        maker_rebate_bps: u32,
        oi_long: i128,
        oi_short: i128,
    ) -> Result<(), PerpError> {
        bump_instance_ttl(&env);
        let cfg = read_config(&env)?;
        cfg.admin.require_auth();

        let market = read_market(&env, market_id)?;
        validate_market(&market, min_position_size, skew_scale)?;
        if maker_rebate_bps > BPS_DENOMINATOR || oi_long < 0 || oi_short < 0 {
            return Err(PerpError::InvalidConfig);
        }

        env.storage().instance().set(
            &DataKey::MarketParams(market_id),
            &MarketParams { min_position_size },
        );
        write_skew_state(
            &env,
            market_id,
            &SkewState {
                skew: oi_long
                    .checked_sub(oi_short)
                    .ok_or(PerpError::MathOverflow)?,
                skew_scale,
                maker_rebate_bps,
            },
        );
        write_open_interest(&env, market_id, &OpenInterest { oi_long, oi_short });
        Ok(())
    }

    pub fn open_position(
        env: Env,
        user: Address,
        market_id: u32,
        size: i128,
        is_long: bool,
        leverage: u32,
        max_slippage_bps: u32,
        price_payload: Option<Bytes>,
    ) -> Result<u64, PerpError> {
        bump_instance_ttl(&env);
        require_not_paused(&env)?;
        user.require_auth();

        if size <= 0 {
            return Err(PerpError::InvalidSize);
        }

        let market = read_active_market(&env, market_id)?;
        if leverage == 0 || leverage > market.max_leverage || leverage > MAX_LEVERAGE {
            return Err(PerpError::InvalidLeverage);
        }

        let params = read_market_params(&env, market_id)?;
        let oracle_price = read_price(&env, &market.base_asset, price_payload)?;
        let oracle_notional = notional_value(size, oracle_price.price)?;
        if oracle_notional < params.min_position_size {
            return Err(PerpError::InvalidSize);
        }

        // V2: oracle-price execution adjusted by skew fee.
        let skew = read_skew_state(&env, market_id)?;
        let execution_price = get_execution_price(oracle_price.price, &skew, size, is_long)?;
        ensure_slippage(execution_price, oracle_price.price, max_slippage_bps)?;

        let mut oi = read_open_interest(&env, market_id)?;
        if is_long {
            let next = oi
                .oi_long
                .checked_add(size)
                .ok_or(PerpError::MathOverflow)?;
            if next > market.max_oi_long {
                return Err(PerpError::OpenInterestExceeded);
            }
            oi.oi_long = next;
        } else {
            let next = oi
                .oi_short
                .checked_add(size)
                .ok_or(PerpError::MathOverflow)?;
            if next > market.max_oi_short {
                return Err(PerpError::OpenInterestExceeded);
            }
            oi.oi_short = next;
        }

        let notional = notional_value(size, execution_price)?;
        let margin = notional
            .checked_div(leverage as i128)
            .ok_or(PerpError::MathOverflow)?;
        if margin <= 0 {
            return Err(PerpError::InsufficientMargin);
        }
        let fee = apply_bps(notional, market.taker_fee_bps);
        let position_id = next_position_id(&env)?;

        let cfg = read_config(&env)?;
        let caller = env.current_contract_address();
        let vault = VaultClient::new(&env, &cfg.vault);
        vault.lock_margin(&caller, &user, &position_id, &margin);
        if fee > 0 {
            // HLP — open fee goes to SLP vault (uplift NAV).
            let slp_vault_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::SlpVault)
                .ok_or(PerpError::SlpVaultNotConfigured)?;
            vault.move_balance(&caller, &user, &slp_vault_addr, &cfg.settlement_token, &fee);
            let slp = SlpVaultClient::new(&env, &slp_vault_addr);
            slp.credit_pnl(&caller, &fee);
        }

        // Aggregate existing-position state locally to avoid re-entrant risk
        // engine calls.
        let (existing_initial_margin, existing_unrealized_pnl) =
            aggregate_existing_positions(&env, &user)?;
        let total_collateral = vault.get_balance(&user, &cfg.settlement_token);

        let risk = RiskClient::new(&env, &cfg.risk);
        risk.validate_new_pos_with_inputs(
            &user,
            &notional,
            &margin,
            &leverage,
            &market.max_leverage,
            &existing_initial_margin,
            &existing_unrealized_pnl,
            &total_collateral,
        );

        let funding_idx = current_funding_index(&env, market_id, is_long)?;
        let position = Position {
            owner: user.clone(),
            market_id,
            size,
            entry_price: execution_price,
            margin,
            leverage,
            is_long,
            last_funding_idx: funding_idx,
            open_timestamp: env.ledger().timestamp(),
        };

        // Update skew: long increases skew, short decreases skew.
        let new_skew_val = if is_long {
            skew.skew.checked_add(size).ok_or(PerpError::MathOverflow)?
        } else {
            skew.skew.checked_sub(size).ok_or(PerpError::MathOverflow)?
        };
        write_skew_state(
            &env,
            market_id,
            &SkewState {
                skew: new_skew_val,
                ..skew
            },
        );

        write_open_interest(&env, market_id, &oi);
        write_position(&env, position_id, &position);
        add_user_position(&env, &user, position_id)?;
        add_market_position(&env, market_id, position_id);
        write_next_position_id(
            &env,
            position_id.checked_add(1).ok_or(PerpError::MathOverflow)?,
        )?;

        env.events().publish(
            (symbol_short!("posopen"), user, position_id, market_id),
            (size, execution_price, leverage, is_long),
        );
        Ok(position_id)
    }

    pub fn close_position(
        env: Env,
        user: Address,
        position_id: u64,
        price_payload: Option<Bytes>,
    ) -> Result<(), PerpError> {
        bump_instance_ttl(&env);
        require_not_paused(&env)?;
        user.require_auth();

        let position = read_position(&env, position_id)?;
        if position.owner != user {
            return Err(PerpError::NotPositionOwner);
        }

        let market = read_active_market(&env, position.market_id)?;
        let oracle_price = read_price(&env, &market.base_asset, price_payload)?;

        // V2: close executes in the opposite direction at oracle ± skew fee.
        let skew = read_skew_state(&env, position.market_id)?;
        let close_direction_is_long = !position.is_long;
        let execution_price = get_execution_price(
            oracle_price.price,
            &skew,
            position.size,
            close_direction_is_long,
        )?;

        let funding_idx = current_funding_index(&env, position.market_id, position.is_long)?;
        let funding_component = funding_pnl(&position, funding_idx)?;
        let trade_component = trade_pnl(
            position.is_long,
            position.size,
            position.entry_price,
            execution_price,
        )?;
        let close_notional = notional_value(position.size, execution_price)?;
        let close_fee = apply_bps(close_notional, market.maker_fee_bps);
        // gross_pnl = trade + funding, before fee deduction.
        // total_pnl = net result (kept for the event log).
        let gross_pnl = trade_component
            .checked_add(funding_component)
            .ok_or(PerpError::MathOverflow)?;
        let total_pnl = gross_pnl
            .checked_sub(close_fee)
            .ok_or(PerpError::MathOverflow)?;

        settle_position_close(&env, &user, position_id, position.margin, gross_pnl, close_fee)?;

        // Reverse skew: closing a long removes size from long skew.
        let new_skew_val = if position.is_long {
            skew.skew
                .checked_sub(position.size)
                .ok_or(PerpError::MathOverflow)?
        } else {
            skew.skew
                .checked_add(position.size)
                .ok_or(PerpError::MathOverflow)?
        };
        write_skew_state(
            &env,
            position.market_id,
            &SkewState {
                skew: new_skew_val,
                ..skew
            },
        );

        let mut oi = read_open_interest(&env, position.market_id)?;
        if position.is_long {
            oi.oi_long = oi
                .oi_long
                .checked_sub(position.size)
                .ok_or(PerpError::MathOverflow)?;
        } else {
            oi.oi_short = oi
                .oi_short
                .checked_sub(position.size)
                .ok_or(PerpError::MathOverflow)?;
        }
        write_open_interest(&env, position.market_id, &oi);

        remove_position(&env, position_id);
        remove_user_position(&env, &user, position_id);

        env.events().publish(
            (symbol_short!("posclose"), user, position_id),
            (execution_price, total_pnl),
        );
        Ok(())
    }

    /// Tier 3 — Pull-on-trade wrapper around `open_position`.
    ///
    /// First refreshes Pyth-backed feeds for `pyth_assets` by submitting
    /// `pyth_update_data` (a Wormhole VAA) to the oracle, then opens the
    /// position normally. Any error from `submit_pyth_update` aborts the
    /// transaction so the trade never executes against stale prices.
    ///
    /// Callers that don't need a Pyth refresh should keep using
    /// `open_position` directly to avoid the extra cross-contract call.
    pub fn open_position_with_update(
        env: Env,
        user: Address,
        market_id: u32,
        size: i128,
        is_long: bool,
        leverage: u32,
        max_slippage_bps: u32,
        price_payload: Option<Bytes>,
        pyth_update_data: Bytes,
        pyth_assets: Vec<Symbol>,
    ) -> Result<u64, PerpError> {
        bump_instance_ttl(&env);
        let cfg = read_config(&env)?;
        let oracle = OracleClient::new(&env, &cfg.oracle);
        oracle.submit_pyth_update(&pyth_update_data, &pyth_assets);
        Self::open_position(
            env,
            user,
            market_id,
            size,
            is_long,
            leverage,
            max_slippage_bps,
            price_payload,
        )
    }

    /// Tier 3 — Pull-on-trade wrapper around `close_position`. See
    /// `open_position_with_update` for semantics.
    pub fn close_position_with_update(
        env: Env,
        user: Address,
        position_id: u64,
        price_payload: Option<Bytes>,
        pyth_update_data: Bytes,
        pyth_assets: Vec<Symbol>,
    ) -> Result<(), PerpError> {
        bump_instance_ttl(&env);
        let cfg = read_config(&env)?;
        let oracle = OracleClient::new(&env, &cfg.oracle);
        oracle.submit_pyth_update(&pyth_update_data, &pyth_assets);
        Self::close_position(env, user, position_id, price_payload)
    }

    pub fn modify_position(
        env: Env,
        user: Address,
        position_id: u64,
        action: ModifyAction,
    ) -> Result<(), PerpError> {
        bump_instance_ttl(&env);
        require_not_paused(&env)?;
        user.require_auth();

        let mut position = read_position(&env, position_id)?;
        if position.owner != user {
            return Err(PerpError::NotPositionOwner);
        }

        let market = read_active_market(&env, position.market_id)?;
        let cfg = read_config(&env)?;
        let caller = env.current_contract_address();
        let vault = VaultClient::new(&env, &cfg.vault);

        match action {
            ModifyAction::AddMargin(amount) => {
                if amount <= 0 {
                    return Err(PerpError::InvalidAction);
                }
                vault.lock_margin(&caller, &user, &position_id, &amount);
                position.margin = position
                    .margin
                    .checked_add(amount)
                    .ok_or(PerpError::MathOverflow)?;
            }
            ModifyAction::RemoveMargin(amount) => {
                if amount <= 0 || amount >= position.margin {
                    return Err(PerpError::InvalidAction);
                }
                let oracle_price = read_price(&env, &market.base_asset, None)?;
                let new_margin = position
                    .margin
                    .checked_sub(amount)
                    .ok_or(PerpError::MathOverflow)?;
                let new_leverage =
                    effective_leverage(position.size, oracle_price.price, new_margin)?;
                if new_leverage > market.max_leverage {
                    return Err(PerpError::InvalidLeverage);
                }
                vault.unlock_margin(&caller, &user, &position_id, &amount);
                position.margin = new_margin;
                position.leverage = new_leverage;
            }
            ModifyAction::PartialClose(close_size) => {
                if close_size <= 0 || close_size >= position.size {
                    return Err(PerpError::InvalidAction);
                }
                let oracle_price = read_price(&env, &market.base_asset, None)?;
                let skew = read_skew_state(&env, position.market_id)?;
                let close_direction_is_long = !position.is_long;
                let execution_price = get_execution_price(
                    oracle_price.price,
                    &skew,
                    close_size,
                    close_direction_is_long,
                )?;
                let funding_idx =
                    current_funding_index(&env, position.market_id, position.is_long)?;
                let funding_component = funding_pnl_for_size(&position, funding_idx, close_size)?;
                let trading_component = trade_pnl(
                    position.is_long,
                    close_size,
                    position.entry_price,
                    execution_price,
                )?;
                let close_notional = notional_value(close_size, execution_price)?;
                let close_fee = apply_bps(close_notional, market.maker_fee_bps);
                // gross_pnl = trade + funding, before fee deduction.
                let gross_pnl = trading_component
                    .checked_add(funding_component)
                    .ok_or(PerpError::MathOverflow)?;
                // Use 256-bit intermediate to avoid overflow when
                // margin * close_size would exceed i128::MAX.
                let released_margin = mul_div_checked(position.margin, close_size, position.size)
                    .ok_or(PerpError::MathOverflow)?;
                settle_position_close(&env, &user, position_id, released_margin, gross_pnl, close_fee)?;

                // Reverse partial skew.
                let new_skew_val = if position.is_long {
                    skew.skew
                        .checked_sub(close_size)
                        .ok_or(PerpError::MathOverflow)?
                } else {
                    skew.skew
                        .checked_add(close_size)
                        .ok_or(PerpError::MathOverflow)?
                };
                write_skew_state(
                    &env,
                    position.market_id,
                    &SkewState {
                        skew: new_skew_val,
                        ..skew
                    },
                );

                let mut oi = read_open_interest(&env, position.market_id)?;
                if position.is_long {
                    oi.oi_long = oi
                        .oi_long
                        .checked_sub(close_size)
                        .ok_or(PerpError::MathOverflow)?;
                } else {
                    oi.oi_short = oi
                        .oi_short
                        .checked_sub(close_size)
                        .ok_or(PerpError::MathOverflow)?;
                }
                write_open_interest(&env, position.market_id, &oi);

                position.size = position
                    .size
                    .checked_sub(close_size)
                    .ok_or(PerpError::MathOverflow)?;
                position.margin = position
                    .margin
                    .checked_sub(released_margin)
                    .ok_or(PerpError::MathOverflow)?;
                position.last_funding_idx = funding_idx;
                position.leverage =
                    effective_leverage(position.size, oracle_price.price, position.margin)?;
            }
        }

        write_position(&env, position_id, &position);
        env.events().publish(
            (symbol_short!("posmod"), user, position_id),
            position.margin,
        );
        Ok(())
    }

    pub fn get_position(env: Env, user: Address, position_id: u64) -> Result<Position, PerpError> {
        bump_instance_ttl(&env);
        let position = read_position(&env, position_id)?;
        if position.owner != user {
            return Err(PerpError::NotPositionOwner);
        }
        Ok(position)
    }

    pub fn get_position_by_id(env: Env, position_id: u64) -> Result<Position, PerpError> {
        bump_instance_ttl(&env);
        read_position(&env, position_id)
    }

    pub fn get_unrealized_pnl(env: Env, position_id: u64) -> Result<i128, PerpError> {
        bump_instance_ttl(&env);
        let position = read_position(&env, position_id)?;
        let market = read_market(&env, position.market_id)?;
        let oracle_price = read_price(&env, &market.base_asset, None)?;
        let funding_idx = current_funding_index(&env, position.market_id, position.is_long)?;
        let funding_component = funding_pnl(&position, funding_idx)?;
        let trading_component = trade_pnl(
            position.is_long,
            position.size,
            position.entry_price,
            oracle_price.price,
        )?;
        trading_component
            .checked_add(funding_component)
            .ok_or(PerpError::MathOverflow)
    }

    pub fn get_positions_by_user(env: Env, user: Address) -> Result<Vec<PositionEntry>, PerpError> {
        bump_instance_ttl(&env);
        let ids = read_user_positions(&env, &user);
        let mut out = Vec::new(&env);
        for position_id in ids.iter() {
            out.push_back(PositionEntry {
                position_id,
                position: read_position(&env, position_id)?,
            });
        }
        Ok(out)
    }

    pub fn get_position_ids_by_market(env: Env, market_id: u32) -> Result<Vec<u64>, PerpError> {
        bump_instance_ttl(&env);
        let _ = read_market(&env, market_id)?;
        Ok(read_market_positions(&env, market_id))
    }

    pub fn risk_close_position(
        env: Env,
        caller: Address,
        position_id: u64,
        close_size: i128,
        execution_price: i128,
    ) -> Result<RiskCloseResult, PerpError> {
        bump_instance_ttl(&env);
        caller.require_auth();

        let cfg = read_config(&env)?;
        if caller != cfg.risk {
            return Err(PerpError::Unauthorized);
        }
        if close_size <= 0 || execution_price <= 0 {
            return Err(PerpError::InvalidAction);
        }

        let mut position = read_position(&env, position_id)?;
        if close_size > position.size {
            return Err(PerpError::InvalidAction);
        }

        let funding_idx = current_funding_index(&env, position.market_id, position.is_long)?;
        let funding_component = funding_pnl_for_size(&position, funding_idx, close_size)?;
        let trade_component = trade_pnl(
            position.is_long,
            close_size,
            position.entry_price,
            execution_price,
        )?;
        // Use 256-bit intermediate to avoid overflow.
        let released_margin = mul_div_checked(position.margin, close_size, position.size)
            .ok_or(PerpError::MathOverflow)?;

        let mut oi = read_open_interest(&env, position.market_id)?;
        if position.is_long {
            oi.oi_long = oi
                .oi_long
                .checked_sub(close_size)
                .ok_or(PerpError::MathOverflow)?;
        } else {
            oi.oi_short = oi
                .oi_short
                .checked_sub(close_size)
                .ok_or(PerpError::MathOverflow)?;
        }
        write_open_interest(&env, position.market_id, &oi);

        // Update skew: forced close removes the position's skew contribution.
        let skew = read_skew_state(&env, position.market_id)?;
        let new_skew_val = if position.is_long {
            skew.skew
                .checked_sub(close_size)
                .ok_or(PerpError::MathOverflow)?
        } else {
            skew.skew
                .checked_add(close_size)
                .ok_or(PerpError::MathOverflow)?
        };
        write_skew_state(
            &env,
            position.market_id,
            &SkewState {
                skew: new_skew_val,
                ..skew
            },
        );

        let was_full_close = close_size == position.size;
        let user = position.owner.clone();
        let market_id = position.market_id;

        if was_full_close {
            remove_position(&env, position_id);
            remove_user_position(&env, &user, position_id);
            remove_market_position(&env, market_id, position_id);
            env.events().publish(
                (symbol_short!("riskclose"), user.clone(), position_id),
                (close_size, execution_price, true),
            );
            Ok(RiskCloseResult {
                user,
                market_id,
                closed_size: close_size,
                released_margin,
                trade_pnl: trade_component,
                funding_pnl: funding_component,
                remaining_size: 0,
                remaining_margin: 0,
                position_closed: true,
            })
        } else {
            position.size = position
                .size
                .checked_sub(close_size)
                .ok_or(PerpError::MathOverflow)?;
            position.margin = position
                .margin
                .checked_sub(released_margin)
                .ok_or(PerpError::MathOverflow)?;
            position.last_funding_idx = funding_idx;
            position.leverage =
                effective_leverage(position.size, execution_price, position.margin)?;
            write_position(&env, position_id, &position);
            env.events().publish(
                (symbol_short!("riskclose"), user.clone(), position_id),
                (close_size, execution_price, false),
            );
            Ok(RiskCloseResult {
                user,
                market_id,
                closed_size: close_size,
                released_margin,
                trade_pnl: trade_component,
                funding_pnl: funding_component,
                remaining_size: position.size,
                remaining_margin: position.margin,
                position_closed: false,
            })
        }
    }

    pub fn get_market_info(env: Env, market_id: u32) -> Result<MarketInfo, PerpError> {
        bump_instance_ttl(&env);
        let market = read_market(&env, market_id)?;
        let params = read_market_params(&env, market_id)?;
        let oi = read_open_interest(&env, market_id)?;
        // V2: mark price = oracle price.
        let oracle_price = read_price(&env, &market.base_asset, None)?;
        let cfg = read_config(&env)?;
        let funding = FundingClient::new(&env, &cfg.funding);

        Ok(MarketInfo {
            market,
            params,
            oi_long: oi.oi_long,
            oi_short: oi.oi_short,
            mark_price: oracle_price.price,
            funding_rate: funding.get_current_funding_rate(&market_id),
        })
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), PerpError> {
        bump_instance_ttl(&env);
        let cfg = read_config(&env)?;
        cfg.admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        env.storage()
            .instance()
            .set(&DataKey::Version, &(CONTRACT_VERSION + 1));
        Ok(())
    }

    /// Admin-gated replacement of the perp engine's sibling module addresses.
    pub fn update_dependencies(
        env: Env,
        oracle: Address,
        vault: Address,
        funding: Address,
        risk: Address,
        treasury: Address,
        settlement_token: Address,
    ) -> Result<(), PerpError> {
        bump_instance_ttl(&env);
        let mut cfg = read_config(&env)?;
        cfg.admin.require_auth();
        cfg.oracle = oracle;
        cfg.vault = vault;
        cfg.funding = funding;
        cfg.risk = risk;
        cfg.treasury = treasury;
        cfg.settlement_token = settlement_token;
        env.storage().instance().set(&DataKey::Config, &cfg);
        Ok(())
    }

    /// Phase B — set or update the CLOB contract address (admin only).
    pub fn set_clob(env: Env, clob: Address) -> Result<(), PerpError> {
        bump_instance_ttl(&env);
        let cfg = read_config(&env)?;
        cfg.admin.require_auth();
        env.storage().instance().set(&DataKey::ClobAddress, &clob);
        Ok(())
    }

    /// Phase B — read the registered CLOB address (or None if not yet set).
    pub fn get_clob(env: Env) -> Option<Address> {
        bump_instance_ttl(&env);
        env.storage().instance().get(&DataKey::ClobAddress)
    }

    // ─── Phase SLP: SLP vault + funding-pool wiring ───────────────────────────

    /// Phase SLP — admin-gated registration of the SLP vault contract address.
    ///
    /// Stored under a dedicated `DataKey::SlpVault` so `PerpConfig`
    /// serialisation is unaffected.  Must be called after the SLP vault is
    /// deployed and before Phase 1 waterfall logic is activated.
    pub fn set_slp_vault(env: Env, slp_vault: Address) -> Result<(), PerpError> {
        bump_instance_ttl(&env);
        let cfg = read_config(&env)?;
        cfg.admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::SlpVault, &slp_vault);
        env.events().publish(
            (symbol_short!("setslpvt"), env.current_contract_address()),
            slp_vault,
        );
        Ok(())
    }

    /// Phase SLP — return the registered SLP vault address, or `None` if
    /// not yet configured.
    pub fn get_slp_vault(env: Env) -> Option<Address> {
        bump_instance_ttl(&env);
        env.storage().instance().get(&DataKey::SlpVault)
    }

    /// HLP — admin-gated update of per-market OI caps.
    ///
    /// Raises (or lowers) `max_oi_long` and `max_oi_short` on an existing
    /// market without requiring a full market re-deployment.  Used by the
    /// migration script to lift the $100 testnet caps to $1 M.
    pub fn set_market_oi_caps(
        env: Env,
        market_id: u32,
        max_oi_long: i128,
        max_oi_short: i128,
    ) -> Result<(), PerpError> {
        bump_instance_ttl(&env);
        let cfg = read_config(&env)?;
        cfg.admin.require_auth();
        if max_oi_long <= 0 || max_oi_short <= 0 {
            return Err(PerpError::InvalidConfig);
        }
        let mut market = read_market(&env, market_id)?;
        market.max_oi_long = max_oi_long;
        market.max_oi_short = max_oi_short;
        env.storage()
            .instance()
            .set(&DataKey::Market(market_id), &market);
        env.events().publish(
            (symbol_short!("setoicap"), market_id),
            (max_oi_long, max_oi_short),
        );
        Ok(())
    }

    /// Phase SLP — admin-gated registration of the funding-pool sub-account
    /// address inside the vault.  Continuous funding payments are routed
    /// through this account (Phase 2).
    pub fn set_funding_pool(env: Env, funding_pool: Address) -> Result<(), PerpError> {
        bump_instance_ttl(&env);
        let cfg = read_config(&env)?;
        cfg.admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::FundingPool, &funding_pool);
        env.events().publish(
            (symbol_short!("setfndpl"), env.current_contract_address()),
            funding_pool,
        );
        Ok(())
    }

    /// Phase SLP — return the registered funding-pool address, or `None` if
    /// not yet configured.
    pub fn get_funding_pool(env: Env) -> Option<Address> {
        bump_instance_ttl(&env);
        env.storage().instance().get(&DataKey::FundingPool)
    }

    // ─── Phase 4: pause / unpause ────────────────────────────────────────────

    /// Phase 4 — admin-only: halt all trading entry-points immediately.
    /// Liquidations in the risk contract are guarded separately.
    pub fn pause(env: Env) -> Result<(), PerpError> {
        bump_instance_ttl(&env);
        let cfg = read_config(&env)?;
        cfg.admin.require_auth();
        env.storage().instance().set(&DataKey::Paused, &true);
        env.events().publish(
            (symbol_short!("paused"), env.current_contract_address()),
            true,
        );
        Ok(())
    }

    /// Phase 4 — admin-only: resume trading after a pause.
    pub fn unpause(env: Env) -> Result<(), PerpError> {
        bump_instance_ttl(&env);
        let cfg = read_config(&env)?;
        cfg.admin.require_auth();
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events().publish(
            (symbol_short!("paused"), env.current_contract_address()),
            false,
        );
        Ok(())
    }

    /// Phase 4 — returns `true` when the contract is currently paused.
    pub fn is_paused(env: Env) -> bool {
        bump_instance_ttl(&env);
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    // ─── Phase 3: continuous funding write-through ────────────────────────────

    /// Phase 3 — called exclusively by the funding contract after it has
    /// settled and transferred a funding payment for a position.
    ///
    /// Resets `last_funding_idx` to `new_idx` so the same funding interval is
    /// not double-counted when the position is closed or partially modified.
    ///
    /// Only the registered funding contract (`cfg.funding`) may call this;
    /// any other caller gets `PerpError::Unauthorized`.
    pub fn update_position_funding_idx(
        env: Env,
        caller: Address,
        position_id: u64,
        new_idx: i128,
    ) -> Result<(), PerpError> {
        bump_instance_ttl(&env);
        let cfg = read_config(&env)?;
        caller.require_auth();
        if caller != cfg.funding {
            return Err(PerpError::Unauthorized);
        }
        let mut position = read_position(&env, position_id)?;
        position.last_funding_idx = new_idx;
        write_position(&env, position_id, &position);
        env.events().publish(
            (symbol_short!("fundidx"), position_id),
            new_idx,
        );
        Ok(())
    }

    // ─── Phase B: CLOB settlement ─────────────────────────────────────────────

    /// Execute a matched CLOB fill. Only callable by the registered CLOB contract.
    ///
    /// Opens a long position for `buyer` and a short position for `seller` at
    /// `fill_price`, with `fill_size` each. CLOB-matched orders bypass the skew
    /// fee (net OI change is zero: one long + one short cancel out).
    ///
    /// Returns `(buy_position_id, sell_position_id)`.
    pub fn execute_clob_fill(
        env: Env,
        caller: Address,
        buyer: Address,
        seller: Address,
        market_id: u32,
        fill_size: i128,
        fill_price: i128,
        buy_leverage: u32,
        sell_leverage: u32,
    ) -> Result<(u64, u64), PerpError> {
        bump_instance_ttl(&env);
        require_not_paused(&env)?;
        caller.require_auth();

        // Only the registered CLOB contract may call this.
        let clob = env
            .storage()
            .instance()
            .get::<_, Address>(&DataKey::ClobAddress)
            .ok_or(PerpError::Unauthorized)?;
        if caller != clob {
            return Err(PerpError::Unauthorized);
        }

        if fill_size <= 0 || fill_price <= 0 {
            return Err(PerpError::InvalidSize);
        }

        let market = read_active_market(&env, market_id)?;
        let cfg = read_config(&env)?;

        // Validate leverages.
        if buy_leverage == 0 || buy_leverage > market.max_leverage || buy_leverage > MAX_LEVERAGE {
            return Err(PerpError::InvalidLeverage);
        }
        if sell_leverage == 0 || sell_leverage > market.max_leverage || sell_leverage > MAX_LEVERAGE
        {
            return Err(PerpError::InvalidLeverage);
        }

        let vault_client = VaultClient::new(&env, &cfg.vault);
        let caller_addr = env.current_contract_address();
        let funding_client = FundingClient::new(&env, &cfg.funding);

        let (long_idx, short_idx) = funding_client.get_accumulated_funding(&market_id);

        // ── Open buyer (long) position ──────────────────────────────────────
        let buy_notional = notional_value(fill_size, fill_price)?;
        let buy_margin = buy_notional
            .checked_div(buy_leverage as i128)
            .ok_or(PerpError::MathOverflow)?;
        if buy_margin <= 0 {
            return Err(PerpError::InsufficientMargin);
        }
        let buy_fee = apply_bps(buy_notional, market.maker_fee_bps);
        let buy_pos_id = next_position_id(&env)?;
        // Increment immediately so the seller gets a distinct position ID.
        write_next_position_id(
            &env,
            buy_pos_id.checked_add(1).ok_or(PerpError::MathOverflow)?,
        )?;

        vault_client.lock_margin(&caller_addr, &buyer, &buy_pos_id, &buy_margin);
        if buy_fee > 0 {
            // HLP — open fee goes to SLP vault (uplift NAV).
            let slp_vault_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::SlpVault)
                .ok_or(PerpError::SlpVaultNotConfigured)?;
            vault_client.move_balance(
                &caller_addr,
                &buyer,
                &slp_vault_addr,
                &cfg.settlement_token,
                &buy_fee,
            );
            let slp = SlpVaultClient::new(&env, &slp_vault_addr);
            slp.credit_pnl(&caller_addr, &buy_fee);
        }

        let buy_position = Position {
            owner: buyer.clone(),
            market_id,
            size: fill_size,
            entry_price: fill_price,
            margin: buy_margin,
            leverage: buy_leverage,
            is_long: true,
            last_funding_idx: long_idx,
            open_timestamp: env.ledger().timestamp(),
        };

        // ── Open seller (short) position ────────────────────────────────────
        let sell_notional = notional_value(fill_size, fill_price)?;
        let sell_margin = sell_notional
            .checked_div(sell_leverage as i128)
            .ok_or(PerpError::MathOverflow)?;
        if sell_margin <= 0 {
            return Err(PerpError::InsufficientMargin);
        }
        let sell_fee = apply_bps(sell_notional, market.maker_fee_bps);
        let sell_pos_id = next_position_id(&env)?;

        vault_client.lock_margin(&caller_addr, &seller, &sell_pos_id, &sell_margin);
        if sell_fee > 0 {
            // HLP — open fee goes to SLP vault (uplift NAV).
            let slp_vault_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::SlpVault)
                .ok_or(PerpError::SlpVaultNotConfigured)?;
            vault_client.move_balance(
                &caller_addr,
                &seller,
                &slp_vault_addr,
                &cfg.settlement_token,
                &sell_fee,
            );
            let slp = SlpVaultClient::new(&env, &slp_vault_addr);
            slp.credit_pnl(&caller_addr, &sell_fee);
        }

        let sell_position = Position {
            owner: seller.clone(),
            market_id,
            size: fill_size,
            entry_price: fill_price,
            margin: sell_margin,
            leverage: sell_leverage,
            is_long: false,
            last_funding_idx: short_idx,
            open_timestamp: env.ledger().timestamp(),
        };

        // ── Update OI (long + short cancel out, net skew change = 0) ────────
        let mut oi = read_open_interest(&env, market_id)?;
        oi.oi_long = oi
            .oi_long
            .checked_add(fill_size)
            .ok_or(PerpError::MathOverflow)?;
        oi.oi_short = oi
            .oi_short
            .checked_add(fill_size)
            .ok_or(PerpError::MathOverflow)?;
        // Guard OI caps.
        if oi.oi_long > market.max_oi_long || oi.oi_short > market.max_oi_short {
            return Err(PerpError::OpenInterestExceeded);
        }
        write_open_interest(&env, market_id, &oi);

        // ── Persist positions ────────────────────────────────────────────────
        write_position(&env, buy_pos_id, &buy_position);
        add_user_position(&env, &buyer, buy_pos_id)?;
        add_market_position(&env, market_id, buy_pos_id);

        write_position(&env, sell_pos_id, &sell_position);
        add_user_position(&env, &seller, sell_pos_id)?;
        add_market_position(&env, market_id, sell_pos_id);

        write_next_position_id(
            &env,
            sell_pos_id.checked_add(1).ok_or(PerpError::MathOverflow)?,
        )?;

        env.events().publish(
            (symbol_short!("clobfill"), buyer.clone(), seller.clone()),
            (market_id, fill_size, fill_price),
        );

        Ok((buy_pos_id, sell_pos_id))
    }

    // ─── Phase B: two-phase pending orders ───────────────────────────────────

    /// Create a pending order. The user places it; the keeper executes it once
    /// trigger conditions are met.
    ///
    /// Returns the `order_id` (monotonically increasing, stored in Temporary storage).
    pub fn create_order(
        env: Env,
        user: Address,
        market_id: u32,
        size: i128,
        is_long: bool,
        leverage: u32,
        max_slippage: u32,
        order_type: OrderType,
        expiry_ledger_offset: u32,
    ) -> Result<u64, PerpError> {
        bump_instance_ttl(&env);
        user.require_auth();

        if size <= 0 {
            return Err(PerpError::InvalidSize);
        }
        let market = read_active_market(&env, market_id)?;
        if leverage == 0 || leverage > market.max_leverage || leverage > MAX_LEVERAGE {
            return Err(PerpError::InvalidLeverage);
        }

        let created = env.ledger().sequence();
        let expiry = created
            .checked_add(expiry_ledger_offset.max(1))
            .ok_or(PerpError::MathOverflow)?;

        let order_id = next_pending_order_id(&env)?;
        let pending = PendingOrder {
            order_id,
            user: user.clone(),
            market_id,
            size,
            is_long,
            leverage,
            max_slippage,
            order_type,
            created_ledger: created,
            expiry_ledger: expiry,
        };

        env.storage()
            .temporary()
            .set(&DataKey::PendingOrder(order_id), &pending);
        // TTL = expiry_ledger_offset ledgers.
        let ttl = expiry_ledger_offset.max(1);
        env.storage()
            .temporary()
            .extend_ttl(&DataKey::PendingOrder(order_id), ttl, ttl);

        env.events().publish(
            (symbol_short!("crorder"), user, order_id),
            (market_id, size, is_long),
        );
        Ok(order_id)
    }

    /// Keeper executes a pending order once trigger conditions are met.
    ///
    /// Checks:
    ///   - Order exists and has not expired.
    ///   - Oracle price satisfies the `OrderType` condition.
    ///   - Then calls `open_position` logic inline.
    pub fn execute_order(
        env: Env,
        caller: Address,
        order_id: u64,
        price_payload: Option<Bytes>,
    ) -> Result<u64, PerpError> {
        bump_instance_ttl(&env);
        require_not_paused(&env)?;
        caller.require_auth();

        let pending: PendingOrder = env
            .storage()
            .temporary()
            .get(&DataKey::PendingOrder(order_id))
            .ok_or(PerpError::OrderNotFound)?;

        // Check not expired.
        if env.ledger().sequence() > pending.expiry_ledger {
            env.storage()
                .temporary()
                .remove(&DataKey::PendingOrder(order_id));
            return Err(PerpError::OrderExpired);
        }

        // Read current oracle price.
        let market = read_active_market(&env, pending.market_id)?;
        let oracle_price = read_price(&env, &market.base_asset, price_payload)?;

        // Check order type condition.
        match &pending.order_type {
            OrderType::Market => {} // always execute
            OrderType::Limit(limit_price) => {
                // Long limit: execute when price has fallen to or below limit.
                // Short limit: execute when price has risen to or above limit.
                let condition_met = if pending.is_long {
                    oracle_price.price <= *limit_price
                } else {
                    oracle_price.price >= *limit_price
                };
                if !condition_met {
                    return Err(PerpError::OrderConditionNotMet);
                }
            }
            OrderType::StopLoss(stop_price) => {
                // Long stop-loss: fires when price drops to stop_price.
                // Short stop-loss: fires when price rises to stop_price.
                let condition_met = if pending.is_long {
                    oracle_price.price <= *stop_price
                } else {
                    oracle_price.price >= *stop_price
                };
                if !condition_met {
                    return Err(PerpError::OrderConditionNotMet);
                }
            }
            OrderType::TakeProfit(tp_price) => {
                // Long TP: fires when price rises to tp_price.
                // Short TP: fires when price falls to tp_price.
                let condition_met = if pending.is_long {
                    oracle_price.price >= *tp_price
                } else {
                    oracle_price.price <= *tp_price
                };
                if !condition_met {
                    return Err(PerpError::OrderConditionNotMet);
                }
            }
            OrderType::Trailing(offset, anchor) => {
                // Phase R — trigger price = anchor ∓ offset.
                // Long: fires when price <= anchor - offset.
                // Short: fires when price >= anchor + offset.
                if *offset <= 0 {
                    return Err(PerpError::InvalidTrailingStop);
                }
                let trigger = if pending.is_long {
                    anchor.saturating_sub(*offset)
                } else {
                    anchor.saturating_add(*offset)
                };
                let condition_met = if pending.is_long {
                    oracle_price.price <= trigger
                } else {
                    oracle_price.price >= trigger
                };
                if !condition_met {
                    return Err(PerpError::OrderConditionNotMet);
                }
            }
        }

        // Remove the pending order before opening the position.
        env.storage()
            .temporary()
            .remove(&DataKey::PendingOrder(order_id));

        // Execute the open position for the order's user using the current
        // oracle price and the slippage tolerance from the pending order.
        // Re-use the shared open-position helpers directly.
        let skew = read_skew_state(&env, pending.market_id)?;
        let execution_price =
            get_execution_price(oracle_price.price, &skew, pending.size, pending.is_long)?;
        ensure_slippage(execution_price, oracle_price.price, pending.max_slippage)?;

        let mut oi = read_open_interest(&env, pending.market_id)?;
        if pending.is_long {
            let next = oi
                .oi_long
                .checked_add(pending.size)
                .ok_or(PerpError::MathOverflow)?;
            if next > market.max_oi_long {
                return Err(PerpError::OpenInterestExceeded);
            }
            oi.oi_long = next;
        } else {
            let next = oi
                .oi_short
                .checked_add(pending.size)
                .ok_or(PerpError::MathOverflow)?;
            if next > market.max_oi_short {
                return Err(PerpError::OpenInterestExceeded);
            }
            oi.oi_short = next;
        }

        let notional = notional_value(pending.size, execution_price)?;
        let params = read_market_params(&env, pending.market_id)?;
        if notional < params.min_position_size {
            return Err(PerpError::InvalidSize);
        }
        let margin = notional
            .checked_div(pending.leverage as i128)
            .ok_or(PerpError::MathOverflow)?;
        if margin <= 0 {
            return Err(PerpError::InsufficientMargin);
        }
        let fee = apply_bps(notional, market.taker_fee_bps);
        let position_id = next_position_id(&env)?;

        let cfg = read_config(&env)?;
        let self_addr = env.current_contract_address();
        let vault = VaultClient::new(&env, &cfg.vault);
        vault.lock_margin(&self_addr, &pending.user, &position_id, &margin);
        if fee > 0 {
            // HLP — open fee goes to SLP vault (uplift NAV).
            let slp_vault_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::SlpVault)
                .ok_or(PerpError::SlpVaultNotConfigured)?;
            vault.move_balance(
                &self_addr,
                &pending.user,
                &slp_vault_addr,
                &cfg.settlement_token,
                &fee,
            );
            let slp = SlpVaultClient::new(&env, &slp_vault_addr);
            slp.credit_pnl(&self_addr, &fee);
        }

        let funding_idx = current_funding_index(&env, pending.market_id, pending.is_long)?;
        let position = Position {
            owner: pending.user.clone(),
            market_id: pending.market_id,
            size: pending.size,
            entry_price: execution_price,
            margin,
            leverage: pending.leverage,
            is_long: pending.is_long,
            last_funding_idx: funding_idx,
            open_timestamp: env.ledger().timestamp(),
        };

        let new_skew_val = if pending.is_long {
            skew.skew
                .checked_add(pending.size)
                .ok_or(PerpError::MathOverflow)?
        } else {
            skew.skew
                .checked_sub(pending.size)
                .ok_or(PerpError::MathOverflow)?
        };
        write_skew_state(
            &env,
            pending.market_id,
            &SkewState {
                skew: new_skew_val,
                ..skew
            },
        );

        write_open_interest(&env, pending.market_id, &oi);
        write_position(&env, position_id, &position);
        add_user_position(&env, &pending.user, position_id)?;
        add_market_position(&env, pending.market_id, position_id);
        write_next_position_id(
            &env,
            position_id.checked_add(1).ok_or(PerpError::MathOverflow)?,
        )?;

        env.events().publish(
            (
                symbol_short!("exorder"),
                pending.user.clone(),
                order_id,
                position_id,
            ),
            (execution_price, pending.size, pending.is_long),
        );
        Ok(position_id)
    }

    /// User cancels their own pending order.
    pub fn cancel_pending_order(env: Env, user: Address, order_id: u64) -> Result<(), PerpError> {
        bump_instance_ttl(&env);
        user.require_auth();

        let pending: PendingOrder = env
            .storage()
            .temporary()
            .get(&DataKey::PendingOrder(order_id))
            .ok_or(PerpError::OrderNotFound)?;

        if pending.user != user {
            return Err(PerpError::NotPositionOwner);
        }

        env.storage()
            .temporary()
            .remove(&DataKey::PendingOrder(order_id));

        env.events().publish(
            (symbol_short!("canorder"), user, order_id),
            pending.market_id,
        );
        Ok(())
    }

    /// Read a pending order by ID.
    pub fn get_pending_order(env: Env, order_id: u64) -> Result<PendingOrder, PerpError> {
        bump_instance_ttl(&env);
        env.storage()
            .temporary()
            .get(&DataKey::PendingOrder(order_id))
            .ok_or(PerpError::OrderNotFound)
    }

    // ─── Phase R — advanced order types ──────────────────────────────────────

    /// Phase R — keeper-only: update the trailing-stop anchor on a pending
    /// `OrderType::Trailing` order as the oracle price moves favourably.
    ///
    /// For a long, `new_anchor` must be strictly greater than the existing
    /// anchor (price moved up); for a short, strictly less. The trigger
    /// price is `anchor ± offset` and is recomputed on `execute_order`.
    pub fn update_trailing_anchor(
        env: Env,
        caller: Address,
        order_id: u64,
        new_anchor: i128,
    ) -> Result<(), PerpError> {
        bump_instance_ttl(&env);
        caller.require_auth();
        let cfg = read_config(&env)?;
        if caller != cfg.admin {
            // The protocol's keeper signs as the perp admin in V2 deployment.
            // Tighter access control can be migrated later.
            return Err(PerpError::Unauthorized);
        }

        let mut order: PendingOrder = env
            .storage()
            .temporary()
            .get(&DataKey::PendingOrder(order_id))
            .ok_or(PerpError::OrderNotFound)?;

        let (offset, anchor) = match order.order_type.clone() {
            OrderType::Trailing(o, a) => (o, a),
            _ => return Err(PerpError::InvalidTrailingStop),
        };
        if offset <= 0 {
            return Err(PerpError::InvalidTrailingStop);
        }
        // Long: anchor only ratchets up. Short: anchor only ratchets down.
        if order.is_long {
            if new_anchor <= anchor {
                return Err(PerpError::InvalidTrailingStop);
            }
        } else if new_anchor >= anchor {
            return Err(PerpError::InvalidTrailingStop);
        }

        order.order_type = OrderType::Trailing(offset, new_anchor);
        env.storage()
            .temporary()
            .set(&DataKey::PendingOrder(order_id), &order);

        env.events().publish(
            (symbol_short!("trailupd"), order_id),
            (order.user, new_anchor),
        );
        Ok(())
    }

    /// Phase R — link an existing pending entry order with a take-profit
    /// and a stop-loss order into a bracket. All three orders must already
    /// exist (created via `create_order`) and belong to `user`.
    ///
    /// The link is informational: when one of `tp_id` / `sl_id` fires, the
    /// off-chain keeper observes the `bracketed` event and calls
    /// `cancel_bracket_sibling` for the survivor.
    pub fn bracket_link(
        env: Env,
        user: Address,
        parent_id: u64,
        tp_id: u64,
        sl_id: u64,
    ) -> Result<(), PerpError> {
        bump_instance_ttl(&env);
        user.require_auth();
        for id in [parent_id, tp_id, sl_id] {
            let o: PendingOrder = env
                .storage()
                .temporary()
                .get(&DataKey::PendingOrder(id))
                .ok_or(PerpError::OrderNotFound)?;
            if o.user != user {
                return Err(PerpError::NotPositionOwner);
            }
        }

        let group = BracketGroup {
            parent_id,
            tp_id,
            sl_id,
            user: user.clone(),
            active: true,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Bracket(parent_id), &group);
        env.storage().persistent().extend_ttl(
            &DataKey::Bracket(parent_id),
            crate::TTL_THRESHOLD_PERSISTENT,
            crate::TTL_BUMP_PERSISTENT,
        );

        env.events()
            .publish((symbol_short!("bracket"), parent_id), (tp_id, sl_id));
        Ok(())
    }

    /// Phase R — keeper cancels the surviving sibling once one bracket leg
    /// has fired. Removes the pending order and marks the bracket inactive.
    pub fn cancel_bracket_sibling(
        env: Env,
        caller: Address,
        parent_id: u64,
        survivor_id: u64,
    ) -> Result<(), PerpError> {
        bump_instance_ttl(&env);
        caller.require_auth();
        let cfg = read_config(&env)?;
        if caller != cfg.admin {
            return Err(PerpError::Unauthorized);
        }

        let mut group: BracketGroup = env
            .storage()
            .persistent()
            .get(&DataKey::Bracket(parent_id))
            .ok_or(PerpError::BracketNotFound)?;
        if !group.active {
            return Err(PerpError::PlanComplete);
        }
        if survivor_id != group.tp_id && survivor_id != group.sl_id {
            return Err(PerpError::InvalidPlan);
        }

        // Best-effort remove (the order may have already expired).
        env.storage()
            .temporary()
            .remove(&DataKey::PendingOrder(survivor_id));

        group.active = false;
        env.storage()
            .persistent()
            .set(&DataKey::Bracket(parent_id), &group);
        env.events()
            .publish((symbol_short!("brkcancel"), parent_id), survivor_id);
        Ok(())
    }

    /// Phase R — open a TWAP plan. Returns the plan id. The keeper calls
    /// `release_twap_slice` every `interval_ledgers` to mint a child
    /// `OrderType::Market` pending order of size `total_size / slices`.
    pub fn create_twap_plan(
        env: Env,
        user: Address,
        market_id: u32,
        total_size: i128,
        is_long: bool,
        leverage: u32,
        max_slippage: u32,
        slices: u32,
        interval_ledgers: u32,
        expiry_ledger_offset: u32,
    ) -> Result<u64, PerpError> {
        bump_instance_ttl(&env);
        user.require_auth();
        if total_size <= 0 || slices == 0 || interval_ledgers == 0 {
            return Err(PerpError::InvalidPlan);
        }
        // Each slice must be at least 1 base unit.
        if total_size < slices as i128 {
            return Err(PerpError::InvalidPlan);
        }
        let _ = read_active_market(&env, market_id)?;

        let plan_id = next_plan_id(&env);
        let now = env.ledger().sequence();
        let plan = TwapPlan {
            plan_id,
            user: user.clone(),
            market_id,
            total_size,
            is_long,
            leverage,
            max_slippage,
            slices,
            slices_released: 0,
            interval_ledgers,
            start_ledger: now,
            expiry_ledger: now.saturating_add(expiry_ledger_offset.max(1)),
            active: true,
        };
        env.storage()
            .persistent()
            .set(&DataKey::TwapPlan(plan_id), &plan);
        env.storage().persistent().extend_ttl(
            &DataKey::TwapPlan(plan_id),
            crate::TTL_THRESHOLD_PERSISTENT,
            crate::TTL_BUMP_PERSISTENT,
        );
        env.events().publish(
            (symbol_short!("twapnew"), user, plan_id),
            (slices, total_size),
        );
        Ok(plan_id)
    }

    /// Phase R — keeper releases the next TWAP slice. On success returns the
    /// new pending order id. Errors with `OrderConditionNotMet` if the
    /// cadence has not elapsed since the last release.
    pub fn release_twap_slice(env: Env, caller: Address, plan_id: u64) -> Result<u64, PerpError> {
        bump_instance_ttl(&env);
        caller.require_auth();
        let cfg = read_config(&env)?;
        if caller != cfg.admin {
            return Err(PerpError::Unauthorized);
        }

        let mut plan: TwapPlan = env
            .storage()
            .persistent()
            .get(&DataKey::TwapPlan(plan_id))
            .ok_or(PerpError::TwapNotFound)?;
        if !plan.active || plan.slices_released >= plan.slices {
            return Err(PerpError::PlanComplete);
        }
        let now = env.ledger().sequence();
        if now > plan.expiry_ledger {
            plan.active = false;
            env.storage()
                .persistent()
                .set(&DataKey::TwapPlan(plan_id), &plan);
            return Err(PerpError::OrderExpired);
        }
        let next_release = plan
            .start_ledger
            .saturating_add(plan.slices_released.saturating_mul(plan.interval_ledgers));
        if now < next_release {
            return Err(PerpError::OrderConditionNotMet);
        }

        // Mint a child Market order. The keeper subsequently calls
        // `execute_order` once it has a fresh oracle payload.
        let slice_size = plan.total_size / (plan.slices as i128);
        let order_id = next_pending_order_id(&env)?;
        let pending = PendingOrder {
            order_id,
            user: plan.user.clone(),
            market_id: plan.market_id,
            size: slice_size,
            is_long: plan.is_long,
            leverage: plan.leverage,
            max_slippage: plan.max_slippage,
            order_type: OrderType::Market,
            created_ledger: now,
            expiry_ledger: plan.expiry_ledger,
        };
        env.storage()
            .temporary()
            .set(&DataKey::PendingOrder(order_id), &pending);
        let ttl = plan.expiry_ledger.saturating_sub(now).max(1);
        env.storage()
            .temporary()
            .extend_ttl(&DataKey::PendingOrder(order_id), ttl, ttl);

        plan.slices_released = plan.slices_released.saturating_add(1);
        if plan.slices_released >= plan.slices {
            plan.active = false;
        }
        env.storage()
            .persistent()
            .set(&DataKey::TwapPlan(plan_id), &plan);

        env.events().publish(
            (symbol_short!("twapslic"), plan_id, order_id),
            (slice_size, plan.slices_released),
        );
        Ok(order_id)
    }

    /// Phase R — open an iceberg plan. Returns the plan id. The keeper calls
    /// `release_iceberg_slice` after each visible slice fills to mint the
    /// next `display_size` chunk as a Limit order at `entry_price`.
    pub fn create_iceberg_plan(
        env: Env,
        user: Address,
        market_id: u32,
        total_size: i128,
        display_size: i128,
        is_long: bool,
        leverage: u32,
        max_slippage: u32,
        entry_price: i128,
        expiry_ledger_offset: u32,
    ) -> Result<u64, PerpError> {
        bump_instance_ttl(&env);
        user.require_auth();
        if total_size <= 0 || display_size <= 0 || display_size > total_size || entry_price <= 0 {
            return Err(PerpError::InvalidPlan);
        }
        let _ = read_active_market(&env, market_id)?;

        let plan_id = next_plan_id(&env);
        let now = env.ledger().sequence();
        let plan = IcebergPlan {
            plan_id,
            user: user.clone(),
            market_id,
            total_size,
            display_size,
            size_filled: 0,
            is_long,
            leverage,
            max_slippage,
            entry_price,
            expiry_ledger: now.saturating_add(expiry_ledger_offset.max(1)),
            active: true,
        };
        env.storage()
            .persistent()
            .set(&DataKey::IcebergPlan(plan_id), &plan);
        env.storage().persistent().extend_ttl(
            &DataKey::IcebergPlan(plan_id),
            crate::TTL_THRESHOLD_PERSISTENT,
            crate::TTL_BUMP_PERSISTENT,
        );
        env.events().publish(
            (symbol_short!("icenew"), user, plan_id),
            (total_size, display_size),
        );
        Ok(plan_id)
    }

    /// Phase R — keeper releases the next iceberg visible slice after the
    /// previous one filled. `filled_amount` is the fill recorded since the
    /// last call (caller's responsibility to track via fills events). When
    /// `size_filled >= total_size` the plan is auto-deactivated.
    pub fn release_iceberg_slice(
        env: Env,
        caller: Address,
        plan_id: u64,
        filled_amount: i128,
    ) -> Result<u64, PerpError> {
        bump_instance_ttl(&env);
        caller.require_auth();
        let cfg = read_config(&env)?;
        if caller != cfg.admin {
            return Err(PerpError::Unauthorized);
        }
        if filled_amount < 0 {
            return Err(PerpError::InvalidPlan);
        }

        let mut plan: IcebergPlan = env
            .storage()
            .persistent()
            .get(&DataKey::IcebergPlan(plan_id))
            .ok_or(PerpError::IcebergNotFound)?;
        if !plan.active {
            return Err(PerpError::PlanComplete);
        }
        let now = env.ledger().sequence();
        if now > plan.expiry_ledger {
            plan.active = false;
            env.storage()
                .persistent()
                .set(&DataKey::IcebergPlan(plan_id), &plan);
            return Err(PerpError::OrderExpired);
        }

        plan.size_filled = plan
            .size_filled
            .saturating_add(filled_amount)
            .min(plan.total_size);
        let remaining = plan.total_size - plan.size_filled;
        if remaining <= 0 {
            plan.active = false;
            env.storage()
                .persistent()
                .set(&DataKey::IcebergPlan(plan_id), &plan);
            env.events()
                .publish((symbol_short!("icedone"), plan_id), plan.size_filled);
            // Return Ok(0) so the persistent state commit is preserved.
            // Subsequent calls will see `!plan.active` and return `PlanComplete`.
            return Ok(0);
        }

        let slice_size = plan.display_size.min(remaining);
        let order_id = next_pending_order_id(&env)?;
        let pending = PendingOrder {
            order_id,
            user: plan.user.clone(),
            market_id: plan.market_id,
            size: slice_size,
            is_long: plan.is_long,
            leverage: plan.leverage,
            max_slippage: plan.max_slippage,
            order_type: OrderType::Limit(plan.entry_price),
            created_ledger: now,
            expiry_ledger: plan.expiry_ledger,
        };
        env.storage()
            .temporary()
            .set(&DataKey::PendingOrder(order_id), &pending);
        let ttl = plan.expiry_ledger.saturating_sub(now).max(1);
        env.storage()
            .temporary()
            .extend_ttl(&DataKey::PendingOrder(order_id), ttl, ttl);

        env.storage()
            .persistent()
            .set(&DataKey::IcebergPlan(plan_id), &plan);
        env.events().publish(
            (symbol_short!("iceslic"), plan_id, order_id),
            (slice_size, plan.size_filled),
        );
        Ok(order_id)
    }

    // ─── Phase R views ───────────────────────────────────────────────────────

    pub fn get_bracket(env: Env, parent_id: u64) -> Option<BracketGroup> {
        env.storage().persistent().get(&DataKey::Bracket(parent_id))
    }

    pub fn get_twap_plan(env: Env, plan_id: u64) -> Option<TwapPlan> {
        env.storage().persistent().get(&DataKey::TwapPlan(plan_id))
    }

    pub fn get_iceberg_plan(env: Env, plan_id: u64) -> Option<IcebergPlan> {
        env.storage()
            .persistent()
            .get(&DataKey::IcebergPlan(plan_id))
    }
} // end impl StellaxPerpEngine

// ---------------------------------------------------------------------------
// V2 Price computation
// ---------------------------------------------------------------------------

/// Computes the trade execution price: oracle_price ± skew_fee.
///
/// skew_fee = oracle_price * |mid_skew| / skew_scale
///
/// where mid_skew = current_skew + delta_skew / 2  (average of before/after).
///
/// If the trade *reduces* skew (maker), the trader receives a rebate instead:
/// exec_price = oracle ± maker_rebate.
///
/// Longs pay above oracle when adding skew; shorts pay below oracle.
/// Makers (reducing skew) get price improvement.
fn get_execution_price(
    oracle_price: i128,
    skew: &SkewState,
    size: i128,
    is_long: bool,
) -> Result<i128, PerpError> {
    let delta_skew = if is_long { size } else { -size };
    // Mid-fill skew: average of the skew before and after this trade.
    let mid_skew = skew
        .skew
        .checked_add(delta_skew / 2)
        .ok_or(PerpError::MathOverflow)?;

    // Maker: trade reduces OI imbalance (opposite direction to current skew).
    let is_maker = (is_long && mid_skew < 0) || (!is_long && mid_skew > 0);

    if is_maker && skew.maker_rebate_bps > 0 {
        let rebate = apply_bps(oracle_price, skew.maker_rebate_bps);
        return Ok(if is_long {
            // Long maker buys at discount (skew was negative = short-heavy).
            oracle_price
                .checked_sub(rebate)
                .ok_or(PerpError::MathOverflow)?
        } else {
            // Short maker sells at premium (skew was positive = long-heavy).
            oracle_price
                .checked_add(rebate)
                .ok_or(PerpError::MathOverflow)?
        });
    }

    // Taker: pays skew fee proportional to |mid_skew| / skew_scale.
    let skew_fee_numerator = mid_skew.unsigned_abs() as i128;
    let skew_fee_rate = div_precision_checked(skew_fee_numerator, skew.skew_scale)
        .ok_or(PerpError::MathOverflow)?;
    let skew_fee =
        mul_precision_checked(skew_fee_rate, oracle_price).ok_or(PerpError::MathOverflow)?;

    Ok(if is_long {
        oracle_price
            .checked_add(skew_fee)
            .ok_or(PerpError::MathOverflow)?
    } else {
        oracle_price
            .checked_sub(skew_fee)
            .ok_or(PerpError::MathOverflow)?
    })
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

fn validate_market(
    market: &Market,
    min_position_size: i128,
    skew_scale: i128,
) -> Result<(), PerpError> {
    if market.max_leverage == 0
        || market.max_leverage > MAX_LEVERAGE
        || market.maker_fee_bps > BPS_DENOMINATOR
        || market.taker_fee_bps > BPS_DENOMINATOR
        || market.max_oi_long <= 0
        || market.max_oi_short <= 0
        || min_position_size <= 0
        || skew_scale <= 0
    {
        return Err(PerpError::InvalidConfig);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

fn bump_instance_ttl(_env: &Env) {
    // No-op: extending instance TTL inline pulls the contract <instance> entry
    // AND its <contractCode> blob into the RW footprint, which (across cross-
    // contract calls) inflates writeBytes past the per-tx network cap. TTL is
    // now extended out-of-band via packages/e2e/scripts/extend-ttl.sh on a
    // periodic schedule.
}

fn read_config(env: &Env) -> Result<PerpConfig, PerpError> {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(PerpError::InvalidConfig)
}

fn read_market(env: &Env, market_id: u32) -> Result<Market, PerpError> {
    env.storage()
        .instance()
        .get(&DataKey::Market(market_id))
        .ok_or(PerpError::MarketNotFound)
}

fn read_active_market(env: &Env, market_id: u32) -> Result<Market, PerpError> {
    let market = read_market(env, market_id)?;
    if !market.is_active {
        return Err(PerpError::MarketInactive);
    }
    Ok(market)
}

fn read_market_params(env: &Env, market_id: u32) -> Result<MarketParams, PerpError> {
    env.storage()
        .instance()
        .get(&DataKey::MarketParams(market_id))
        .ok_or(PerpError::MarketNotFound)
}

fn next_position_id(env: &Env) -> Result<u64, PerpError> {
    env.storage()
        .instance()
        .get(&DataKey::NextPositionId)
        .ok_or(PerpError::InvalidConfig)
}

fn write_next_position_id(env: &Env, next_id: u64) -> Result<(), PerpError> {
    env.storage()
        .instance()
        .set(&DataKey::NextPositionId, &next_id);
    Ok(())
}

fn write_skew_state(env: &Env, market_id: u32, skew: &SkewState) {
    let key = DataKey::SkewState(market_id);
    env.storage().persistent().set(&key, skew);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_PERSISTENT, TTL_BUMP_PERSISTENT);
}

fn read_skew_state(env: &Env, market_id: u32) -> Result<SkewState, PerpError> {
    let key = DataKey::SkewState(market_id);
    let value = env
        .storage()
        .persistent()
        .get::<_, SkewState>(&key)
        .ok_or(PerpError::MarketNotFound)?;
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_PERSISTENT, TTL_BUMP_PERSISTENT);
    Ok(value)
}

fn write_open_interest(env: &Env, market_id: u32, oi: &OpenInterest) {
    let key = DataKey::OpenInterest(market_id);
    env.storage().persistent().set(&key, oi);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_PERSISTENT, TTL_BUMP_PERSISTENT);
}

fn read_open_interest(env: &Env, market_id: u32) -> Result<OpenInterest, PerpError> {
    let key = DataKey::OpenInterest(market_id);
    let value = env
        .storage()
        .persistent()
        .get::<_, OpenInterest>(&key)
        .ok_or(PerpError::MarketNotFound)?;
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_PERSISTENT, TTL_BUMP_PERSISTENT);
    Ok(value)
}

fn write_position(env: &Env, position_id: u64, position: &Position) {
    let key = DataKey::Position(position_id);
    env.storage().persistent().set(&key, position);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_PERSISTENT, TTL_BUMP_PERSISTENT);
}

fn read_position(env: &Env, position_id: u64) -> Result<Position, PerpError> {
    let key = DataKey::Position(position_id);
    let value = env
        .storage()
        .persistent()
        .get::<_, Position>(&key)
        .ok_or(PerpError::PositionNotFound)?;
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_PERSISTENT, TTL_BUMP_PERSISTENT);
    Ok(value)
}

fn remove_position(env: &Env, position_id: u64) {
    env.storage()
        .persistent()
        .remove(&DataKey::Position(position_id));
}

fn read_user_positions(env: &Env, user: &Address) -> Vec<u64> {
    let key = DataKey::UserPositions(user.clone());
    let current = env.storage().persistent().get(&key);
    if current.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD_PERSISTENT, TTL_BUMP_PERSISTENT);
    }
    current.unwrap_or(Vec::new(env))
}

fn write_user_positions(env: &Env, user: &Address, ids: &Vec<u64>) {
    let key = DataKey::UserPositions(user.clone());
    env.storage().persistent().set(&key, ids);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_PERSISTENT, TTL_BUMP_PERSISTENT);
}

fn add_user_position(env: &Env, user: &Address, position_id: u64) -> Result<(), PerpError> {
    let mut ids = read_user_positions(env, user);
    if ids.len() >= MAX_POSITIONS_PER_USER {
        return Err(PerpError::TooManyPositions);
    }
    ids.push_back(position_id);
    write_user_positions(env, user, &ids);
    Ok(())
}

fn remove_user_position(env: &Env, user: &Address, position_id: u64) {
    let mut ids = read_user_positions(env, user);
    let len = ids.len();
    for idx in 0..len {
        if ids.get(idx).unwrap() == position_id {
            ids.remove(idx);
            break;
        }
    }
    write_user_positions(env, user, &ids);
}

fn read_market_positions(env: &Env, market_id: u32) -> Vec<u64> {
    let key = DataKey::MarketPositions(market_id);
    let current = env.storage().persistent().get(&key);
    if current.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD_PERSISTENT, TTL_BUMP_PERSISTENT);
    }
    current.unwrap_or(Vec::new(env))
}

fn write_market_positions(env: &Env, market_id: u32, ids: &Vec<u64>) {
    let key = DataKey::MarketPositions(market_id);
    env.storage().persistent().set(&key, ids);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_PERSISTENT, TTL_BUMP_PERSISTENT);
}

fn add_market_position(env: &Env, market_id: u32, position_id: u64) {
    let mut ids = read_market_positions(env, market_id);
    ids.push_back(position_id);
    write_market_positions(env, market_id, &ids);
}

fn remove_market_position(env: &Env, market_id: u32, position_id: u64) {
    let mut ids = read_market_positions(env, market_id);
    let len = ids.len();
    for idx in 0..len {
        if ids.get(idx).unwrap() == position_id {
            ids.remove(idx);
            break;
        }
    }
    write_market_positions(env, market_id, &ids);
}

/// Phase 4 — returns `Err(PerpError::Paused)` when the contract is paused.
/// Call at the top of every user-facing trading entry-point.
fn require_not_paused(env: &Env) -> Result<(), PerpError> {
    let paused: bool = env
        .storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false);
    if paused {
        Err(PerpError::Paused)
    } else {
        Ok(())
    }
}

fn read_price(
    env: &Env,
    asset: &Symbol,
    price_payload: Option<Bytes>,
) -> Result<PriceData, PerpError> {
    let cfg = read_config(env)?;
    let oracle = OracleClient::new(env, &cfg.oracle);
    let data = match price_payload {
        Some(payload) => oracle.verify_price_payload(&payload, asset),
        None => oracle.get_price(asset),
    };
    // Phase 4 — price floor: reject zero or negative oracle prices.
    if data.price <= 0 {
        return Err(PerpError::InvalidOraclePrice);
    }
    // Phase 4 — staleness guard: reject prices older than MAX_PRICE_AGE_SECS.
    let now = env.ledger().timestamp();
    if now.saturating_sub(data.write_timestamp) > MAX_PRICE_AGE_SECS {
        return Err(PerpError::OraclePriceTooOld);
    }
    Ok(data)
}

fn notional_value(size: i128, price: i128) -> Result<i128, PerpError> {
    mul_precision_checked(size, price).ok_or(PerpError::MathOverflow)
}

// ---------------------------------------------------------------------------
// Position helpers
// ---------------------------------------------------------------------------

/// Aggregate existing open positions for risk validation (avoids re-entrant
/// cross-contract calls into the risk engine).
fn aggregate_existing_positions(env: &Env, user: &Address) -> Result<(i128, i128), PerpError> {
    // Use stored position.margin (actual locked collateral) to avoid N oracle
    // cross-contract calls for N existing positions. Unrealized PnL is
    // conservatively set to 0 — this produces a stricter (safer) risk check
    // for users in profit, which is acceptable on testnet.
    let ids = read_user_positions(env, user);
    let mut total_initial: i128 = 0;
    for position_id in ids.iter() {
        let position = read_position(env, position_id)?;
        total_initial = total_initial
            .checked_add(position.margin)
            .ok_or(PerpError::MathOverflow)?;
    }
    Ok((total_initial, 0i128))
}

fn ensure_slippage(
    entry_price: i128,
    oracle_price: i128,
    max_slippage_bps: u32,
) -> Result<(), PerpError> {
    let diff = if entry_price >= oracle_price {
        entry_price.checked_sub(oracle_price)
    } else {
        oracle_price.checked_sub(entry_price)
    }
    .ok_or(PerpError::MathOverflow)?;

    let bps = diff
        .checked_mul(BPS_DENOMINATOR as i128)
        .and_then(|value| value.checked_div(oracle_price))
        .ok_or(PerpError::MathOverflow)?;
    if bps > max_slippage_bps as i128 {
        return Err(PerpError::SlippageExceeded);
    }
    Ok(())
}

fn current_funding_index(env: &Env, market_id: u32, is_long: bool) -> Result<i128, PerpError> {
    let cfg = read_config(env)?;
    let funding = FundingClient::new(env, &cfg.funding);
    let (long_idx, short_idx) = funding.get_accumulated_funding(&market_id);
    Ok(if is_long { long_idx } else { short_idx })
}

fn funding_pnl(position: &Position, current_idx: i128) -> Result<i128, PerpError> {
    funding_pnl_for_size(position, current_idx, position.size)
}

fn funding_pnl_for_size(
    position: &Position,
    current_idx: i128,
    size: i128,
) -> Result<i128, PerpError> {
    let delta = current_idx
        .checked_sub(position.last_funding_idx)
        .ok_or(PerpError::MathOverflow)?;
    let raw = mul_precision_checked(delta, size).ok_or(PerpError::MathOverflow)?;
    Ok(-raw)
}

fn trade_pnl(
    is_long: bool,
    size: i128,
    entry_price: i128,
    exit_price: i128,
) -> Result<i128, PerpError> {
    let price_delta = if is_long {
        exit_price.checked_sub(entry_price)
    } else {
        entry_price.checked_sub(exit_price)
    }
    .ok_or(PerpError::MathOverflow)?;
    mul_precision_checked(size, price_delta).ok_or(PerpError::MathOverflow)
}

fn settle_position_close(
    env: &Env,
    user: &Address,
    position_id: u64,
    released_margin: i128,
    gross_pnl: i128,
    close_fee: i128,
) -> Result<(), PerpError> {
    let cfg = read_config(env)?;
    let caller = env.current_contract_address();
    let vault = VaultClient::new(env, &cfg.vault);

    // Resolve the SLP vault address — required in HLP mode.
    let slp_vault_addr: Address = env
        .storage()
        .instance()
        .get(&DataKey::SlpVault)
        .ok_or(PerpError::SlpVaultNotConfigured)?;
    let slp = SlpVaultClient::new(env, &slp_vault_addr);

    // Step 1 — unlock margin: freed into the user's vault balance.
    vault.unlock_margin(&caller, user, &position_id, &released_margin);

    // Step 2 — close fee to SLP (uplift NAV).
    if close_fee > 0 {
        let capped_fee = close_fee.min(released_margin);
        if capped_fee > 0 {
            vault.move_balance(
                &caller,
                user,
                &slp_vault_addr,
                &cfg.settlement_token,
                &capped_fee,
            );
            slp.credit_pnl(&caller, &capped_fee);
        }
    }

    // Step 3 — settle gross PnL (trade + funding, before fee).
    match gross_pnl.cmp(&0) {
        core::cmp::Ordering::Greater => {
            // ── Profit: SLP pays the trader ─────────────────────────────────
            // draw_pnl decrements SLP TotalAssets and moves USDC internally.
            // Reverts with InsufficientLiquidity if SLP is empty.
            slp.try_draw_pnl(&caller, user, &gross_pnl)
                .map_err(|_| PerpError::InsufficientLiquidity)?
                .map_err(|_| PerpError::InsufficientLiquidity)?;

            env.events().publish(
                (symbol_short!("pnlpay"), user.clone()),
                gross_pnl,
            );
        }
        core::cmp::Ordering::Less => {
            // ── Loss: trader pays SLP ────────────────────────────────────────
            let fee_paid = close_fee.max(0).min(released_margin);
            let remaining_margin = released_margin
                .checked_sub(fee_paid)
                .unwrap_or(0)
                .max(0);
            let capped_loss = (-gross_pnl).min(remaining_margin);
            if capped_loss > 0 {
                vault.move_balance(
                    &caller,
                    user,
                    &slp_vault_addr,
                    &cfg.settlement_token,
                    &capped_loss,
                );
                slp.credit_pnl(&caller, &capped_loss);
            }
        }
        core::cmp::Ordering::Equal => {}
    }
    Ok(())
}

fn effective_leverage(size: i128, price: i128, margin: i128) -> Result<u32, PerpError> {
    if margin <= 0 {
        return Err(PerpError::InsufficientMargin);
    }
    let notional = notional_value(size, price)?;
    let leverage_fp = div_precision_checked(notional, margin).ok_or(PerpError::MathOverflow)?;
    let leverage = leverage_fp
        .checked_add(PRECISION - 1)
        .and_then(|value| value.checked_div(PRECISION))
        .ok_or(PerpError::MathOverflow)?;
    u32::try_from(leverage).map_err(|_| PerpError::InvalidLeverage)
}

fn next_pending_order_id(env: &Env) -> Result<u64, PerpError> {
    let id: u64 = env
        .storage()
        .instance()
        .get(&DataKey::NextOrderId)
        .unwrap_or(1u64);
    let next = id.checked_add(1).ok_or(PerpError::MathOverflow)?;
    env.storage().instance().set(&DataKey::NextOrderId, &next);
    Ok(id)
}

/// Phase R — monotonic plan id (TWAP + Iceberg share the same counter).
fn next_plan_id(env: &Env) -> u64 {
    let id: u64 = env
        .storage()
        .instance()
        .get(&DataKey::NextPlanId)
        .unwrap_or(1u64);
    let next = id.saturating_add(1);
    env.storage().instance().set(&DataKey::NextPlanId, &next);
    id
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use soroban_sdk::{
        contract, contractimpl, contracttype,
        testutils::{Address as _, Ledger as _},
        Address,
    };

    use super::*;

    // ------------------------------------------------------------------
    // Mock contracts
    // ------------------------------------------------------------------

    #[contract]
    struct MockOracle;

    #[contracttype]
    #[derive(Clone, Debug, Eq, PartialEq)]
    enum MockOracleKey {
        Price(Symbol),
    }

    #[contractimpl]
    impl MockOracle {
        pub fn set_price(env: Env, asset: Symbol, price: i128) {
            env.storage()
                .persistent()
                .set(&MockOracleKey::Price(asset), &price);
        }

        pub fn get_price(env: Env, asset: Symbol) -> PriceData {
            PriceData {
                price: env
                    .storage()
                    .persistent()
                    .get(&MockOracleKey::Price(asset))
                    .unwrap(),
                package_timestamp: 0,
                write_timestamp: env.ledger().timestamp(),
            }
        }

        pub fn verify_price_payload(env: Env, _payload: Bytes, asset: Symbol) -> PriceData {
            Self::get_price(env, asset)
        }

        pub fn submit_pyth_update(_env: Env, _update_data: Bytes, assets: Vec<Symbol>) -> u32 {
            // Tests don't exercise Pyth pull-mode at the perp-engine level;
            // return the count of requested assets as a no-op acknowledgment.
            assets.len()
        }
    }

    #[contract]
    struct MockVault;

    #[contracttype]
    #[derive(Clone, Debug, Eq, PartialEq)]
    enum MockVaultKey {
        Balance(Address, Address),
        Locked(Address, u64),
    }

    #[contractimpl]
    impl MockVault {
        pub fn set_balance(env: Env, user: Address, token: Address, amount: i128) {
            env.storage()
                .persistent()
                .set(&MockVaultKey::Balance(user, token), &amount);
        }

        pub fn get_balance(env: Env, user: Address, token: Address) -> i128 {
            env.storage()
                .persistent()
                .get(&MockVaultKey::Balance(user, token))
                .unwrap_or(0)
        }

        pub fn get_locked_margin(env: Env, user: Address, position_id: u64) -> i128 {
            env.storage()
                .persistent()
                .get(&MockVaultKey::Locked(user, position_id))
                .unwrap_or(0)
        }

        pub fn lock_margin(
            env: Env,
            _caller: Address,
            user: Address,
            position_id: u64,
            amount: i128,
        ) {
            let key = MockVaultKey::Locked(user, position_id);
            let current = env.storage().persistent().get(&key).unwrap_or(0i128);
            env.storage().persistent().set(&key, &(current + amount));
        }

        pub fn unlock_margin(
            env: Env,
            _caller: Address,
            user: Address,
            position_id: u64,
            amount: i128,
        ) {
            let key = MockVaultKey::Locked(user, position_id);
            let current = env.storage().persistent().get(&key).unwrap_or(0i128);
            let next = current - amount;
            if next == 0 {
                env.storage().persistent().remove(&key);
            } else {
                env.storage().persistent().set(&key, &next);
            }
        }

        pub fn move_balance(
            env: Env,
            _caller: Address,
            from: Address,
            to: Address,
            token: Address,
            amount: i128,
        ) {
            let from_key = MockVaultKey::Balance(from, token.clone());
            let to_key = MockVaultKey::Balance(to, token);
            let from_balance = env.storage().persistent().get(&from_key).unwrap_or(0i128);
            env.storage()
                .persistent()
                .set(&from_key, &(from_balance - amount));
            let to_balance = env.storage().persistent().get(&to_key).unwrap_or(0i128);
            env.storage()
                .persistent()
                .set(&to_key, &(to_balance + amount));
        }

        pub fn get_total_collateral_value(_env: Env, _user: Address) -> i128 {
            i128::MAX / 2
        }
    }

    #[contract]
    struct MockFunding;

    #[contracttype]
    #[derive(Clone, Debug, Eq, PartialEq)]
    enum MockFundingKey {
        Accumulated(u32),
        Rate(u32),
    }

    #[contractimpl]
    impl MockFunding {
        pub fn update_funding(_env: Env, _market_id: u32) {}

        pub fn set_accumulated_funding(env: Env, market_id: u32, long_idx: i128, short_idx: i128) {
            env.storage().persistent().set(
                &MockFundingKey::Accumulated(market_id),
                &(long_idx, short_idx),
            );
        }

        pub fn set_current_funding_rate(env: Env, market_id: u32, rate: i128) {
            env.storage()
                .persistent()
                .set(&MockFundingKey::Rate(market_id), &rate);
        }

        pub fn get_accumulated_funding(env: Env, market_id: u32) -> (i128, i128) {
            env.storage()
                .persistent()
                .get(&MockFundingKey::Accumulated(market_id))
                .unwrap_or((0, 0))
        }

        pub fn get_current_funding_rate(env: Env, market_id: u32) -> i128 {
            env.storage()
                .persistent()
                .get(&MockFundingKey::Rate(market_id))
                .unwrap_or(0)
        }
    }

    #[contract]
    struct MockRisk;

    #[contractimpl]
    impl MockRisk {
        pub fn validate_new_pos_with_inputs(
            _env: Env,
            _user: Address,
            _notional: i128,
            _margin: i128,
            _leverage: u32,
            _max_leverage: u32,
            _existing_initial_margin: i128,
            _existing_unrealized_pnl: i128,
            _total_collateral: i128,
        ) {
        }
    }

    /// Minimal mock SLP vault — tracks TotalAssets; uses MockVault for balance moves.
    #[contract]
    struct MockSlpVault;

    #[contracttype]
    #[derive(Clone)]
    enum MockSlpKey {
        Vault,
        Token,
    }

    #[contractimpl]
    impl MockSlpVault {
        pub fn set_vault(env: Env, vault: Address, token: Address) {
            env.storage().persistent().set(&MockSlpKey::Vault, &vault);
            env.storage().persistent().set(&MockSlpKey::Token, &token);
        }
        pub fn credit_pnl(_env: Env, _caller: Address, _amount: i128) {}
        pub fn draw_pnl(env: Env, _caller: Address, recipient: Address, amount: i128) {
            // Forward to MockVault so test balance assertions pass.
            if let (Some(vault), Some(token)) = (
                env.storage().persistent().get::<_, Address>(&MockSlpKey::Vault),
                env.storage().persistent().get::<_, Address>(&MockSlpKey::Token),
            ) {
                let v = MockVaultClient::new(&env, &vault);
                v.move_balance(
                    &env.current_contract_address(),
                    &env.current_contract_address(),
                    &recipient,
                    &token,
                    &amount,
                );
            }
        }
        pub fn record_loss(_env: Env, _caller: Address, _amount: i128) {}
    }

    // ------------------------------------------------------------------
    // Test setup
    // ------------------------------------------------------------------

    struct Setup {
        env: Env,
        admin: Address,
        settlement_token: Address,
        user_one: Address,
        user_two: Address,
        engine: StellaxPerpEngineClient<'static>,
        vault: MockVaultClient<'static>,
        oracle: MockOracleClient<'static>,
        funding: MockFundingClient<'static>,
        slp_vault: MockSlpVaultClient<'static>,
    }

    /// BTC oracle price: 100 000 USD in 18-decimal precision.
    const BTC_PRICE: i128 = 100_000_000_000_000_000_000_000i128; // 100_000 * 1e18

    /// Skew scale for tests: 1e22 base units.
    /// → a 200 BTC (mid-skew 100e18) trade produces 100e18/1e22 = 1% skew fee,
    ///   which exceeds the 5 bps tolerance in `slippage_protection_rejects_large_trade`.
    /// → a 1-2 BTC trade produces < 0.1% fee, well within normal tolerances.
    const TEST_SKEW_SCALE: i128 = 10_000_000_000_000_000_000_000i128; // 1e22

    /// Maker rebate: 10 bps (0.1%) — larger than maker_fee_bps (2 bps) so closes
    /// that reduce skew yield a positive trade PnL.
    const TEST_MAKER_REBATE_BPS: u32 = 10;

    fn setup() -> Setup {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let settlement_token = Address::generate(&env);
        let user_one = Address::generate(&env);
        let user_two = Address::generate(&env);

        let oracle_id = env.register(MockOracle, ());
        let vault_id = env.register(MockVault, ());
        let funding_id = env.register(MockFunding, ());
        let risk_id = env.register(MockRisk, ());
        let slp_vault_id = env.register(MockSlpVault, ());
        let engine_id = env.register(
            StellaxPerpEngine,
            (
                admin.clone(),
                oracle_id.clone(),
                vault_id.clone(),
                funding_id.clone(),
                risk_id,
                treasury.clone(),
                settlement_token.clone(),
            ),
        );

        let oracle = MockOracleClient::new(&env, &oracle_id);
        let vault = MockVaultClient::new(&env, &vault_id);
        let funding = MockFundingClient::new(&env, &funding_id);
        let slp_vault = MockSlpVaultClient::new(&env, &slp_vault_id);
        let engine = StellaxPerpEngineClient::new(&env, &engine_id);

        // HLP — register the mock SLP vault so fee/pnl routes don't error.
        engine.set_slp_vault(&slp_vault_id);
        // Wire the mock SLP vault to the mock vault so draw_pnl moves balances in tests.
        slp_vault.set_vault(&vault_id, &settlement_token);
        // Pre-fund the SLP vault sub-account so it can pay trader profits.
        vault.set_balance(
            &slp_vault_id,
            &settlement_token,
            &5_000_000_000_000_000_000_000i128,
        );

        oracle.set_price(&Symbol::new(&env, "BTC"), &BTC_PRICE);
        funding.set_accumulated_funding(&1u32, &0i128, &0i128);
        funding.set_current_funding_rate(&1u32, &0i128);
        vault.set_balance(
            &user_one,
            &settlement_token,
            &1_000_000_000_000_000_000_000i128,
        );
        vault.set_balance(
            &user_two,
            &settlement_token,
            &1_000_000_000_000_000_000_000i128,
        );
        vault.set_balance(
            &treasury,
            &settlement_token,
            &5_000_000_000_000_000_000_000i128,
        );

        let market = Market {
            market_id: 1,
            base_asset: Symbol::new(&env, "BTC"),
            quote_asset: Symbol::new(&env, "USD"),
            max_leverage: 50,
            maker_fee_bps: 2,
            taker_fee_bps: 5,
            max_oi_long: 10_000_000_000_000_000_000i128,
            max_oi_short: 10_000_000_000_000_000_000i128,
            is_active: true,
        };
        engine.register_market(
            &market,
            &10_000_000_000_000_000_000i128, // min_position_size
            &TEST_SKEW_SCALE,
            &TEST_MAKER_REBATE_BPS,
        );

        Setup {
            env,
            admin,
            settlement_token,
            user_one,
            user_two,
            engine,
            vault,
            oracle,
            funding,
            slp_vault,
        }
    }

    // ------------------------------------------------------------------
    // Tests
    // ------------------------------------------------------------------

    #[test]
    fn open_and_close_long_updates_balances_and_unlocks_margin() {
        let s = setup();

        // Open a long for user_one at oracle (zero skew → no skew fee).
        let position_id = s.engine.open_position(
            &s.user_one,
            &1u32,
            &1_000_000_000_000_000_000i128, // 1 BTC
            &true,
            &10u32,
            &100u32, // 1% slippage tolerance
            &None,
        );
        let locked_before = s.vault.get_locked_margin(&s.user_one, &position_id);
        assert!(locked_before > 0);

        // user_two opens a larger long, increasing the positive skew so that
        // user_one's close comes as a maker (reduces skew) and earns a rebate.
        s.engine.open_position(
            &s.user_two,
            &1u32,
            &2_000_000_000_000_000_000i128, // 2 BTC
            &true,
            &10u32,
            &300u32, // 3% tolerance covers skew fee on user_two's trade
            &None,
        );

        let user_balance_before_close = s.vault.get_balance(&s.user_one, &s.settlement_token);
        s.engine.close_position(&s.user_one, &position_id, &None);
        let user_balance_after_close = s.vault.get_balance(&s.user_one, &s.settlement_token);

        // Margin is fully released.
        assert_eq!(s.vault.get_locked_margin(&s.user_one, &position_id), 0);
        // Maker rebate (10 bps) > maker close fee (2 bps) → net positive PnL.
        assert!(user_balance_after_close > user_balance_before_close);
    }

    #[test]
    fn test_skew_fee_increases_with_imbalance() {
        let s = setup();

        // First long: zero skew → tiny fee, exec ≈ oracle.
        let pid1 = s.engine.open_position(
            &s.user_one,
            &1u32,
            &1_000_000_000_000_000_000i128,
            &true,
            &10u32,
            &500u32, // 5% tolerance
            &None,
        );
        let pos1 = s.engine.get_position(&s.user_one, &pid1);
        let entry1 = pos1.entry_price;

        // Second long: skew is now 1 BTC positive → larger fee.
        let pid2 = s.engine.open_position(
            &s.user_two,
            &1u32,
            &1_000_000_000_000_000_000i128,
            &true,
            &10u32,
            &500u32,
            &None,
        );
        let pos2 = s.engine.get_position(&s.user_two, &pid2);
        let entry2 = pos2.entry_price;

        // Second long should pay a higher execution price than the first.
        assert!(entry2 > entry1);
    }

    #[test]
    fn test_maker_rebate_for_thin_side() {
        let s = setup();

        // Open a large long to create significant positive skew.
        s.engine.open_position(
            &s.user_one,
            &1u32,
            &3_000_000_000_000_000_000i128, // 3 BTC long
            &true,
            &10u32,
            &1_000u32, // 10% tolerance
            &None,
        );

        // Open a short (reducing skew) — should receive maker rebate.
        let pid = s.engine.open_position(
            &s.user_two,
            &1u32,
            &1_000_000_000_000_000_000i128, // 1 BTC short
            &false,
            &10u32,
            &200u32, // 2% tolerance
            &None,
        );
        let pos = s.engine.get_position(&s.user_two, &pid);

        // Maker short executes at oracle + rebate (above oracle = better for the
        // short, who is selling and wants a higher price).
        assert!(pos.entry_price > BTC_PRICE);
    }

    #[test]
    fn rejects_leverage_above_market_max() {
        let s = setup();
        assert_eq!(
            s.engine.try_open_position(
                &s.user_one,
                &1u32,
                &1_000_000_000_000_000_000i128,
                &true,
                &51u32,
                &100u32,
                &None,
            ),
            Err(Ok(PerpError::InvalidLeverage))
        );
    }

    #[test]
    fn rejects_when_open_interest_cap_is_exceeded() {
        let s = setup();
        let market = Market {
            market_id: 2,
            base_asset: Symbol::new(&s.env, "ETH"),
            quote_asset: Symbol::new(&s.env, "USD"),
            max_leverage: 50,
            maker_fee_bps: 2,
            taker_fee_bps: 5,
            max_oi_long: 10_000_000_000_000_000_000i128,
            max_oi_short: 10_000_000_000_000_000_000i128,
            is_active: true,
        };
        s.oracle
            .set_price(&Symbol::new(&s.env, "ETH"), &2_000_000_000_000_000_000i128);
        s.engine.register_market(
            &market,
            &10_000_000_000_000_000_000i128,
            &TEST_SKEW_SCALE,
            &TEST_MAKER_REBATE_BPS,
        );

        s.engine.open_position(
            &s.user_one,
            &2u32,
            &6_000_000_000_000_000_000i128,
            &true,
            &10u32,
            &10_000u32,
            &None,
        );

        assert_eq!(
            s.engine.try_open_position(
                &s.user_two,
                &2u32,
                &5_000_000_000_000_000_000i128,
                &true,
                &10u32,
                &10_000u32,
                &None,
            ),
            Err(Ok(PerpError::OpenInterestExceeded))
        );
    }

    #[test]
    fn slippage_protection_rejects_large_trade() {
        // 200 BTC long with 5 bps slippage budget:
        // mid_skew = 100e18, skew_fee = BTC_PRICE * 100e18 / 1e22 = BTC_PRICE * 1% >> 5 bps.
        let s = setup();
        assert_eq!(
            s.engine.try_open_position(
                &s.user_one,
                &1u32,
                &200_000_000_000_000_000_000i128,
                &true,
                &5u32,
                &5u32, // 0.05% tolerance
                &None,
            ),
            Err(Ok(PerpError::SlippageExceeded))
        );
    }

    #[test]
    fn partial_close_reduces_position_size_and_locked_margin() {
        let s = setup();
        let position_id = s.engine.open_position(
            &s.user_one,
            &1u32,
            &2_000_000_000_000_000_000i128,
            &true,
            &10u32,
            &200u32, // 2% tolerance
            &None,
        );
        let locked_before = s.vault.get_locked_margin(&s.user_one, &position_id);

        s.engine.modify_position(
            &s.user_one,
            &position_id,
            &ModifyAction::PartialClose(1_000_000_000_000_000_000i128),
        );

        let position = s.engine.get_position(&s.user_one, &position_id);
        let locked_after = s.vault.get_locked_margin(&s.user_one, &position_id);
        assert_eq!(position.size, 1_000_000_000_000_000_000i128);
        assert!(locked_after < locked_before);
    }

    #[test]
    fn get_market_info_exposes_runtime_state() {
        let s = setup();
        s.funding.set_current_funding_rate(&1u32, &123i128);
        let info = s.engine.get_market_info(&1u32);
        assert_eq!(info.market.market_id, 1);
        assert_eq!(info.funding_rate, 123);
        // V2: mark price = oracle price.
        assert_eq!(info.mark_price, BTC_PRICE);
    }

    #[test]
    fn version_returns_two() {
        let s = setup();
        assert_eq!(s.engine.version(), 2);
    }

    // ─── Phase R — advanced order types ───────────────────────────────────────

    /// Helper: get the perp engine `admin` address (extracted via `get_config`)
    /// so tests can sign keeper-gated entries with it.
    fn engine_admin(s: &Setup) -> Address {
        s.admin.clone()
    }

    #[test]
    fn phase_r_create_twap_plan_allocates_id() {
        let s = setup();
        let plan_id = s.engine.create_twap_plan(
            &s.user_one,
            &1u32,
            &4_000_000_000_000_000_000i128, // 4 BTC total
            &true,
            &10u32,
            &100u32,
            &4u32,  // 4 slices
            &10u32, // 10 ledgers between slices
            &1_000u32,
        );
        assert_eq!(plan_id, 1);
        let plan = s.engine.get_twap_plan(&plan_id).unwrap();
        assert_eq!(plan.slices, 4);
        assert_eq!(plan.slices_released, 0);
        assert!(plan.active);
    }

    #[test]
    fn phase_r_release_twap_slice_respects_cadence() {
        let s = setup();
        let plan_id = s.engine.create_twap_plan(
            &s.user_one,
            &1u32,
            &4_000_000_000_000_000_000i128,
            &true,
            &10u32,
            &100u32,
            &4u32,
            &10u32,
            &1_000u32,
        );

        let admin = engine_admin(&s);
        // First slice should release immediately (released == 0 → next == start).
        let order_id_1 = s.engine.release_twap_slice(&admin, &plan_id);
        assert_eq!(order_id_1, 1);

        // Second slice before cadence elapses must error.
        let err = s
            .engine
            .try_release_twap_slice(&admin, &plan_id)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, PerpError::OrderConditionNotMet);

        // Advance 10 ledgers and release the second slice.
        s.env
            .ledger()
            .set_sequence_number(s.env.ledger().sequence() + 10);
        let order_id_2 = s.engine.release_twap_slice(&admin, &plan_id);
        assert!(order_id_2 > order_id_1);
        let plan = s.engine.get_twap_plan(&plan_id).unwrap();
        assert_eq!(plan.slices_released, 2);
    }

    #[test]
    fn phase_r_create_iceberg_plan_and_release_slice() {
        let s = setup();
        let plan_id = s.engine.create_iceberg_plan(
            &s.user_one,
            &1u32,
            &10_000_000_000_000_000_000i128, // 10 BTC total
            &2_000_000_000_000_000_000i128,  //  2 BTC visible
            &true,
            &10u32,
            &100u32,
            &BTC_PRICE,
            &1_000u32,
        );
        let plan = s.engine.get_iceberg_plan(&plan_id).unwrap();
        assert_eq!(plan.size_filled, 0);
        assert!(plan.active);

        let admin = engine_admin(&s);
        // Pretend the previous slice fully filled (caller passes filled_amount).
        let order_id =
            s.engine
                .release_iceberg_slice(&admin, &plan_id, &2_000_000_000_000_000_000i128);
        assert!(order_id >= 1);
        let plan = s.engine.get_iceberg_plan(&plan_id).unwrap();
        assert_eq!(plan.size_filled, 2_000_000_000_000_000_000i128);
    }

    #[test]
    fn phase_r_iceberg_plan_completes_when_total_filled() {
        let s = setup();
        let plan_id = s.engine.create_iceberg_plan(
            &s.user_one,
            &1u32,
            &4_000_000_000_000_000_000i128,
            &2_000_000_000_000_000_000i128,
            &true,
            &10u32,
            &100u32,
            &BTC_PRICE,
            &1_000u32,
        );
        let admin = engine_admin(&s);

        // Slice 1 — release with full fill of previous (none).
        s.engine.release_iceberg_slice(&admin, &plan_id, &0i128);
        // Slice 2 — pretend slice 1 fully filled.
        s.engine
            .release_iceberg_slice(&admin, &plan_id, &2_000_000_000_000_000_000i128);
        // Final fill — completion returns Ok(0) sentinel and persists !active.
        let sentinel =
            s.engine
                .release_iceberg_slice(&admin, &plan_id, &2_000_000_000_000_000_000i128);
        assert_eq!(sentinel, 0);
        let plan = s.engine.get_iceberg_plan(&plan_id).unwrap();
        assert!(!plan.active);
        // Any further call now hits the inactive guard and errors.
        let err = s
            .engine
            .try_release_iceberg_slice(&admin, &plan_id, &0i128)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, PerpError::PlanComplete);
    }

    #[test]
    fn phase_r_update_trailing_anchor_only_ratchets_favorably() {
        let s = setup();
        // Create a Trailing pending order: long, offset = 1000 USD (1e21),
        // anchor = current price.
        let offset: i128 = 1_000_000_000_000_000_000_000i128; // 1_000 * 1e18
        let order_id = s.engine.create_order(
            &s.user_one,
            &1u32,
            &1_000_000_000_000_000_000i128,
            &true,
            &10u32,
            &100u32,
            &OrderType::Trailing(offset, BTC_PRICE),
            &100u32,
        );
        let admin = engine_admin(&s);

        // Higher anchor → accepted.
        let new_anchor = BTC_PRICE + 5_000_000_000_000_000_000_000i128;
        s.engine
            .update_trailing_anchor(&admin, &order_id, &new_anchor);
        let order = s.engine.get_pending_order(&order_id);
        match order.order_type {
            OrderType::Trailing(o, a) => {
                assert_eq!(o, offset);
                assert_eq!(a, new_anchor);
            }
            _ => panic!("expected Trailing variant"),
        }

        // Lower anchor → rejected.
        let lower = BTC_PRICE;
        let err = s
            .engine
            .try_update_trailing_anchor(&admin, &order_id, &lower)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, PerpError::InvalidTrailingStop);
    }

    #[test]
    fn phase_r_bracket_link_requires_existing_orders_owned_by_user() {
        let s = setup();
        // Create three pending orders for user_one.
        let parent = s.engine.create_order(
            &s.user_one,
            &1u32,
            &1_000_000_000_000_000_000i128,
            &true,
            &10u32,
            &100u32,
            &OrderType::Limit(BTC_PRICE),
            &100u32,
        );
        let tp = s.engine.create_order(
            &s.user_one,
            &1u32,
            &1_000_000_000_000_000_000i128,
            &false,
            &10u32,
            &100u32,
            &OrderType::TakeProfit(BTC_PRICE + 1_000_000_000_000_000_000_000i128),
            &100u32,
        );
        let sl = s.engine.create_order(
            &s.user_one,
            &1u32,
            &1_000_000_000_000_000_000i128,
            &false,
            &10u32,
            &100u32,
            &OrderType::StopLoss(BTC_PRICE - 1_000_000_000_000_000_000_000i128),
            &100u32,
        );
        s.engine.bracket_link(&s.user_one, &parent, &tp, &sl);
        let group = s.engine.get_bracket(&parent).unwrap();
        assert!(group.active);
        assert_eq!(group.tp_id, tp);

        // Keeper cancels SL after TP fires → bracket becomes inactive.
        let admin = engine_admin(&s);
        s.engine.cancel_bracket_sibling(&admin, &parent, &sl);
        let group = s.engine.get_bracket(&parent).unwrap();
        assert!(!group.active);
    }
}
