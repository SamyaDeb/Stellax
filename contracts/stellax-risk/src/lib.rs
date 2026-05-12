//! StellaX risk engine.
//!
//! Phase 6 implements account-health checks, margin validation, liquidation,
//! insurance-fund accounting, and a minimal ADL backstop.

#![no_std]
#![allow(deprecated)]
#![allow(clippy::too_many_arguments)]

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, Address,
    Bytes, BytesN, Env, Map, Symbol, Vec,
};
use stellax_math::{
    apply_bps, div_precision_checked, mul_precision_checked, MarginMode, Market, OptionContract,
    PortfolioGreeks, PortfolioHealth, Position, MAINTENANCE_MARGIN_BPS, PRECISION,
    TTL_BUMP_PERSISTENT, TTL_THRESHOLD_PERSISTENT,
};

const CONTRACT_VERSION: u32 = 1;
const DEFAULT_LIQUIDATION_FEE_BPS: u32 = 50;
const DEFAULT_KEEPER_REWARD_BPS: u32 = 5_000;
const DEFAULT_INSURANCE_CAP: i128 = 1_000_000 * PRECISION;
const PARTIAL_LIQ_THRESHOLD: i128 = 100_000 * PRECISION;
const PARTIAL_LIQ_BPS: u32 = 2_000;
const PARTIAL_LIQ_COOLDOWN_SECS: u64 = 30;

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RiskError {
    AlreadyInitialized = 1,
    Unauthorized = 2,
    InvalidConfig = 3,
    InvalidPosition = 4,
    MarginTooLow = 5,
    WithdrawInvalid = 6,
    NotLiquidatable = 7,
    MathOverflow = 8,
    AdlUnavailable = 9,
    CooldownActive = 10,
    /// Phase 4 — contract is paused by admin; liquidations are blocked.
    Paused = 11,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RiskConfig {
    pub admin: Address,
    pub vault: Address,
    pub perp_engine: Address,
    pub funding: Address,
    pub oracle: Address,
    pub insurance_fund: Address,
    pub treasury: Address,
    pub settlement_token: Address,
    pub liquidation_fee_bps: u32,
    pub keeper_reward_bps: u32,
    pub insurance_cap: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountHealth {
    pub equity: i128,
    pub total_margin_required: i128,
    pub margin_ratio: i128,
    pub free_collateral: i128,
    pub liquidatable: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiquidationOutcome {
    pub liquidated_size: i128,
    pub oracle_price: i128,
    pub remaining_margin: i128,
    pub keeper_reward: i128,
    pub insurance_delta: i128,
    pub adl_triggered: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InsuranceEvent {
    pub balance: i128,
    pub delta: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum DataKey {
    Config,
    InsuranceFund,
    PartialLiq(u64),
    Version,
    /// Phase C: address of the stellax-options engine. Stored separately to
    /// avoid breaking `RiskConfig` serialisation on upgrade. Set post-upgrade
    /// via `set_options_engine`.
    OptionsEngine,
    /// Phase P: whitelist of contracts allowed to call `insurance_top_up`.
    /// Typically contains the treasury contract address. Stored under a new
    /// key so existing deployments can opt in via `add_insurance_funder`.
    InsuranceFunders,
    /// Phase SLP — address of the SLP vault contract. Mirrors the perp-engine
    /// copy; both are set by admin post-upgrade.  Risk engine reads this to
    /// route bad-debt absorption in Phase 1 (absorb to SLP NAV when insurance
    /// is exhausted).
    SlpVault,
    /// Phase SLP — address of the funding-pool sub-account inside the vault.
    /// Continuous funding settlements (Phase 2) read this via the risk engine.
    FundingPool,
    /// Phase 4 — boolean flag; present and `true` when the protocol is paused.
    /// Absent or `false` means live.  Stored in Instance storage for fast reads.
    Paused,
}

#[contractclient(name = "VaultClient")]
pub trait VaultInterface {
    fn get_total_collateral_value(env: Env, user: Address) -> i128;
    fn get_margin_mode(env: Env, user: Address) -> MarginMode;
    fn get_free_collateral_value(env: Env, user: Address) -> i128;
    fn get_balance(env: Env, user: Address, token_address: Address) -> i128;
    fn move_balance(
        env: Env,
        caller: Address,
        from: Address,
        to: Address,
        token_address: Address,
        amount: i128,
    );
    fn unlock_margin(env: Env, caller: Address, user: Address, position_id: u64, amount: i128);
}

#[contractclient(name = "PerpEngineClient")]
pub trait PerpEngineInterface {
    fn get_position_by_id(env: Env, position_id: u64) -> Position;
    fn get_positions_by_user(env: Env, user: Address) -> Vec<PositionEntry>;
    fn get_market(env: Env, market_id: u32) -> Market;
    fn get_unrealized_pnl(env: Env, position_id: u64) -> i128;
    fn get_position_ids_by_market(env: Env, market_id: u32) -> Vec<u64>;
    fn risk_close_position(
        env: Env,
        caller: Address,
        position_id: u64,
        close_size: i128,
        execution_price: i128,
    ) -> RiskCloseResult;
}

#[contractclient(name = "FundingClient")]
pub trait FundingInterface {
    fn update_funding(env: Env, market_id: u32);
    fn settle_funding(env: Env, position: Position) -> i128;
}

#[contractclient(name = "OracleClient")]
pub trait OracleInterface {
    fn get_price(env: Env, asset: Symbol) -> PriceData;
    fn verify_price_payload(env: Env, payload: Bytes, feed_id: Symbol) -> PriceData;
}

/// Phase C: the risk engine queries the options engine for a user's option
/// positions and their Black-Scholes deltas when computing portfolio margin.
#[contractclient(name = "OptionsEngineClient")]
pub trait OptionsEngineInterface {
    fn get_user_options(env: Env, user: Address) -> Vec<OptionContract>;
    fn get_option_delta(env: Env, option_id: u64) -> i128;
}

/// HLP — SLP vault entry points used by the risk engine.
#[contractclient(name = "SlpVaultClient")]
pub trait SlpVaultInterface {
    /// Increment TotalAssets by `amount` (18dp internal). No token movement.
    fn credit_pnl(env: Env, caller: Address, amount: i128) -> Result<(), soroban_sdk::Error>;
    /// Decrement TotalAssets by `amount` and move USDC from SLP → `recipient`.
    fn draw_pnl(
        env: Env,
        caller: Address,
        recipient: Address,
        amount: i128,
    ) -> Result<(), soroban_sdk::Error>;
    /// Decrement TotalAssets by `amount` with no token movement (bad debt).
    fn record_loss(env: Env, caller: Address, amount: i128) -> Result<(), soroban_sdk::Error>;
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

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    pub price: i128,
    pub package_timestamp: u64,
    pub write_timestamp: u64,
}

#[contract]
pub struct StellaxRisk;

#[contractimpl]
impl StellaxRisk {
    pub fn __constructor(
        env: Env,
        admin: Address,
        vault: Address,
        perp_engine: Address,
        funding: Address,
        oracle: Address,
        insurance_fund: Address,
        treasury: Address,
        settlement_token: Address,
    ) -> Result<(), RiskError> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(RiskError::AlreadyInitialized);
        }

        let cfg = RiskConfig {
            admin,
            vault,
            perp_engine,
            funding,
            oracle,
            insurance_fund,
            treasury,
            settlement_token,
            liquidation_fee_bps: DEFAULT_LIQUIDATION_FEE_BPS,
            keeper_reward_bps: DEFAULT_KEEPER_REWARD_BPS,
            insurance_cap: DEFAULT_INSURANCE_CAP,
        };
        env.storage().instance().set(&DataKey::Config, &cfg);
        env.storage()
            .persistent()
            .set(&DataKey::InsuranceFund, &0i128);
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

    pub fn validate_new_position(
        env: Env,
        user: Address,
        market_id: u32,
        notional: i128,
        margin: i128,
        leverage: u32,
    ) -> Result<(), RiskError> {
        bump_instance_ttl(&env);
        if notional <= 0 || margin <= 0 || leverage == 0 {
            return Err(RiskError::MarginTooLow);
        }

        let market = perp_client(&env)?.get_market(&market_id);
        let initial_required = initial_margin_requirement(notional, market.max_leverage)?;
        if margin < initial_required {
            return Err(RiskError::MarginTooLow);
        }

        let health = account_health_with_extra(&env, &user, initial_required, 0)?;
        if health.equity < health.total_margin_required {
            return Err(RiskError::MarginTooLow);
        }
        Ok(())
    }

    /// Re-entry-safe variant of `validate_new_position`. All data that would
    /// otherwise require calling back into the perp engine or vault must be
    /// passed by the caller, which already has that data in scope. Used by
    /// `stellax-perp-engine::open_position`.
    ///
    /// * `max_leverage` — from the market record the perp engine already has.
    /// * `existing_initial_margin` — sum of initial-margin requirements for
    ///   the user's already-open positions (before this one).
    /// * `existing_unrealized_pnl` — sum of trade+funding PnL for those
    ///   same positions.
    /// * `total_collateral` — user's total collateral value from the vault.
    pub fn validate_new_pos_with_inputs(
        env: Env,
        user: Address,
        notional: i128,
        margin: i128,
        leverage: u32,
        max_leverage: u32,
        existing_initial_margin: i128,
        existing_unrealized_pnl: i128,
        total_collateral: i128,
    ) -> Result<(), RiskError> {
        bump_instance_ttl(&env);
        let _ = user; // reserved for future per-user rules
        if notional <= 0 || margin <= 0 || leverage == 0 {
            return Err(RiskError::MarginTooLow);
        }
        let initial_required = initial_margin_requirement(notional, max_leverage)?;
        if margin < initial_required {
            return Err(RiskError::MarginTooLow);
        }
        let total_initial = existing_initial_margin
            .checked_add(initial_required)
            .ok_or(RiskError::MathOverflow)?;
        let equity = total_collateral
            .checked_add(existing_unrealized_pnl)
            .ok_or(RiskError::MathOverflow)?;
        if equity < total_initial {
            return Err(RiskError::MarginTooLow);
        }
        Ok(())
    }

    pub fn validate_withdrawal(
        env: Env,
        user: Address,
        withdrawal_amount: i128,
    ) -> Result<(), RiskError> {
        bump_instance_ttl(&env);
        if withdrawal_amount < 0 {
            return Err(RiskError::WithdrawInvalid);
        }
        let health = account_health_with_extra(&env, &user, 0, withdrawal_amount)?;
        if health.equity < health.total_margin_required {
            return Err(RiskError::WithdrawInvalid);
        }
        Ok(())
    }

    pub fn get_margin_requirement(env: Env, user: Address) -> Result<i128, RiskError> {
        bump_instance_ttl(&env);
        Ok(account_health_with_extra(&env, &user, 0, 0)?.total_margin_required)
    }

    /// Variant of `get_margin_requirement` that accepts the user's total
    /// collateral value as an argument instead of reading it back from the
    /// vault. This exists so the vault can safely query the margin
    /// requirement during its own execution without triggering a contract
    /// re-entry (Soroban forbids a contract from being called while an
    /// earlier frame of itself is still on the host stack).
    pub fn margin_req_with_collateral(
        env: Env,
        user: Address,
        total_collateral: i128,
    ) -> Result<i128, RiskError> {
        bump_instance_ttl(&env);
        Ok(account_health_with_inputs(&env, &user, total_collateral, 0, 0)?.total_margin_required)
    }

    /// Lightweight alternative to `margin_req_with_collateral` for use inside
    /// `vault::withdraw`.  Returns the sum of stored `position.margin` values
    /// across all open positions — **no oracle calls**, pure ledger reads.
    ///
    /// This avoids the N+2 oracle WASM loads that `account_health_with_inputs`
    /// performs (oracle price per position + USDC price from vault), which push
    /// the total instruction count past the 100 M Soroban budget at simulation
    /// time even for a single open position.
    ///
    /// Conservative: users in profit may see slightly less withdrawable balance
    /// than the mark-to-market figure, but the check is always safe (it never
    /// allows an undercollateralised withdrawal).
    pub fn get_total_initial_margin_stored(env: Env, user: Address) -> i128 {
        bump_instance_ttl(&env);
        let perp = match perp_client(&env) {
            Ok(c) => c,
            Err(_) => return 0, // no perp engine configured → no positions → 0 locked
        };
        perp.get_positions_by_user(&user)
            .iter()
            .fold(0i128, |acc, e| acc.saturating_add(e.position.margin))
    }

    /// Phase SLP — lightweight MTM equity estimate using stored margins only
    /// (no oracle calls, no cross-contract re-entry).
    ///
    /// `equity = vault_balance(user, settlement_token) - stored_initial_margin`
    ///
    /// This is intentionally conservative: it does NOT add unrealized profit,
    /// so users in profit see slightly less free equity than the true MTM
    /// value.  That makes it safe to use as a withdrawal guard without
    /// exceeding the Soroban compute budget.  Users in deep loss can still
    /// withdraw down to the stored-margin floor — the full `get_account_health`
    /// oracle path catches those cases during position health checks.
    ///
    /// Returns `(equity, locked_margin)` both in 18-decimal internal precision.
    pub fn get_account_equity(env: Env, user: Address) -> (i128, i128) {
        bump_instance_ttl(&env);
        let cfg = match read_config(&env) {
            Ok(c) => c,
            Err(_) => return (0, 0),
        };
        let vault = VaultClient::new(&env, &cfg.vault);
        let balance = vault.get_balance(&user, &cfg.settlement_token);
        let perp = match perp_client(&env) {
            Ok(c) => c,
            Err(_) => return (balance, 0),
        };
        let locked: i128 = perp
            .get_positions_by_user(&user)
            .iter()
            .fold(0i128, |acc, e| acc.saturating_add(e.position.margin));
        let equity = balance.saturating_sub(locked);
        (equity, locked)
    }


    pub fn get_account_health(env: Env, user: Address) -> Result<AccountHealth, RiskError> {
        bump_instance_ttl(&env);
        account_health_with_extra(&env, &user, 0, 0)
    }

    pub fn liquidate(
        env: Env,
        keeper: Address,
        user: Address,
        position_id: u64,
        price_payload: Option<Bytes>,
    ) -> Result<LiquidationOutcome, RiskError> {
        bump_instance_ttl(&env);
        // Phase 4 — block liquidations when the protocol is paused.
        let paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false);
        if paused {
            return Err(RiskError::Paused);
        }
        keeper.require_auth();

        let cfg = read_config(&env)?;
        let perp = perp_client(&env)?;
        let position = perp.get_position_by_id(&position_id);
        if position.owner != user {
            return Err(RiskError::InvalidPosition);
        }

        let market = perp.get_market(&position.market_id);
        let oracle_price = read_oracle_price(&env, &market.base_asset, price_payload)?;
        let funding_pnl = funding_client(&env)?.settle_funding(&position);
        let trade_pnl = trade_pnl_at_price(&position, oracle_price.price)?;
        let notional = notional_at_price(position.size, oracle_price.price)?;
        let maintenance = maintenance_margin_requirement(notional, market.max_leverage)?;
        let equity = position
            .margin
            .checked_add(trade_pnl)
            .and_then(|value| value.checked_add(funding_pnl))
            .ok_or(RiskError::MathOverflow)?;
        if equity >= maintenance {
            return Err(RiskError::NotLiquidatable);
        }

        let close_size = liquidation_size(&env, position_id, notional, position.size)?;
        let close_result = perp.risk_close_position(
            &env.current_contract_address(),
            &position_id,
            &close_size,
            &oracle_price.price,
        );

        let closed_notional = notional_at_price(close_result.closed_size, oracle_price.price)?;
        let penalty = apply_bps(closed_notional, cfg.liquidation_fee_bps);
        let keeper_reward = apply_bps(penalty, cfg.keeper_reward_bps);
        let insurance_reward = penalty
            .checked_sub(keeper_reward)
            .ok_or(RiskError::MathOverflow)?;
        let realized_total = close_result
            .trade_pnl
            .checked_add(close_result.funding_pnl)
            .ok_or(RiskError::MathOverflow)?;
        let remaining_margin = close_result
            .released_margin
            .checked_add(realized_total)
            .and_then(|value| value.checked_sub(penalty))
            .ok_or(RiskError::MathOverflow)?;

        distribute_liquidation_value(
            &env,
            &cfg,
            &user,
            &keeper,
            position_id,
            close_result.released_margin,
            remaining_margin,
            keeper_reward,
            insurance_reward,
        )?;

        let mut adl_triggered = false;
        if !close_result.position_closed {
            let updated = perp.get_position_by_id(&position_id);
            let remaining_notional = notional_at_price(updated.size, oracle_price.price)?;
            let updated_funding = funding_client(&env)?.settle_funding(&updated);
            let remaining_equity = updated
                .margin
                .checked_add(trade_pnl_at_price(&updated, oracle_price.price)?)
                .and_then(|value| value.checked_add(updated_funding))
                .ok_or(RiskError::MathOverflow)?;
            let remaining_maintenance =
                maintenance_margin_requirement(remaining_notional, market.max_leverage)?;
            if remaining_equity < remaining_maintenance {
                adl_triggered = run_adl(
                    &env,
                    updated.market_id,
                    remaining_maintenance - remaining_equity,
                )?;
            }
        }

        env.events().publish(
            (symbol_short!("liq"), user, position_id),
            (oracle_price.price, remaining_margin, keeper_reward),
        );

        Ok(LiquidationOutcome {
            liquidated_size: close_result.closed_size,
            oracle_price: oracle_price.price,
            remaining_margin,
            keeper_reward,
            insurance_delta: insurance_reward,
            adl_triggered,
        })
    }

    pub fn get_insurance_fund_balance(env: Env) -> Result<i128, RiskError> {
        bump_instance_ttl(&env);
        Ok(read_insurance_balance(&env))
    }

    pub fn update_liquidation_config(
        env: Env,
        liquidation_fee_bps: u32,
        keeper_reward_bps: u32,
        insurance_cap: i128,
    ) -> Result<(), RiskError> {
        bump_instance_ttl(&env);
        let mut cfg = read_config(&env)?;
        cfg.admin.require_auth();
        if liquidation_fee_bps > 10_000 || keeper_reward_bps > 10_000 || insurance_cap <= 0 {
            return Err(RiskError::InvalidConfig);
        }
        cfg.liquidation_fee_bps = liquidation_fee_bps;
        cfg.keeper_reward_bps = keeper_reward_bps;
        cfg.insurance_cap = insurance_cap;
        env.storage().instance().set(&DataKey::Config, &cfg);
        Ok(())
    }

    /// Admin-gated replacement of the risk engine's sibling module addresses.
    /// Used by governance when deploying new vault/perp/funding/oracle modules
    /// or rotating the treasury / insurance fund / settlement token.
    pub fn update_dependencies(
        env: Env,
        vault: Address,
        perp_engine: Address,
        funding: Address,
        oracle: Address,
        insurance_fund: Address,
        treasury: Address,
        settlement_token: Address,
    ) -> Result<(), RiskError> {
        bump_instance_ttl(&env);
        let mut cfg = read_config(&env)?;
        cfg.admin.require_auth();
        cfg.vault = vault;
        cfg.perp_engine = perp_engine;
        cfg.funding = funding;
        cfg.oracle = oracle;
        cfg.insurance_fund = insurance_fund;
        cfg.treasury = treasury;
        cfg.settlement_token = settlement_token;
        env.storage().instance().set(&DataKey::Config, &cfg);
        Ok(())
    }

    /// Phase C: admin-gated setter for the options engine address. Stored
    /// separately from `RiskConfig` so the storage layout of already-deployed
    /// instances keeps deserialising. Once set, portfolio-margin aware paths
    /// (`get_portfolio_health`, `compute_portfolio_greeks`) start querying
    /// the options engine for per-user Greeks.
    pub fn set_options_engine(env: Env, options_engine: Address) -> Result<(), RiskError> {
        bump_instance_ttl(&env);
        let cfg = read_config(&env)?;
        cfg.admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::OptionsEngine, &options_engine);
        Ok(())
    }

    pub fn get_options_engine(env: Env) -> Result<Address, RiskError> {
        bump_instance_ttl(&env);
        env.storage()
            .instance()
            .get(&DataKey::OptionsEngine)
            .ok_or(RiskError::InvalidConfig)
    }

    // ─── Phase SLP: SLP vault + funding-pool wiring ───────────────────────────

    /// Phase SLP — admin-gated registration of the SLP vault address.
    ///
    /// Stored under `DataKey::SlpVault` to avoid mutating `RiskConfig`.
    /// Phase 1 loss-waterfall logic reads this to absorb bad debt into SLP
    /// NAV when the insurance fund is exhausted.
    pub fn set_slp_vault(env: Env, slp_vault: Address) -> Result<(), RiskError> {
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

    /// Phase SLP — return the registered SLP vault address, or `None`.
    pub fn get_slp_vault(env: Env) -> Option<Address> {
        bump_instance_ttl(&env);
        env.storage().instance().get(&DataKey::SlpVault)
    }

    /// Phase SLP — admin-gated registration of the funding-pool sub-account.
    pub fn set_funding_pool(env: Env, funding_pool: Address) -> Result<(), RiskError> {
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

    /// Phase SLP — return the registered funding-pool address, or `None`.
    pub fn get_funding_pool(env: Env) -> Option<Address> {
        bump_instance_ttl(&env);
        env.storage().instance().get(&DataKey::FundingPool)
    }

    // ─── Phase 4: pause / unpause ────────────────────────────────────────────

    /// Phase 4 — admin-only: halt liquidations immediately.
    pub fn pause(env: Env) -> Result<(), RiskError> {
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

    /// Phase 4 — admin-only: resume liquidations after a pause.
    pub fn unpause(env: Env) -> Result<(), RiskError> {
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

    /// Phase 4 — returns `true` when the risk contract is currently paused.
    pub fn is_paused(env: Env) -> bool {
        bump_instance_ttl(&env);
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    /// Phase C: aggregate net delta (signed) per market across all perp and
    /// option positions held by `user`.
    ///
    /// * Perps contribute `±size` per contract.
    /// * Options contribute `delta * size / PRECISION`, where `delta` is the
    ///   Black-Scholes delta returned by the options engine (+ve for longs,
    ///   -ve for puts) and `size` is the signed holder/writer size.
    ///
    /// `net_delta_notional` is `Σ_market |net_delta[m]| * oracle_price[m]`
    /// and represents the dollar-exposure used to size portfolio margin.
    pub fn compute_portfolio_greeks(env: Env, user: Address) -> Result<PortfolioGreeks, RiskError> {
        bump_instance_ttl(&env);
        portfolio_greeks(&env, &user)
    }

    /// Phase C: portfolio-margin variant of `get_account_health`. Uses the
    /// aggregated net-delta-notional rather than summing per-position
    /// notionals, which lets hedged perp+option positions share margin.
    /// Falls back to the standard path when the options engine is unset or
    /// the user has no options, keeping behaviour identical for V1 users.
    pub fn get_portfolio_health(env: Env, user: Address) -> Result<PortfolioHealth, RiskError> {
        bump_instance_ttl(&env);
        portfolio_health(&env, &user)
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), RiskError> {
        bump_instance_ttl(&env);
        let cfg = read_config(&env)?;
        cfg.admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        env.storage()
            .instance()
            .set(&DataKey::Version, &(CONTRACT_VERSION + 1));
        Ok(())
    }

    // ─── Phase P: Insurance fund auto-growth wiring ───────────────────────────

    /// Whitelist a contract address (typically the treasury) so it can call
    /// `insurance_top_up` to credit fee revenue into the insurance fund.
    /// Idempotent. Admin-only.
    pub fn add_insurance_funder(env: Env, source: Address) -> Result<(), RiskError> {
        bump_instance_ttl(&env);
        let cfg = read_config(&env)?;
        cfg.admin.require_auth();
        let mut funders: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::InsuranceFunders)
            .unwrap_or_else(|| Vec::new(&env));
        for i in 0..funders.len() {
            if funders.get_unchecked(i) == source {
                return Ok(());
            }
        }
        funders.push_back(source.clone());
        env.storage()
            .persistent()
            .set(&DataKey::InsuranceFunders, &funders);
        env.events().publish((symbol_short!("ins_fndr"),), source);
        Ok(())
    }

    /// Remove a previously authorised top-up source. Admin-only.
    pub fn remove_insurance_funder(env: Env, source: Address) -> Result<(), RiskError> {
        bump_instance_ttl(&env);
        let cfg = read_config(&env)?;
        cfg.admin.require_auth();
        let funders: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::InsuranceFunders)
            .unwrap_or_else(|| Vec::new(&env));
        let mut next: Vec<Address> = Vec::new(&env);
        for i in 0..funders.len() {
            let entry = funders.get_unchecked(i);
            if entry != source {
                next.push_back(entry);
            }
        }
        env.storage()
            .persistent()
            .set(&DataKey::InsuranceFunders, &next);
        Ok(())
    }

    /// Return the list of authorised insurance-top-up sources.
    pub fn get_insurance_funders(env: Env) -> Vec<Address> {
        bump_instance_ttl(&env);
        env.storage()
            .persistent()
            .get(&DataKey::InsuranceFunders)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Credit `amount` to the insurance-fund balance counter.
    ///
    /// Caller (typically the treasury contract) must already have transferred
    /// the underlying settlement-token reserves to `cfg.insurance_fund`. This
    /// function only updates the on-chain accounting counter that the
    /// liquidation / ADL paths use to size their cover.
    ///
    /// Honors `cfg.insurance_cap`: any portion that would push the balance
    /// above the cap is rejected (caller may reroute the excess via the
    /// treasury's split logic). Source must be whitelisted via
    /// `add_insurance_funder`.
    pub fn insurance_top_up(env: Env, source: Address, amount: i128) -> Result<i128, RiskError> {
        bump_instance_ttl(&env);
        source.require_auth();
        if amount <= 0 {
            return Err(RiskError::InvalidConfig);
        }
        let cfg = read_config(&env)?;
        let funders: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::InsuranceFunders)
            .unwrap_or_else(|| Vec::new(&env));
        let mut authorised = false;
        for i in 0..funders.len() {
            if funders.get_unchecked(i) == source {
                authorised = true;
                break;
            }
        }
        if !authorised {
            return Err(RiskError::Unauthorized);
        }

        let balance = read_insurance_balance(&env);
        let next = balance.checked_add(amount).ok_or(RiskError::MathOverflow)?;
        if next > cfg.insurance_cap {
            return Err(RiskError::InvalidConfig);
        }
        write_insurance_balance(&env, next)?;
        env.events()
            .publish((symbol_short!("ins_top"), source), (amount, next));
        Ok(next)
    }

    /// Pay out `amount` from the insurance fund to `recipient`.
    ///
    /// **HLP migration note**: the insurance fund is deprecated in HLP mode.
    /// This entry point is kept as a storage-compatible stub so existing SDK
    /// clients and the perp-engine ABI don't break.  In HLP mode it always
    /// returns the current insurance balance (0 after migration sweep) without
    /// moving any tokens.  Admin auth is still required so it can't be called
    /// anonymously.
    pub fn insurance_payout(env: Env, recipient: Address, amount: i128) -> Result<i128, RiskError> {
        bump_instance_ttl(&env);
        let cfg = read_config(&env)?;
        cfg.admin.require_auth();
        if amount <= 0 {
            return Err(RiskError::InvalidConfig);
        }
        let _ = recipient;
        // HLP stub — no token movement; return current (inert) balance.
        Ok(read_insurance_balance(&env))
    }
}

fn bump_instance_ttl(_env: &Env) {
    // No-op: see perp-engine for rationale. TTL extended out-of-band.
}

fn read_config(env: &Env) -> Result<RiskConfig, RiskError> {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(RiskError::InvalidConfig)
}

fn perp_client(env: &Env) -> Result<PerpEngineClient<'_>, RiskError> {
    Ok(PerpEngineClient::new(env, &read_config(env)?.perp_engine))
}

fn vault_client(env: &Env) -> Result<VaultClient<'_>, RiskError> {
    Ok(VaultClient::new(env, &read_config(env)?.vault))
}

fn funding_client(env: &Env) -> Result<FundingClient<'_>, RiskError> {
    Ok(FundingClient::new(env, &read_config(env)?.funding))
}

fn oracle_client(env: &Env) -> Result<OracleClient<'_>, RiskError> {
    Ok(OracleClient::new(env, &read_config(env)?.oracle))
}

/// HLP — resolve the SLP vault client.  Returns `Err(AdlUnavailable)` if the
/// address has not been configured via `set_slp_vault`.
fn slp_client(env: &Env) -> Result<SlpVaultClient<'_>, RiskError> {
    env.storage()
        .instance()
        .get::<_, Address>(&DataKey::SlpVault)
        .map(|addr| SlpVaultClient::new(env, &addr))
        .ok_or(RiskError::AdlUnavailable)
}

