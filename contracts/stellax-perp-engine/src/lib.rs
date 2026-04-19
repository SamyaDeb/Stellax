//! StellaX perpetual futures engine.
//!
//! Phase 4 adds market configuration, a constant-product virtual AMM, and the
//! core position lifecycle for perpetual futures.

#![no_std]
#![allow(clippy::too_many_arguments)]

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, Address,
    Bytes, BytesN, Env, Symbol, Vec,
};
use stellax_math::{
    apply_bps, div_precision_checked, mul_precision_checked, sqrt_fixed, Market, Position,
    PriceData, BPS_DENOMINATOR, MAX_LEVERAGE, PRECISION, TTL_BUMP_INSTANCE, TTL_BUMP_PERSISTENT,
    TTL_THRESHOLD_INSTANCE, TTL_THRESHOLD_PERSISTENT,
};

const CONTRACT_VERSION: u32 = 1;

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
    InvalidVammState = 16,
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
    pub price_impact_factor: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VammState {
    pub base_reserve: i128,
    pub quote_reserve: i128,
    pub k: i128,
    pub cumulative_premium: i128,
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

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum DataKey {
    Config,
    NextPositionId,
    Market(u32),
    MarketParams(u32),
    Vamm(u32),
    OpenInterest(u32),
    Position(u64),
    UserPositions(Address),
    MarketPositions(u32),
    Version,
}

#[contractclient(name = "OracleClient")]
pub trait OracleInterface {
    fn get_price(env: Env, asset: Symbol) -> PriceData;
    fn verify_price_payload(env: Env, payload: Bytes, feed_id: Symbol) -> PriceData;
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
    fn get_total_collateral_value(env: Env, user: Address) -> i128;
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

    pub fn register_market(
        env: Env,
        market: Market,
        min_position_size: i128,
        price_impact_factor: i128,
        base_reserve: i128,
        quote_reserve: i128,
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

        validate_market(
            &market,
            min_position_size,
            price_impact_factor,
            base_reserve,
            quote_reserve,
        )?;
        let k =
            mul_precision_checked(base_reserve, quote_reserve).ok_or(PerpError::MathOverflow)?;

        env.storage()
            .instance()
            .set(&DataKey::Market(market.market_id), &market);
        env.storage().instance().set(
            &DataKey::MarketParams(market.market_id),
            &MarketParams {
                min_position_size,
                price_impact_factor,
            },
        );

        write_vamm(
            &env,
            market.market_id,
            &VammState {
                base_reserve,
                quote_reserve,
                k,
                cumulative_premium: 0,
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

    pub fn update_k(env: Env, market_id: u32, new_k: i128) -> Result<(), PerpError> {
        bump_instance_ttl(&env);
        let cfg = read_config(&env)?;
        cfg.admin.require_auth();

        if new_k <= 0 {
            return Err(PerpError::InvalidConfig);
        }

        let mut vamm = read_vamm(&env, market_id)?;
        let mark_price = mark_price(&vamm)?;
        let base_component =
            div_precision_checked(new_k, mark_price).ok_or(PerpError::MathOverflow)?;
        let new_base = sqrt_fixed(base_component);
        let new_quote = div_precision_checked(new_k, new_base).ok_or(PerpError::MathOverflow)?;
        if new_base <= 0 || new_quote <= 0 {
            return Err(PerpError::InvalidVammState);
        }

        vamm.base_reserve = new_base;
        vamm.quote_reserve = new_quote;
        vamm.k = new_k;
        write_vamm(&env, market_id, &vamm);
        env.events()
            .publish((symbol_short!("updk"), market_id), new_k);
        Ok(())
    }

    pub fn get_mark_price(env: Env, market_id: u32) -> Result<i128, PerpError> {
        bump_instance_ttl(&env);
        let vamm = read_vamm(&env, market_id)?;
        mark_price(&vamm)
    }

    pub fn get_market(env: Env, market_id: u32) -> Result<Market, PerpError> {
        bump_instance_ttl(&env);
        read_market(&env, market_id)
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

        let vamm = read_vamm(&env, market_id)?;
        let preview = preview_trade(&vamm, &params, size, is_long)?;
        ensure_slippage(
            preview.execution_price,
            oracle_price.price,
            max_slippage_bps,
        )?;

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

        let notional = notional_value(size, preview.execution_price)?;
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
            vault.move_balance(&caller, &user, &cfg.treasury, &cfg.settlement_token, &fee);
        }

        // Aggregate existing-position state locally so the risk engine does
        // not have to re-enter this contract. For each of the user's
        // already-open positions we compute its initial margin requirement
        // (at current oracle price) and its unrealized PnL (trade + funding),
        // then pass the totals plus the user's current total collateral to
        // the risk engine's re-entry-safe validation entry point.
        let (existing_initial_margin, existing_unrealized_pnl) =
            aggregate_existing_positions(&env, &user)?;
        let total_collateral = vault.get_total_collateral_value(&user);

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
            entry_price: preview.execution_price,
            margin,
            leverage,
            is_long,
            last_funding_idx: funding_idx,
            open_timestamp: env.ledger().timestamp(),
        };

        let mut next_vamm = preview.next_state;
        next_vamm.cumulative_premium = next_vamm
            .cumulative_premium
            .checked_add(
                mark_price(&next_vamm)?
                    .checked_sub(oracle_price.price)
                    .ok_or(PerpError::MathOverflow)?,
            )
            .ok_or(PerpError::MathOverflow)?;
        write_vamm(&env, market_id, &next_vamm);
        write_open_interest(&env, market_id, &oi);
        write_position(&env, position_id, &position);
        add_user_position(&env, &user, position_id);
        add_market_position(&env, market_id, position_id);
        write_next_position_id(
            &env,
            position_id.checked_add(1).ok_or(PerpError::MathOverflow)?,
        )?;

        env.events().publish(
            (symbol_short!("posopen"), user, position_id, market_id),
            (size, preview.execution_price, leverage, is_long),
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
        user.require_auth();

        let position = read_position(&env, position_id)?;
        if position.owner != user {
            return Err(PerpError::NotPositionOwner);
        }

        let market = read_active_market(&env, position.market_id)?;
        let params = read_market_params(&env, position.market_id)?;
        let oracle_price = read_price(&env, &market.base_asset, price_payload)?;
        let vamm = read_vamm(&env, position.market_id)?;
        let preview = preview_trade(&vamm, &params, position.size, !position.is_long)?;
        let funding_idx = current_funding_index(&env, position.market_id, position.is_long)?;
        let funding_pnl = funding_pnl(&position, funding_idx)?;
        let trade_pnl = trade_pnl(
            position.is_long,
            position.size,
            position.entry_price,
            preview.execution_price,
        )?;
        let close_notional = notional_value(position.size, preview.execution_price)?;
        let close_fee = apply_bps(close_notional, market.maker_fee_bps);
        let total_pnl = trade_pnl
            .checked_add(funding_pnl)
            .and_then(|value| value.checked_sub(close_fee))
            .ok_or(PerpError::MathOverflow)?;

        settle_position_close(&env, &user, position_id, position.margin, total_pnl)?;

        let mut next_vamm = preview.next_state;
        next_vamm.cumulative_premium = next_vamm
            .cumulative_premium
            .checked_add(
                mark_price(&next_vamm)?
                    .checked_sub(oracle_price.price)
                    .ok_or(PerpError::MathOverflow)?,
            )
            .ok_or(PerpError::MathOverflow)?;
        write_vamm(&env, position.market_id, &next_vamm);

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
            (preview.execution_price, total_pnl),
        );
        Ok(())
    }

    pub fn modify_position(
        env: Env,
        user: Address,
        position_id: u64,
        action: ModifyAction,
    ) -> Result<(), PerpError> {
        bump_instance_ttl(&env);
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
                let params = read_market_params(&env, position.market_id)?;
                let oracle_price = read_price(&env, &market.base_asset, None)?;
                let vamm = read_vamm(&env, position.market_id)?;
                let preview = preview_trade(&vamm, &params, close_size, !position.is_long)?;
                let funding_idx =
                    current_funding_index(&env, position.market_id, position.is_long)?;
                let funding_component = funding_pnl_for_size(&position, funding_idx, close_size)?;
                let trading_component = trade_pnl(
                    position.is_long,
                    close_size,
                    position.entry_price,
                    preview.execution_price,
                )?;
                let close_notional = notional_value(close_size, preview.execution_price)?;
                let close_fee = apply_bps(close_notional, market.maker_fee_bps);
                let total_pnl = trading_component
                    .checked_add(funding_component)
                    .and_then(|value| value.checked_sub(close_fee))
                    .ok_or(PerpError::MathOverflow)?;
                let released_margin = position
                    .margin
                    .checked_mul(close_size)
                    .and_then(|value| value.checked_div(position.size))
                    .ok_or(PerpError::MathOverflow)?;
                settle_position_close(&env, &user, position_id, released_margin, total_pnl)?;

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

                let mut next_vamm = preview.next_state;
                next_vamm.cumulative_premium = next_vamm
                    .cumulative_premium
                    .checked_add(
                        mark_price(&next_vamm)?
                            .checked_sub(oracle_price.price)
                            .ok_or(PerpError::MathOverflow)?,
                    )
                    .ok_or(PerpError::MathOverflow)?;
                write_vamm(&env, position.market_id, &next_vamm);

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

        let params = read_market_params(&env, position.market_id)?;
        let vamm = read_vamm(&env, position.market_id)?;
        let preview = preview_trade(&vamm, &params, close_size, !position.is_long)?;
        let funding_idx = current_funding_index(&env, position.market_id, position.is_long)?;
        let funding_component = funding_pnl_for_size(&position, funding_idx, close_size)?;
        let trade_component = trade_pnl(
            position.is_long,
            close_size,
            position.entry_price,
            execution_price,
        )?;
        let released_margin = position
            .margin
            .checked_mul(close_size)
            .and_then(|value| value.checked_div(position.size))
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

        let mut next_vamm = preview.next_state;
        next_vamm.cumulative_premium = next_vamm
            .cumulative_premium
            .checked_add(
                mark_price(&next_vamm)?
                    .checked_sub(execution_price)
                    .ok_or(PerpError::MathOverflow)?,
            )
            .ok_or(PerpError::MathOverflow)?;
        write_vamm(&env, position.market_id, &next_vamm);

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
        let mark_price = mark_price(&read_vamm(&env, market_id)?)?;
        let cfg = read_config(&env)?;
        let funding = FundingClient::new(&env, &cfg.funding);

        Ok(MarketInfo {
            market,
            params,
            oi_long: oi.oi_long,
            oi_short: oi.oi_short,
            mark_price,
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
    /// Used by governance when deploying new oracle/vault/funding/risk modules
    /// or rotating the treasury / settlement token.
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
}

struct TradePreview {
    next_state: VammState,
    execution_price: i128,
}

fn validate_market(
    market: &Market,
    min_position_size: i128,
    price_impact_factor: i128,
    base_reserve: i128,
    quote_reserve: i128,
) -> Result<(), PerpError> {
    if market.max_leverage == 0
        || market.max_leverage > MAX_LEVERAGE
        || market.maker_fee_bps > BPS_DENOMINATOR
        || market.taker_fee_bps > BPS_DENOMINATOR
        || market.max_oi_long <= 0
        || market.max_oi_short <= 0
        || min_position_size <= 0
        || price_impact_factor <= 0
        || base_reserve <= 0
        || quote_reserve <= 0
    {
        return Err(PerpError::InvalidConfig);
    }
    Ok(())
}

fn bump_instance_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_INSTANCE, TTL_BUMP_INSTANCE);
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

fn write_vamm(env: &Env, market_id: u32, vamm: &VammState) {
    let key = DataKey::Vamm(market_id);
    env.storage().persistent().set(&key, vamm);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_PERSISTENT, TTL_BUMP_PERSISTENT);
}

fn read_vamm(env: &Env, market_id: u32) -> Result<VammState, PerpError> {
    let key = DataKey::Vamm(market_id);
    let value = env
        .storage()
        .persistent()
        .get::<_, VammState>(&key)
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

fn add_user_position(env: &Env, user: &Address, position_id: u64) {
    let mut ids = read_user_positions(env, user);
    ids.push_back(position_id);
    write_user_positions(env, user, &ids);
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

fn read_price(
    env: &Env,
    asset: &Symbol,
    price_payload: Option<Bytes>,
) -> Result<PriceData, PerpError> {
    let cfg = read_config(env)?;
    let oracle = OracleClient::new(env, &cfg.oracle);
    Ok(match price_payload {
        Some(payload) => oracle.verify_price_payload(&payload, asset),
        None => oracle.get_price(asset),
    })
}

fn mark_price(vamm: &VammState) -> Result<i128, PerpError> {
    div_precision_checked(vamm.quote_reserve, vamm.base_reserve).ok_or(PerpError::MathOverflow)
}

fn notional_value(size: i128, price: i128) -> Result<i128, PerpError> {
    mul_precision_checked(size, price).ok_or(PerpError::MathOverflow)
}

/// Sum the user's already-open positions into (initial_margin_total,
/// unrealized_pnl_total) using current oracle prices. Used by `open_position`
/// to supply the risk engine with the inputs it would otherwise have to
/// fetch via a re-entrant call back into this contract.
fn aggregate_existing_positions(env: &Env, user: &Address) -> Result<(i128, i128), PerpError> {
    let ids = read_user_positions(env, user);
    let mut total_initial: i128 = 0;
    let mut total_pnl: i128 = 0;
    for position_id in ids.iter() {
        let position = read_position(env, position_id)?;
        let market = read_market(env, position.market_id)?;
        let oracle_price = read_price(env, &market.base_asset, None)?.price;
        let notional = notional_value(position.size, oracle_price)?;
        let initial = notional
            .checked_div(market.max_leverage as i128)
            .ok_or(PerpError::MathOverflow)?;
        let funding_idx = current_funding_index(env, position.market_id, position.is_long)?;
        let funding_component = funding_pnl(&position, funding_idx)?;
        let trading_component = trade_pnl(
            position.is_long,
            position.size,
            position.entry_price,
            oracle_price,
        )?;
        let pnl = trading_component
            .checked_add(funding_component)
            .ok_or(PerpError::MathOverflow)?;
        total_initial = total_initial
            .checked_add(initial)
            .ok_or(PerpError::MathOverflow)?;
        total_pnl = total_pnl.checked_add(pnl).ok_or(PerpError::MathOverflow)?;
    }
    Ok((total_initial, total_pnl))
}

fn preview_trade(
    vamm: &VammState,
    params: &MarketParams,
    size: i128,
    is_long: bool,
) -> Result<TradePreview, PerpError> {
    let impact_delta =
        mul_precision_checked(size, params.price_impact_factor).ok_or(PerpError::MathOverflow)?;
    if impact_delta <= 0 {
        return Err(PerpError::InvalidSize);
    }

    if is_long {
        if impact_delta >= vamm.base_reserve {
            return Err(PerpError::InvalidVammState);
        }
        let new_base = vamm
            .base_reserve
            .checked_sub(impact_delta)
            .ok_or(PerpError::MathOverflow)?;
        let new_quote = div_precision_checked(vamm.k, new_base).ok_or(PerpError::MathOverflow)?;
        let quote_delta = new_quote
            .checked_sub(vamm.quote_reserve)
            .ok_or(PerpError::MathOverflow)?;
        let execution_price =
            div_precision_checked(quote_delta, size).ok_or(PerpError::MathOverflow)?;

        Ok(TradePreview {
            next_state: VammState {
                base_reserve: new_base,
                quote_reserve: new_quote,
                k: vamm.k,
                cumulative_premium: vamm.cumulative_premium,
            },
            execution_price,
        })
    } else {
        let new_base = vamm
            .base_reserve
            .checked_add(impact_delta)
            .ok_or(PerpError::MathOverflow)?;
        let new_quote = div_precision_checked(vamm.k, new_base).ok_or(PerpError::MathOverflow)?;
        let quote_delta = vamm
            .quote_reserve
            .checked_sub(new_quote)
            .ok_or(PerpError::MathOverflow)?;
        let execution_price =
            div_precision_checked(quote_delta, size).ok_or(PerpError::MathOverflow)?;

        Ok(TradePreview {
            next_state: VammState {
                base_reserve: new_base,
                quote_reserve: new_quote,
                k: vamm.k,
                cumulative_premium: vamm.cumulative_premium,
            },
            execution_price,
        })
    }
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
    // NOTE: we intentionally do NOT call `funding.update_funding(market_id)`
    // here. Doing so would cause the funding contract to re-enter this perp
    // engine (it reads the market and mark price from us), which Soroban
    // forbids while a perp frame is already on the host stack.
    //
    // The accumulated funding index advances whenever an external keeper
    // calls `funding.update_funding` or `funding.settle_funding`. For the
    // perp engine's own read-path (position opens / closes / PnL queries)
    // we simply use whatever index is currently stored, which is the
    // correct behaviour: funding only settles against the index at the
    // moment of the mutation, and external callers are expected to poke
    // the funding contract on their own cadence.
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
    total_pnl: i128,
) -> Result<(), PerpError> {
    let cfg = read_config(env)?;
    let caller = env.current_contract_address();
    let vault = VaultClient::new(env, &cfg.vault);

    vault.unlock_margin(&caller, user, &position_id, &released_margin);
    match total_pnl.cmp(&0) {
        core::cmp::Ordering::Greater => {
            vault.move_balance(
                &caller,
                &cfg.treasury,
                user,
                &cfg.settlement_token,
                &total_pnl,
            );
        }
        core::cmp::Ordering::Less => {
            let capped_loss = (-total_pnl).min(released_margin);
            if capped_loss > 0 {
                vault.move_balance(
                    &caller,
                    user,
                    &cfg.treasury,
                    &cfg.settlement_token,
                    &capped_loss,
                );
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

#[cfg(test)]
mod tests {
    use soroban_sdk::{contract, contractimpl, contracttype, testutils::Address as _, Address};

    use super::*;

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
            // Perp inline tests bypass real collateral accounting; any
            // sufficiently-large value works for the risk validator shim.
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

    struct Setup {
        env: Env,
        settlement_token: Address,
        user_one: Address,
        user_two: Address,
        engine: StellaxPerpEngineClient<'static>,
        vault: MockVaultClient<'static>,
        oracle: MockOracleClient<'static>,
        funding: MockFundingClient<'static>,
    }

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
        let engine = StellaxPerpEngineClient::new(&env, &engine_id);

        oracle.set_price(&Symbol::new(&env, "BTC"), &100_000_000_000_000_000_000i128);
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
            &10_000_000_000_000_000_000i128,
            &PRECISION,
            &1_000_000_000_000_000_000_000i128,
            &100_000_000_000_000_000_000_000i128,
        );

        Setup {
            env,
            settlement_token,
            user_one,
            user_two,
            engine,
            vault,
            oracle,
            funding,
        }
    }

    #[test]
    fn open_and_close_long_updates_balances_and_unlocks_margin() {
        let s = setup();
        let position_id = s.engine.open_position(
            &s.user_one,
            &1u32,
            &1_000_000_000_000_000_000i128,
            &true,
            &10u32,
            &100u32,
            &None,
        );
        let locked_before = s.vault.get_locked_margin(&s.user_one, &position_id);
        assert!(locked_before > 0);

        s.engine.open_position(
            &s.user_two,
            &1u32,
            &2_000_000_000_000_000_000i128,
            &true,
            &10u32,
            &300u32,
            &None,
        );
        let user_balance_before_close = s.vault.get_balance(&s.user_one, &s.settlement_token);
        s.engine.close_position(&s.user_one, &position_id, &None);
        let user_balance_after_close = s.vault.get_balance(&s.user_one, &s.settlement_token);

        assert_eq!(s.vault.get_locked_margin(&s.user_one, &position_id), 0);
        assert!(user_balance_after_close > user_balance_before_close);
    }

    #[test]
    fn large_long_moves_mark_price_up() {
        let s = setup();
        let before = s.engine.get_mark_price(&1u32);
        s.engine.open_position(
            &s.user_one,
            &1u32,
            &5_000_000_000_000_000_000i128,
            &true,
            &5u32,
            &1_000u32,
            &None,
        );
        let after = s.engine.get_mark_price(&1u32);
        assert!(after > before);
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
            &PRECISION,
            &1_000_000_000_000_000_000_000i128,
            &2_000_000_000_000_000_000_000i128,
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
        let s = setup();
        assert_eq!(
            s.engine.try_open_position(
                &s.user_one,
                &1u32,
                &200_000_000_000_000_000_000i128,
                &true,
                &5u32,
                &5u32,
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
            &200u32,
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
        assert!(info.mark_price > 0);
    }
}
