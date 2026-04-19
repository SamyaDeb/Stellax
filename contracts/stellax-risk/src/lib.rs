//! StellaX risk engine.
//!
//! Phase 6 implements account-health checks, margin validation, liquidation,
//! insurance-fund accounting, and a minimal ADL backstop.

#![no_std]
#![allow(clippy::too_many_arguments)]

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, Address,
    Bytes, BytesN, Env, Symbol, Vec,
};
use stellax_math::{
    apply_bps, div_precision_checked, mul_precision_checked, MarginMode, Market, Position,
    MAINTENANCE_MARGIN_BPS, PRECISION, TTL_BUMP_INSTANCE, TTL_BUMP_PERSISTENT,
    TTL_THRESHOLD_INSTANCE, TTL_THRESHOLD_PERSISTENT,
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
}

#[contractclient(name = "VaultClient")]
pub trait VaultInterface {
    fn get_total_collateral_value(env: Env, user: Address) -> i128;
    fn get_margin_mode(env: Env, user: Address) -> MarginMode;
    fn get_free_collateral_value(env: Env, user: Address) -> i128;
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
}

fn bump_instance_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_INSTANCE, TTL_BUMP_INSTANCE);
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
    let penalty_total = keeper_reward
        .checked_add(insurance_reward)
        .ok_or(RiskError::MathOverflow)?;

    vault.unlock_margin(&caller, user, &position_id, &released_margin);
    if penalty_total > 0 {
        vault.move_balance(
            &caller,
            user,
            &cfg.insurance_fund,
            &cfg.settlement_token,
            &penalty_total,
        );
        credit_insurance(env, cfg, penalty_total)?;
    }

    if keeper_reward > 0 {
        vault.move_balance(
            &caller,
            &cfg.insurance_fund,
            keeper,
            &cfg.settlement_token,
            &keeper_reward,
        );
        let after_reward = read_insurance_balance(env)
            .checked_sub(keeper_reward)
            .ok_or(RiskError::MathOverflow)?;
        write_insurance_balance(env, after_reward)?;
    }

    if remaining_margin < 0 {
        let bad_debt = -remaining_margin;
        let insurance_balance = read_insurance_balance(env);
        let covered = insurance_balance.min(bad_debt);
        write_insurance_balance(env, insurance_balance - covered)?;
    }
    Ok(())
}

fn credit_insurance(env: &Env, cfg: &RiskConfig, amount: i128) -> Result<(), RiskError> {
    let balance = read_insurance_balance(env);
    let next = balance.checked_add(amount).ok_or(RiskError::MathOverflow)?;
    if next > cfg.insurance_cap {
        let overflow = next - cfg.insurance_cap;
        if overflow > 0 {
            vault_client(env)?.move_balance(
                &env.current_contract_address(),
                &cfg.insurance_fund,
                &cfg.treasury,
                &cfg.settlement_token,
                &overflow,
            );
        }
        write_insurance_balance(env, cfg.insurance_cap)?;
    } else {
        write_insurance_balance(env, next)?;
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

    perp.risk_close_position(
        &env.current_contract_address(),
        &position_id,
        &close_size.min(position.size),
        &oracle_price,
    );
    env.events().publish(
        (symbol_short!("adl"), position.owner, position_id),
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
}