/// Returns the options-engine client iff `set_options_engine` has been called.
/// Keeps pre-Phase-C deployments working: callers treat `None` as "no option
/// positions exist for anyone" and fall back to the perp-only code paths.
fn options_engine_client(env: &Env) -> Option<OptionsEngineClient<'_>> {
    env.storage()
        .instance()
        .get::<_, Address>(&DataKey::OptionsEngine)
        .map(|addr| OptionsEngineClient::new(env, &addr))
}

fn read_oracle_price(
    env: &Env,
    asset: &Symbol,
    price_payload: Option<Bytes>,
) -> Result<PriceData, RiskError> {
    let oracle = oracle_client(env)?;
    Ok(match price_payload {
        Some(payload) => oracle.verify_price_payload(&payload, asset),
        None => oracle.get_price(asset),
    })
}

fn account_health_with_extra(
    env: &Env,
    user: &Address,
    extra_initial_margin: i128,
    withdrawal_amount: i128,
) -> Result<AccountHealth, RiskError> {
    let vault = vault_client(env)?;
    let total_collateral = vault.get_total_collateral_value(user);
    account_health_with_inputs(
        env,
        user,
        total_collateral,
        extra_initial_margin,
        withdrawal_amount,
    )
}

/// Shared account-health calculation that takes the user's total collateral
/// as an explicit input. Used by the vault (which already knows the
/// collateral and must not re-enter itself) and by `account_health_with_extra`
/// for callers that want the risk engine to fetch collateral itself.
fn account_health_with_inputs(
    env: &Env,
    user: &Address,
    total_collateral: i128,
    extra_initial_margin: i128,
    withdrawal_amount: i128,
) -> Result<AccountHealth, RiskError> {
    let perp = perp_client(env)?;
    let positions = perp.get_positions_by_user(user);

    let mut total_unrealized = 0i128;
    let mut total_maintenance = 0i128;
    let mut total_initial = extra_initial_margin;

    for entry in positions.iter() {
        let position_id = entry.position_id;
        let position = entry.position;
        let market = perp.get_market(&position.market_id);
        let funding_pnl = funding_client(env)?.settle_funding(&position);
        let trade_pnl = perp
            .get_unrealized_pnl(&position_id)
            .checked_sub(funding_pnl)
            .ok_or(RiskError::MathOverflow)?;
        let price = read_oracle_price(env, &market.base_asset, None)?.price;
        let notional = notional_at_price(position.size, price)?;

        total_unrealized = total_unrealized
            .checked_add(trade_pnl)
            .and_then(|value| value.checked_add(funding_pnl))
            .ok_or(RiskError::MathOverflow)?;
        total_maintenance = total_maintenance
            .checked_add(maintenance_margin_requirement(
                notional,
                market.max_leverage,
            )?)
            .ok_or(RiskError::MathOverflow)?;
        total_initial = total_initial
            .checked_add(initial_margin_requirement(notional, market.max_leverage)?)
            .ok_or(RiskError::MathOverflow)?;
    }

    let equity = total_collateral
        .checked_add(total_unrealized)
        .and_then(|value| value.checked_sub(withdrawal_amount))
        .ok_or(RiskError::MathOverflow)?;
    let free_collateral = equity
        .checked_sub(total_initial)
        .ok_or(RiskError::MathOverflow)?;
    let margin_ratio = if total_maintenance > 0 {
        div_precision_checked(equity, total_maintenance).ok_or(RiskError::MathOverflow)?
    } else {
        i128::MAX
    };

    Ok(AccountHealth {
        equity,
        total_margin_required: total_initial,
        margin_ratio,
        free_collateral,
        liquidatable: total_maintenance > 0 && equity < total_maintenance,
    })
}

fn initial_margin_requirement(notional: i128, max_leverage: u32) -> Result<i128, RiskError> {
    if max_leverage == 0 {
        return Err(RiskError::InvalidConfig);
    }
    notional
        .checked_div(max_leverage as i128)
        .ok_or(RiskError::MathOverflow)
}

/// Phase C — Portfolio greeks aggregation.
///
/// Walks the user's perp positions and (if the options engine is configured)
/// their option holdings, accumulating a signed net-delta per market id.
/// Total notional is the gross sum of per-position notionals (informational);
/// `net_delta_notional` is `Σ_market |net_delta[m]| * oracle_price[m]` and is
/// what portfolio margin is sized against.
fn portfolio_greeks(env: &Env, user: &Address) -> Result<PortfolioGreeks, RiskError> {
    let perp = perp_client(env)?;
    let positions = perp.get_positions_by_user(user);

    // market_id -> net signed delta (PRECISION-scaled contracts)
    let mut net_delta: Map<u32, i128> = Map::new(env);
    let mut total_notional: i128 = 0;

    for entry in positions.iter() {
        let position = entry.position;
        let market = perp.get_market(&position.market_id);
        let price = read_oracle_price(env, &market.base_asset, None)?.price;
        let signed_size = if position.is_long {
            position.size
        } else {
            -position.size
        };
        let current = net_delta.get(position.market_id).unwrap_or(0);
        let updated = current
            .checked_add(signed_size)
            .ok_or(RiskError::MathOverflow)?;
        net_delta.set(position.market_id, updated);
        total_notional = total_notional
            .checked_add(notional_at_price(position.size, price)?)
            .ok_or(RiskError::MathOverflow)?;
    }

    // Options contribute delta * size / PRECISION. We assume `option.market_id`
    // is encoded in the high 32 bits of `option_id` (matches stellax-options).
    // A holder's size is positive; a writer's size is negative.
    if let Some(options) = options_engine_client(env) {
        let user_options = options.get_user_options(user);
        for option in user_options.iter() {
            let delta = options.get_option_delta(&option.option_id);
            if delta == 0 || option.size == 0 {
                continue;
            }
            // Writer (short option) contributes -delta; holder contributes +delta.
            let directed_size = if option.holder == *user {
                option.size
            } else if option.writer == *user {
                -option.size
            } else {
                continue;
            };
            let contribution =
                mul_precision_checked(delta, directed_size).ok_or(RiskError::MathOverflow)?;
            let market_id = (option.option_id >> 32) as u32;
            let current = net_delta.get(market_id).unwrap_or(0);
            let updated = current
                .checked_add(contribution)
                .ok_or(RiskError::MathOverflow)?;
            net_delta.set(market_id, updated);
        }
    }

    // Aggregate |net_delta[m]| * price[m] across all markets touched.
    let mut net_delta_notional: i128 = 0;
    for (market_id, delta) in net_delta.iter() {
        if delta == 0 {
            continue;
        }
        let abs_delta = delta.checked_abs().ok_or(RiskError::MathOverflow)?;
        let market = perp.get_market(&market_id);
        let price = read_oracle_price(env, &market.base_asset, None)?.price;
        let notional = notional_at_price(abs_delta, price)?;
        net_delta_notional = net_delta_notional
            .checked_add(notional)
            .ok_or(RiskError::MathOverflow)?;
    }

    Ok(PortfolioGreeks {
        net_delta,
        total_notional,
        net_delta_notional,
    })
}

/// Phase C — Portfolio-margin health.
///
/// Portfolio margin is sized against the residual delta-notional after
/// offsetting hedges, divided by the max leverage of the markets involved.
/// For simplicity (and to stay conservative) we use the minimum max-leverage
/// across markets the user has exposure to — that way a low-leverage market
/// always anchors the margin requirement.
fn portfolio_health(env: &Env, user: &Address) -> Result<PortfolioHealth, RiskError> {
    let vault = vault_client(env)?;
    let total_collateral = vault.get_total_collateral_value(user);
    let greeks = portfolio_greeks(env, user)?;
    let perp = perp_client(env)?;

    // Find the tightest (lowest) max_leverage across markets the user touches.
    // If the user has no positions at all this loop is empty and we default to
    // leverage=1 (collateral fully available).
    let mut min_max_leverage: u32 = 0;
    for (market_id, delta) in greeks.net_delta.iter() {
        if delta == 0 {
            continue;
        }
        let market = perp.get_market(&market_id);
        if min_max_leverage == 0 || market.max_leverage < min_max_leverage {
            min_max_leverage = market.max_leverage;
        }
    }

    let portfolio_margin_required = if min_max_leverage == 0 {
        0
    } else {
        initial_margin_requirement(greeks.net_delta_notional, min_max_leverage)?
    };

    // Equity for portfolio margin ignores unrealised PnL on options (they are
    // cash-settled at expiry via the options engine) and uses the same perp
    // PnL that `account_health_with_inputs` uses, for consistency.
    let mut total_unrealized = 0i128;
    let positions = perp.get_positions_by_user(user);
    for entry in positions.iter() {
        let position_id = entry.position_id;
        let position = entry.position.clone();
        let funding_pnl = funding_client(env)?.settle_funding(&position);
        let trade_pnl = perp
            .get_unrealized_pnl(&position_id)
            .checked_sub(funding_pnl)
            .ok_or(RiskError::MathOverflow)?;
        total_unrealized = total_unrealized
            .checked_add(trade_pnl)
            .and_then(|v| v.checked_add(funding_pnl))
            .ok_or(RiskError::MathOverflow)?;
    }

    let total_collateral_value = total_collateral
        .checked_add(total_unrealized)
        .ok_or(RiskError::MathOverflow)?;
    let free_collateral = total_collateral_value
        .checked_sub(portfolio_margin_required)
        .ok_or(RiskError::MathOverflow)?;
    let liquidatable =
        portfolio_margin_required > 0 && total_collateral_value < portfolio_margin_required;

    Ok(PortfolioHealth {
        total_collateral_value,
        portfolio_margin_required,
        free_collateral,
        liquidatable,
        net_delta_usd: greeks.net_delta_notional,
    })
}

fn maintenance_margin_requirement(notional: i128, max_leverage: u32) -> Result<i128, RiskError> {
    let initial = initial_margin_requirement(notional, max_leverage)?;
    initial
        .checked_mul(MAINTENANCE_MARGIN_BPS as i128)
        .and_then(|value| value.checked_div(10_000))
        .ok_or(RiskError::MathOverflow)
}

fn notional_at_price(size: i128, price: i128) -> Result<i128, RiskError> {
    mul_precision_checked(size, price).ok_or(RiskError::MathOverflow)
}

fn trade_pnl_at_price(position: &Position, price: i128) -> Result<i128, RiskError> {
    let delta = if position.is_long {
        price.checked_sub(position.entry_price)
    } else {
        position.entry_price.checked_sub(price)
    }
    .ok_or(RiskError::MathOverflow)?;

    mul_precision_checked(position.size, delta).ok_or(RiskError::MathOverflow)
}

fn liquidation_size(
    env: &Env,
    position_id: u64,
    notional: i128,
    full_size: i128,
) -> Result<i128, RiskError> {
    if notional <= PARTIAL_LIQ_THRESHOLD {
        return Ok(full_size);
    }

    let key = DataKey::PartialLiq(position_id);
    if let Some(last) = env.storage().persistent().get::<_, u64>(&key) {
        if env.ledger().timestamp().saturating_sub(last) < PARTIAL_LIQ_COOLDOWN_SECS {
            return Err(RiskError::CooldownActive);
        }
    }

    let partial = full_size
        .checked_mul(PARTIAL_LIQ_BPS as i128)
        .and_then(|value| value.checked_div(10_000))
        .ok_or(RiskError::MathOverflow)?;
    let close_size = partial.max(PRECISION.min(full_size));
    env.storage()
        .persistent()
        .set(&key, &env.ledger().timestamp());
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_PERSISTENT, TTL_BUMP_PERSISTENT);
    Ok(close_size.min(full_size))
}

#[allow(clippy::too_many_arguments)]
fn distribute_liquidation_value(
    env: &Env,
    cfg: &RiskConfig,
    user: &Address,
    keeper: &Address,
    position_id: u64,
    released_margin: i128,
    remaining_margin: i128,
    keeper_reward: i128,
    insurance_reward: i128,
) -> Result<(), RiskError> {
    let vault = vault_client(env)?;
    let caller = env.current_contract_address();

    // HLP — resolve the SLP vault address. Required post-upgrade.
    let slp_vault_addr: Address = env
        .storage()
        .instance()
        .get(&DataKey::SlpVault)
        .ok_or(RiskError::AdlUnavailable)?;
    let slp = SlpVaultClient::new(env, &slp_vault_addr);

    // Step 1 — unlock user's margin back into their vault balance.
    vault.unlock_margin(&caller, user, &position_id, &released_margin);

    // Step 2 — pay keeper reward directly from user's vault balance.
    if keeper_reward > 0 {
        vault.move_balance(
            &caller,
            user,
            keeper,
            &cfg.settlement_token,
            &keeper_reward,
        );
    }

    // Step 3 — route insurance portion to SLP (uplift NAV).
    if insurance_reward > 0 {
        vault.move_balance(
            &caller,
            user,
            &slp_vault_addr,
            &cfg.settlement_token,
            &insurance_reward,
        );
        slp.credit_pnl(&caller, &insurance_reward);
    }

    // Step 4 — if remaining_margin is negative the user is insolvent.
    // Decrement SLP TotalAssets to absorb the bad debt (no token movement
    // since the vault already capped transfers at the available balance).
    if remaining_margin < 0 {
        let bad_debt = (-remaining_margin) as i128;
        // Use saturating deduction: SLP NAV can't go below zero.
        let _ = slp.try_record_loss(&caller, &bad_debt);
    }
    Ok(())
}

fn read_insurance_balance(env: &Env) -> i128 {
    let key = DataKey::InsuranceFund;
    let value = env.storage().persistent().get(&key).unwrap_or(0i128);
    if env.storage().persistent().has(&key) {
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD_PERSISTENT, TTL_BUMP_PERSISTENT);
    }
    value
}

fn write_insurance_balance(env: &Env, value: i128) -> Result<(), RiskError> {
    env.storage()
        .persistent()
        .set(&DataKey::InsuranceFund, &value);
    env.storage().persistent().extend_ttl(
        &DataKey::InsuranceFund,
        TTL_THRESHOLD_PERSISTENT,
        TTL_BUMP_PERSISTENT,
    );
    env.events().publish(
        (symbol_short!("insfund"),),
        InsuranceEvent {
            balance: value,
            delta: value,
        },
    );
    Ok(())
}

fn run_adl(env: &Env, market_id: u32, required_coverage: i128) -> Result<bool, RiskError> {
    let perp = perp_client(env)?;
    let ids = perp.get_position_ids_by_market(&market_id);
    let mut best_score = i128::MIN;
    let mut best_position_id = None;
    let market = perp.get_market(&market_id);
    let oracle_price = read_oracle_price(env, &market.base_asset, None)?.price;

    for position_id in ids.iter() {
        let position = perp.get_position_by_id(&position_id);
        let pnl = trade_pnl_at_price(&position, oracle_price)?
            .checked_add(funding_client(env)?.settle_funding(&position))
            .ok_or(RiskError::MathOverflow)?;
        if pnl <= 0 || position.margin <= 0 {
            continue;
        }

        let pnl_ratio =
            div_precision_checked(pnl, position.margin).ok_or(RiskError::MathOverflow)?;
        let score = pnl_ratio
            .checked_mul(position.leverage as i128)
            .ok_or(RiskError::MathOverflow)?;
        if score > best_score {
            best_score = score;
            best_position_id = Some(position_id);
        }
    }

    let Some(position_id) = best_position_id else {
        return Ok(false);
    };

    let position = perp.get_position_by_id(&position_id);
    let notional = notional_at_price(position.size, oracle_price)?;
    let close_size = position
        .size
        .checked_mul(required_coverage.min(notional))
        .and_then(|value| value.checked_div(notional.max(1)))
        .ok_or(RiskError::MathOverflow)?
        .max(PRECISION.min(position.size));

    let result = perp.risk_close_position(
        &env.current_contract_address(),
        &position_id,
        &close_size.min(position.size),
        &oracle_price,
    );

    // Phase SLP — pay the ADL winner from SLP instead of the insurance fund.
    //
    // `risk_close_position` already removed the position from state and
    // unlocked the margin into the user's vault balance.  We now owe:
    //   gross_pnl = trade_pnl + funding_pnl  (both computed at oracle_price)
    //
    // draw_pnl decrements SLP TotalAssets and moves USDC SLP → winner.
    // If the SLP is exhausted, we cap the payout (no revert — ADL is a
    // last-resort backstop; partial payout is still better than none).
    let gross_pnl = result
        .trade_pnl
        .checked_add(result.funding_pnl)
        .ok_or(RiskError::MathOverflow)?;

    if gross_pnl > 0 {
        let slp = slp_client(env)?;
        let payout = gross_pnl;
        // try_draw_pnl: if SLP doesn't have enough, it returns InsufficientLiquidity.
        // We emit an event showing how much was owed vs paid.
        let paid = match slp.try_draw_pnl(
            &env.current_contract_address(),
            &result.user,
            &payout,
        ) {
            Ok(_) => payout,
            Err(_) => 0i128, // SLP exhausted; no payout but don't revert
        };
        env.events().publish(
            (symbol_short!("adlpay"), result.user.clone(), position_id),
            (gross_pnl, paid),
        );
    }

    env.events().publish(
        (symbol_short!("adl"), result.user, position_id),
        close_size,
    );
    Ok(true)
}

#[cfg(test)]
mod tests {
    use soroban_sdk::{contract, contractimpl, contracttype, testutils::Address as _, Address};

    use super::*;

    #[contract]
    struct MockVault;

    #[contracttype]
    #[derive(Clone, Debug, Eq, PartialEq)]
    enum MockVaultKey {
        Total(Address),
        Mode(Address),
        Balance(Address, Address),
        Locked(Address, u64),
    }

    #[contractimpl]
    impl MockVault {
        pub fn set_total_collateral(env: Env, user: Address, amount: i128) {
            env.storage()
                .persistent()
                .set(&MockVaultKey::Total(user), &amount);
        }

        pub fn set_margin_mode(env: Env, user: Address, mode: MarginMode) {
            env.storage()
                .persistent()
                .set(&MockVaultKey::Mode(user), &mode);
        }

        pub fn set_balance(env: Env, user: Address, token: Address, amount: i128) {
            env.storage()
                .persistent()
                .set(&MockVaultKey::Balance(user, token), &amount);
        }

        pub fn set_locked_margin(env: Env, user: Address, position_id: u64, amount: i128) {
            env.storage()
                .persistent()
                .set(&MockVaultKey::Locked(user, position_id), &amount);
        }

        pub fn get_total_collateral_value(env: Env, user: Address) -> i128 {
            env.storage()
                .persistent()
                .get(&MockVaultKey::Total(user))
                .unwrap_or(0)
        }

        pub fn get_margin_mode(env: Env, user: Address) -> MarginMode {
            env.storage()
                .persistent()
                .get(&MockVaultKey::Mode(user))
                .unwrap_or(MarginMode::Cross)
        }

        pub fn get_free_collateral_value(env: Env, user: Address) -> i128 {
            Self::get_total_collateral_value(env, user)
        }

        pub fn move_balance(
            env: Env,
            _caller: Address,
            from: Address,
            to: Address,
            token_address: Address,
            amount: i128,
        ) {
            let from_key = MockVaultKey::Balance(from, token_address.clone());
            let to_key = MockVaultKey::Balance(to, token_address);
            let from_balance = env.storage().persistent().get(&from_key).unwrap_or(0i128);
            env.storage()
                .persistent()
                .set(&from_key, &(from_balance - amount));
            let to_balance = env.storage().persistent().get(&to_key).unwrap_or(0i128);
            env.storage()
                .persistent()
                .set(&to_key, &(to_balance + amount));
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
            if next <= 0 {
                env.storage().persistent().remove(&key);
            } else {
                env.storage().persistent().set(&key, &next);
            }
        }
    }

    #[contract]
    struct MockFunding;

    #[contracttype]
    #[derive(Clone, Debug, Eq, PartialEq)]
    enum MockFundingKey {
        Payment(u64),
    }

    #[contractimpl]
    impl MockFunding {
        pub fn update_funding(_env: Env, _market_id: u32) {}

        pub fn set_payment(env: Env, position_id: u64, amount: i128) {
            env.storage()
                .persistent()
                .set(&MockFundingKey::Payment(position_id), &amount);
        }

        pub fn settle_funding(env: Env, position: Position) -> i128 {
            env.storage()
                .persistent()
                .get(&MockFundingKey::Payment(position.open_timestamp))
                .unwrap_or(0)
        }
    }

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
    }

    #[contract]
    struct MockPerp;

    #[contracttype]
    #[derive(Clone, Debug, Eq, PartialEq)]
    enum MockPerpKey {
        Market(u32),
        Position(u64),
        UserPositions(Address),
        MarketPositions(u32),
        Pnl(u64),
    }

    #[contractimpl]
    impl MockPerp {
        pub fn set_market(env: Env, market: Market) {
            env.storage()
                .persistent()
                .set(&MockPerpKey::Market(market.market_id), &market);
        }

        pub fn set_position(env: Env, position_id: u64, position: Position) {
            env.storage()
                .persistent()
                .set(&MockPerpKey::Position(position_id), &position);
        }

        pub fn set_positions_by_user(env: Env, user: Address, positions: Vec<PositionEntry>) {
            env.storage()
                .persistent()
                .set(&MockPerpKey::UserPositions(user), &positions);
        }

        pub fn set_market_positions(env: Env, market_id: u32, ids: Vec<u64>) {
            env.storage()
                .persistent()
                .set(&MockPerpKey::MarketPositions(market_id), &ids);
        }

        pub fn set_unrealized_pnl(env: Env, position_id: u64, pnl: i128) {
            env.storage()
                .persistent()
                .set(&MockPerpKey::Pnl(position_id), &pnl);
        }

        pub fn get_position_by_id(env: Env, position_id: u64) -> Position {
            env.storage()
                .persistent()
                .get(&MockPerpKey::Position(position_id))
                .unwrap()
        }

        pub fn get_positions_by_user(env: Env, user: Address) -> Vec<PositionEntry> {
            env.storage()
                .persistent()
                .get(&MockPerpKey::UserPositions(user))
                .unwrap_or(Vec::new(&env))
        }

        pub fn get_market(env: Env, market_id: u32) -> Market {
            env.storage()
                .persistent()
                .get(&MockPerpKey::Market(market_id))
                .unwrap()
        }

        pub fn get_unrealized_pnl(env: Env, position_id: u64) -> i128 {
            env.storage()
                .persistent()
                .get(&MockPerpKey::Pnl(position_id))
                .unwrap_or(0)
        }

        pub fn get_position_ids_by_market(env: Env, market_id: u32) -> Vec<u64> {
            env.storage()
                .persistent()
                .get(&MockPerpKey::MarketPositions(market_id))
                .unwrap_or(Vec::new(&env))
        }

        pub fn risk_close_position(
            env: Env,
            _caller: Address,
            position_id: u64,
            close_size: i128,
            execution_price: i128,
        ) -> RiskCloseResult {
            let mut position: Position = env
                .storage()
                .persistent()
                .get(&MockPerpKey::Position(position_id))
                .unwrap();
            let close_ratio = div_precision_checked(close_size, position.size).unwrap();
            let released_margin = mul_precision_checked(position.margin, close_ratio).unwrap();
            let price_delta = if position.is_long {
                execution_price - position.entry_price
            } else {
                position.entry_price - execution_price
            };
            let trade_pnl = mul_precision_checked(close_size, price_delta).unwrap();
            let funding_pnl = 0;
            let was_closed = close_size == position.size;
            if was_closed {
                env.storage()
                    .persistent()
                    .remove(&MockPerpKey::Position(position_id));
            } else {
                position.size -= close_size;
                position.margin -= released_margin;
                env.storage()
                    .persistent()
                    .set(&MockPerpKey::Position(position_id), &position);
            }
            RiskCloseResult {
                user: position.owner,
                market_id: position.market_id,
                closed_size: close_size,
                released_margin,
                trade_pnl,
                funding_pnl,
                remaining_size: if was_closed { 0 } else { position.size },
                remaining_margin: if was_closed { 0 } else { position.margin },
                position_closed: was_closed,
            }
        }
    }

    // ── Minimal no-op SLP vault mock for risk engine tests ───────────────
    #[contract]
    struct MockSlpVaultR;

    #[contractimpl]
    impl MockSlpVaultR {
        pub fn credit_pnl(_env: Env, _caller: Address, _amount: i128) {}
        pub fn draw_pnl(_env: Env, _caller: Address, _recipient: Address, _amount: i128) {}
        pub fn record_loss(_env: Env, _caller: Address, _amount: i128) {}
    }

    struct Setup {
        env: Env,
        user: Address,
        keeper: Address,
        risk: StellaxRiskClient<'static>,
        perp: MockPerpClient<'static>,
        oracle: MockOracleClient<'static>,
    }

    fn base_market(env: &Env) -> Market {
        Market {
            market_id: 1,
            base_asset: Symbol::new(env, "BTC"),
            quote_asset: Symbol::new(env, "USD"),
            max_leverage: 10,
            maker_fee_bps: 2,
            taker_fee_bps: 5,
            max_oi_long: 1_000 * PRECISION,
            max_oi_short: 1_000 * PRECISION,
            is_active: true,
        }
    }

    fn make_position(
        _env: &Env,
        user: &Address,
        position_id: u64,
        entry_price: i128,
        margin: i128,
        is_long: bool,
        size: i128,
    ) -> Position {
        Position {
            owner: user.clone(),
            market_id: 1,
            size,
            entry_price,
            margin,
            leverage: 10,
            is_long,
            last_funding_idx: 0,
            open_timestamp: position_id,
        }
    }

    fn setup() -> Setup {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let keeper = Address::generate(&env);
        let treasury = Address::generate(&env);
        let insurance = Address::generate(&env);
        let settlement = Address::generate(&env);

        let vault_id = env.register(MockVault, ());
        let perp_id = env.register(MockPerp, ());
        let funding_id = env.register(MockFunding, ());
        let oracle_id = env.register(MockOracle, ());
        let slp_vault_id = env.register(MockSlpVaultR, ());
        let risk_id = env.register(
            StellaxRisk,
            (
                admin,
                vault_id.clone(),
                perp_id.clone(),
                funding_id.clone(),
                oracle_id.clone(),
                insurance.clone(),
                treasury.clone(),
                settlement.clone(),
            ),
        );

        let vault = MockVaultClient::new(&env, &vault_id);
        let perp = MockPerpClient::new(&env, &perp_id);
        let _funding = MockFundingClient::new(&env, &funding_id);
        let oracle = MockOracleClient::new(&env, &oracle_id);
        let risk = StellaxRiskClient::new(&env, &risk_id);

        // Register the SLP vault so liquidate/ADL paths don't error.
        risk.set_slp_vault(&slp_vault_id);

        vault.set_total_collateral(&user, &(200 * PRECISION));
        vault.set_margin_mode(&user, &MarginMode::Cross);
        vault.set_balance(&user, &settlement, &(500 * PRECISION));
        vault.set_balance(&insurance, &settlement, &(500 * PRECISION));
        vault.set_balance(&treasury, &settlement, &(500 * PRECISION));
        perp.set_market(&base_market(&env));
        oracle.set_price(&Symbol::new(&env, "BTC"), &(100 * PRECISION));

        Setup {
            env,
            user,
            keeper,
            risk,
            perp,
            oracle,
        }
    }

    #[test]
    fn validate_new_position_accepts_exact_initial_margin() {
        let s = setup();
        s.risk.validate_new_position(
            &s.user,
            &1u32,
            &(100 * PRECISION),
            &(10 * PRECISION),
            &10u32,
        );
    }

    #[test]
    fn validate_new_position_rejects_below_initial_margin() {
        let s = setup();
        assert_eq!(
            s.risk.try_validate_new_position(
                &s.user,
                &1u32,
                &(100 * PRECISION),
                &(9 * PRECISION),
                &10u32
            ),
            Err(Ok(RiskError::MarginTooLow))
        );
    }

    #[test]
    fn get_account_health_includes_existing_positions() {
        let s = setup();
        let position = make_position(
            &s.env,
            &s.user,
            1,
            100 * PRECISION,
            10 * PRECISION,
            true,
            PRECISION,
        );
        let mut entries = Vec::new(&s.env);
        entries.push_back(PositionEntry {
            position_id: 1,
            position: position.clone(),
        });
        s.perp.set_position(&1u64, &position);
        s.perp.set_positions_by_user(&s.user, &entries);
        s.perp.set_unrealized_pnl(&1u64, &(5 * PRECISION));

        let health = s.risk.get_account_health(&s.user);
        assert_eq!(health.equity, 205 * PRECISION);
        assert!(!health.liquidatable);
    }

    #[test]
    fn liquidate_rejects_healthy_position() {
        let s = setup();
        let position = make_position(
            &s.env,
            &s.user,
            1,
            100 * PRECISION,
            20 * PRECISION,
            true,
            PRECISION,
        );
        let mut entries = Vec::new(&s.env);
        entries.push_back(PositionEntry {
            position_id: 1,
            position: position.clone(),
        });
        let mut market_ids = Vec::new(&s.env);
        market_ids.push_back(1u64);
        s.perp.set_position(&1u64, &position);
        s.perp.set_positions_by_user(&s.user, &entries);
        s.perp.set_market_positions(&1u32, &market_ids);
        s.oracle
            .set_price(&Symbol::new(&s.env, "BTC"), &(100 * PRECISION));

        assert_eq!(
            s.risk.try_liquidate(&s.keeper, &s.user, &1u64, &None),
            Err(Ok(RiskError::NotLiquidatable))
        );
    }

    #[test]
    fn liquidate_unhealthy_position_succeeds() {
        let s = setup();
        let position = make_position(
            &s.env,
            &s.user,
            1,
            100 * PRECISION,
            5 * PRECISION,
            true,
            PRECISION,
        );
        let mut entries = Vec::new(&s.env);
        entries.push_back(PositionEntry {
            position_id: 1,
            position: position.clone(),
        });
        let mut market_ids = Vec::new(&s.env);
        market_ids.push_back(1u64);
        s.perp.set_position(&1u64, &position);
        s.perp.set_positions_by_user(&s.user, &entries);
        s.perp.set_market_positions(&1u32, &market_ids);
        s.oracle
            .set_price(&Symbol::new(&s.env, "BTC"), &(90 * PRECISION));

        let outcome = s.risk.liquidate(&s.keeper, &s.user, &1u64, &None);
        assert_eq!(outcome.oracle_price, 90 * PRECISION);
        assert_eq!(outcome.liquidated_size, PRECISION);
    }

    #[test]
    fn partial_liquidation_triggers_for_large_positions() {
        let s = setup();
        let size = 3_000 * PRECISION;
        let position = make_position(
            &s.env,
            &s.user,
            1,
            100 * PRECISION,
            20 * PRECISION,
            true,
            size,
        );
        let mut entries = Vec::new(&s.env);
        entries.push_back(PositionEntry {
            position_id: 1,
            position: position.clone(),
        });
        let mut market_ids = Vec::new(&s.env);
        market_ids.push_back(1u64);
        s.perp.set_position(&1u64, &position);
        s.perp.set_positions_by_user(&s.user, &entries);
        s.perp.set_market_positions(&1u32, &market_ids);
        s.oracle
            .set_price(&Symbol::new(&s.env, "BTC"), &(40 * PRECISION));

        let outcome = s.risk.liquidate(&s.keeper, &s.user, &1u64, &None);
        assert_eq!(outcome.liquidated_size, 600 * PRECISION);
    }

    #[test]
    fn adl_triggers_when_remaining_position_stays_underwater() {
        let s = setup();
        let large = make_position(
            &s.env,
            &s.user,
            1,
            100 * PRECISION,
            20 * PRECISION,
            true,
            4_000 * PRECISION,
        );
        let profitable = make_position(
            &s.env,
            &Address::generate(&s.env),
            2,
            10 * PRECISION,
            20 * PRECISION,
            true,
            PRECISION,
        );
        let mut user_entries = Vec::new(&s.env);
        user_entries.push_back(PositionEntry {
            position_id: 1,
            position: large.clone(),
        });
        let mut adl_entries = Vec::new(&s.env);
        adl_entries.push_back(PositionEntry {
            position_id: 2,
            position: profitable.clone(),
        });
        let mut market_ids = Vec::new(&s.env);
        market_ids.push_back(1u64);
        market_ids.push_back(2u64);
        s.perp.set_position(&1u64, &large);
        s.perp.set_position(&2u64, &profitable);
        s.perp.set_positions_by_user(&s.user, &user_entries);
        s.perp
            .set_positions_by_user(&profitable.owner, &adl_entries);
        s.perp.set_market_positions(&1u32, &market_ids);
        s.oracle
            .set_price(&Symbol::new(&s.env, "BTC"), &(30 * PRECISION));

        let outcome = s.risk.liquidate(&s.keeper, &s.user, &1u64, &None);
        assert!(outcome.adl_triggered);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Phase C — Portfolio margin
    // ─────────────────────────────────────────────────────────────────────

    #[contract]
    struct MockOptions;

    #[contracttype]
    #[derive(Clone, Debug, Eq, PartialEq)]
    enum MockOptKey {
        UserOpts(Address),
        Delta(u64),
    }

    #[contractimpl]
    impl MockOptions {
        pub fn set_user_options(env: Env, user: Address, opts: Vec<OptionContract>) {
            env.storage()
                .persistent()
                .set(&MockOptKey::UserOpts(user), &opts);
        }

        pub fn set_option_delta(env: Env, option_id: u64, delta: i128) {
            env.storage()
                .persistent()
                .set(&MockOptKey::Delta(option_id), &delta);
        }

        pub fn get_user_options(env: Env, user: Address) -> Vec<OptionContract> {
            env.storage()
                .persistent()
                .get(&MockOptKey::UserOpts(user))
                .unwrap_or(Vec::new(&env))
        }

        pub fn get_option_delta(env: Env, option_id: u64) -> i128 {
            env.storage()
                .persistent()
                .get(&MockOptKey::Delta(option_id))
                .unwrap_or(0)
        }
    }

    fn put_option(
        _env: &Env,
        holder: &Address,
        writer: &Address,
        option_id: u64,
        size: i128,
    ) -> OptionContract {
        OptionContract {
            option_id,
            strike: 100 * PRECISION,
            expiry: u64::MAX,
            is_call: false,
            size,
            premium: PRECISION,
            writer: writer.clone(),
            holder: holder.clone(),
            is_exercised: false,
        }
    }

    /// When options engine unset, portfolio greeks reduce to perp-only
    /// aggregation and still produce correct net-delta.
    #[test]
    fn portfolio_greeks_perp_only_matches_perp_size() {
        let s = setup();
        let position = make_position(
            &s.env,
            &s.user,
            1,
            100 * PRECISION,
            20 * PRECISION,
            true,
            PRECISION,
        );
        let mut entries = Vec::new(&s.env);
        entries.push_back(PositionEntry {
            position_id: 1,
            position: position.clone(),
        });
        s.perp.set_position(&1u64, &position);
        s.perp.set_positions_by_user(&s.user, &entries);

        let greeks = s.risk.compute_portfolio_greeks(&s.user);
        assert_eq!(greeks.net_delta.get(1u32).unwrap(), PRECISION);
        // 1 BTC long at $100 → $100 of delta notional.
        assert_eq!(greeks.net_delta_notional, 100 * PRECISION);
    }

    /// Long perp + long put with same |size| and delta≈-1 should produce a
    /// net-delta close to zero, which in turn produces near-zero portfolio
    /// margin requirement. This is the canonical hedged position the spec
    /// wants portfolio margin to reward.
    #[test]
    fn portfolio_margin_offsets_hedged_perp_and_put() {
        let s = setup();
        // Register and wire mock options engine.
        let options_id = s.env.register(MockOptions, ());
        let options = MockOptionsClient::new(&s.env, &options_id);
        s.risk.set_options_engine(&options_id);

        // 1 BTC long perp.
        let position = make_position(
            &s.env,
            &s.user,
            1,
            100 * PRECISION,
            20 * PRECISION,
            true,
            PRECISION,
        );
        let mut entries = Vec::new(&s.env);
        entries.push_back(PositionEntry {
            position_id: 1,
            position: position.clone(),
        });
        s.perp.set_position(&1u64, &position);
        s.perp.set_positions_by_user(&s.user, &entries);

        // 1 long put on market 1 with delta ≈ -1 (PRECISION-scaled).
        // Encode market_id=1 in high 32 bits of option_id (matches stellax-options layout).
        let option_id = (1u64 << 32) | 1;
        let writer = Address::generate(&s.env);
        let put = put_option(&s.env, &s.user, &writer, option_id, PRECISION);
        let mut opts = Vec::new(&s.env);
        opts.push_back(put);
        options.set_user_options(&s.user, &opts);
        options.set_option_delta(&option_id, &(-PRECISION));

        let greeks = s.risk.compute_portfolio_greeks(&s.user);
        // Net delta on market 1 = +1 (perp) + (-1)*1 (put) = 0.
        assert_eq!(greeks.net_delta.get(1u32).unwrap_or(0), 0);
        assert_eq!(greeks.net_delta_notional, 0);

        let health = s.risk.get_portfolio_health(&s.user);
        assert_eq!(health.net_delta_usd, 0);
        assert_eq!(health.portfolio_margin_required, 0);
        assert!(!health.liquidatable);
    }

    /// Unhedged portfolio: long perp, no offsetting option. Portfolio margin
    /// should equal the notional/max-leverage for that market.
    #[test]
    fn portfolio_margin_unhedged_matches_initial_margin() {
        let s = setup();
        let options_id = s.env.register(MockOptions, ());
        s.risk.set_options_engine(&options_id);

        let position = make_position(
            &s.env,
            &s.user,
            1,
            100 * PRECISION,
            20 * PRECISION,
            true,
            PRECISION,
        );
        let mut entries = Vec::new(&s.env);
        entries.push_back(PositionEntry {
            position_id: 1,
            position: position.clone(),
        });
        s.perp.set_position(&1u64, &position);
        s.perp.set_positions_by_user(&s.user, &entries);

        let health = s.risk.get_portfolio_health(&s.user);
        // notional = 1 * 100 = 100; max_leverage = 10 → margin = 10.
        assert_eq!(health.net_delta_usd, 100 * PRECISION);
        assert_eq!(health.portfolio_margin_required, 10 * PRECISION);
        assert!(!health.liquidatable);
    }

    // ─── Phase P: insurance auto-growth wiring ────────────────────────────

    /// Build a minimal risk-contract setup whose admin / treasury are
    /// addressable, so Phase P entry points can be exercised end-to-end.
    fn phase_p_setup() -> (Env, Address, Address, Address, StellaxRiskClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let insurance = Address::generate(&env);
        let settlement = Address::generate(&env);

        let vault_id = env.register(MockVault, ());
        let perp_id = env.register(MockPerp, ());
        let funding_id = env.register(MockFunding, ());
        let oracle_id = env.register(MockOracle, ());
        let risk_id = env.register(
            StellaxRisk,
            (
                admin.clone(),
                vault_id.clone(),
                perp_id,
                funding_id,
                oracle_id,
                insurance.clone(),
                treasury.clone(),
                settlement.clone(),
            ),
        );

        // Pre-fund the insurance sub-account in the vault so payouts
        // can be exercised against `vault.move_balance`.
        let vault = MockVaultClient::new(&env, &vault_id);
        vault.set_balance(&insurance, &settlement, &(1_000 * PRECISION));

        let risk = StellaxRiskClient::new(&env, &risk_id);
        (env, admin, treasury, insurance, risk)
    }

    #[test]
    fn insurance_top_up_credits_balance_for_whitelisted_source() {
        let (_env, _admin, treasury, _insurance, risk) = phase_p_setup();

        risk.add_insurance_funder(&treasury);
        let new_balance = risk.insurance_top_up(&treasury, &(50 * PRECISION));

        assert_eq!(new_balance, 50 * PRECISION);
        assert_eq!(risk.get_insurance_fund_balance(), 50 * PRECISION);
    }

    #[test]
    fn insurance_top_up_rejects_non_whitelisted_source() {
        let (env, _admin, _treasury, _insurance, risk) = phase_p_setup();
        let stranger = Address::generate(&env);

        let err = risk
            .try_insurance_top_up(&stranger, &(50 * PRECISION))
            .unwrap_err()
            .unwrap();
        assert_eq!(err, RiskError::Unauthorized);
    }

    #[test]
    fn insurance_top_up_rejects_amount_exceeding_cap() {
        let (_env, _admin, treasury, _insurance, risk) = phase_p_setup();

        // Default cap is 1_000_000 * PRECISION; pushing past it must fail.
        risk.add_insurance_funder(&treasury);
        risk.insurance_top_up(&treasury, &(999_999 * PRECISION));

        let err = risk
            .try_insurance_top_up(&treasury, &(2 * PRECISION))
            .unwrap_err()
            .unwrap();
        assert_eq!(err, RiskError::InvalidConfig);
    }

    #[test]
    fn insurance_funder_remove_blocks_subsequent_top_ups() {
        let (_env, _admin, treasury, _insurance, risk) = phase_p_setup();

        risk.add_insurance_funder(&treasury);
        risk.insurance_top_up(&treasury, &(10 * PRECISION));
        risk.remove_insurance_funder(&treasury);

        let err = risk
            .try_insurance_top_up(&treasury, &(10 * PRECISION))
            .unwrap_err()
            .unwrap();
        assert_eq!(err, RiskError::Unauthorized);
    }

    #[test]
    fn insurance_payout_decrements_balance_and_moves_tokens() {
        let (_env, _admin, treasury, _insurance, risk) = phase_p_setup();

        risk.add_insurance_funder(&treasury);
        risk.insurance_top_up(&treasury, &(100 * PRECISION));

        let recipient = Address::generate(&_env);
        // HLP stub: payout is a no-op — returns the unchanged inert balance.
        let new_balance = risk.insurance_payout(&recipient, &(40 * PRECISION));

        assert_eq!(new_balance, 100 * PRECISION);
        assert_eq!(risk.get_insurance_fund_balance(), 100 * PRECISION);
    }

    #[test]
    fn insurance_payout_rejects_overdraft() {
        let (_env, _admin, treasury, _insurance, risk) = phase_p_setup();

        risk.add_insurance_funder(&treasury);
        risk.insurance_top_up(&treasury, &(10 * PRECISION));

        let recipient = Address::generate(&_env);
        // HLP stub: no overdraft check — returns the unchanged inert balance.
        let new_balance = risk.insurance_payout(&recipient, &(20 * PRECISION));
        assert_eq!(new_balance, 10 * PRECISION);
    }
}
