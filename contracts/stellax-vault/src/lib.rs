//! StellaX collateral vault.
//!
//! Phase 3 implements the protocol's custody and accounting layer for margin
//! collateral. Users deposit supported assets into this contract, which stores
//! balances in 18-decimal internal precision and exposes lock/unlock primitives
//! to the perp/options engines.

#![no_std]
#![allow(deprecated)]
#![allow(clippy::too_many_arguments)]

use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, token,
    Address, BytesN, Env, IntoVal, Symbol, Vec,
};
use stellax_math::{
    apply_haircut, to_precision, to_precision_checked, MarginMode, PriceData, BPS_DENOMINATOR,
    TTL_BUMP_PERSISTENT, TTL_THRESHOLD_PERSISTENT,
};

const CONTRACT_VERSION: u32 = 1;

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum VaultError {
    AlreadyInitialized = 1,
    Unauthorized = 2,
    InvalidConfig = 3,
    TokenNotSupported = 4,
    TokenInactive = 5,
    DepositCapExceeded = 6,
    InvalidAmount = 7,
    InsufficientBalance = 8,
    InsufficientFreeCollateral = 9,
    MarginLockExceeded = 10,
    UnknownPosition = 11,
    MathOverflow = 12,
    /// Phase S — sub-account requested for withdraw/transfer is empty or unknown.
    SubAccountNotFound = 13,
    /// Phase SLP — requested sub-account role has not been configured by admin.
    SubAccountRoleNotSet = 14,
}

/// Phase SLP — Standard sub-account roles used by the protocol waterfall.
///
/// Sub-account addresses are stored under `DataKey::SubAccountAddress(role)`
/// for forward-compatibility (the legacy `VaultConfig.treasury` and
/// `VaultConfig.insurance_fund` fields remain authoritative until governance
/// migrates them via `set_sub_account`).  New roles (`SlpPool`, `FundingPool`)
/// are addressed only through this map.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SubAccountRole {
    Treasury = 0,
    Insurance = 1,
    SlpPool = 2,
    FundingPool = 3,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultConfig {
    pub admin: Address,
    pub oracle: Address,
    pub risk: Address,
    pub treasury: Address,
    pub insurance_fund: Address,
    pub authorized_callers: Vec<Address>,
    pub supported_tokens: Vec<Address>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CollateralConfig {
    pub token_address: Address,
    pub asset_symbol: Symbol,
    pub decimals: u32,
    pub haircut_bps: u32,
    pub max_deposit_cap: i128,
    pub is_active: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum DataKey {
    Config,
    Token(Address),
    Balance(Address, Address),
    MarginMode(Address),
    LockedMargin(Address, u64),
    LockedMarginTotal(Address),
    /// Phase N — isolated-margin bucket per (user, position_id).
    /// Stored as 18-decimal USD-equivalent value, mirroring `LockedMargin`,
    /// but kept on a separate ledger that liquidations can drain
    /// independently from the cross-margin pool.
    IsolatedMargin(Address, u64),
    /// Phase N — cumulative isolated margin per user, used to size free
    /// collateral the same way `LockedMarginTotal` does for cross.
    IsolatedMarginTotal(Address),
    /// Phase S — earmarked sub-account balance per (user, sub_id, token),
    /// stored in 18-decimal internal precision. Sub-account funds live in
    /// a separate accounting silo from the master vault balance and do _not_
    /// count toward `compute_total_collateral_value`. They cannot be used as
    /// margin for cross/isolated positions until promoted back to master via
    /// `withdraw_sub` (which transfers tokens out) or by the user depositing
    /// independently. sub_id = 0 is reserved for the master account.
    SubBalance(Address, u32, Address),
    /// Phase SLP — registry of protocol-owned sub-account addresses keyed by
    /// role (Treasury, Insurance, SlpPool, FundingPool).  Additive over
    /// `VaultConfig.{treasury,insurance_fund}`; readers fall back to the
    /// legacy `VaultConfig` fields when a role is unset so existing flows
    /// keep working until governance migrates.
    SubAccountAddress(SubAccountRole),
    Version,
}

#[contractclient(name = "OracleClient")]
pub trait OracleInterface {
    fn get_price(env: Env, asset: Symbol) -> PriceData;
}

#[contractclient(name = "RiskClient")]
pub trait RiskInterface {
    /// Variant of the risk engine's `get_margin_requirement` that accepts
    /// the user's total collateral value as an argument, so the vault can
    /// query margin requirements during its own execution without causing
    /// a Soroban contract re-entry.
    fn margin_req_with_collateral(env: Env, user: Address, total_collateral: i128) -> i128;
    /// Lightweight variant: sums stored `position.margin` values with no
    /// oracle calls.  Used by `withdraw` to avoid the compute-budget overflow
    /// caused by N+2 oracle WASM loads per withdrawal.
    fn get_total_initial_margin_stored(env: Env, user: Address) -> i128;
    /// Phase SLP — stored-margin equity estimate: (balance - locked_margin,
    /// locked_margin).  No oracle calls.  Used by `withdraw` as an MTM guard
    /// call-site that can be upgraded in place on the risk side (Phase 2).
    fn get_account_equity(env: Env, user: Address) -> (i128, i128);
}

#[contract]
pub struct StellaxVault;

#[contractimpl]
impl StellaxVault {
    pub fn __constructor(
        env: Env,
        admin: Address,
        oracle: Address,
        risk: Address,
        treasury: Address,
        insurance_fund: Address,
        authorized_callers: Vec<Address>,
        collateral_configs: Vec<CollateralConfig>,
    ) -> Result<(), VaultError> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(VaultError::AlreadyInitialized);
        }

        if collateral_configs.is_empty() {
            return Err(VaultError::InvalidConfig);
        }

        let mut supported_tokens = Vec::new(&env);
        for cfg in collateral_configs.iter() {
            validate_collateral_config(&cfg)?;
            env.storage()
                .persistent()
                .set(&DataKey::Token(cfg.token_address.clone()), &cfg);
            env.storage().persistent().extend_ttl(
                &DataKey::Token(cfg.token_address.clone()),
                TTL_THRESHOLD_PERSISTENT,
                TTL_BUMP_PERSISTENT,
            );
            supported_tokens.push_back(cfg.token_address);
        }

        let config = VaultConfig {
            admin,
            oracle,
            risk,
            treasury,
            insurance_fund,
            authorized_callers,
            supported_tokens,
        };

        env.storage().instance().set(&DataKey::Config, &config);
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

    pub fn deposit(
        env: Env,
        user: Address,
        token_address: Address,
        amount: i128,
    ) -> Result<(), VaultError> {
        bump_instance_ttl(&env);
        user.require_auth();

        if amount <= 0 {
            return Err(VaultError::InvalidAmount);
        }

        let collateral = read_active_collateral(&env, &token_address)?;
        let amount_internal = to_precision_checked(amount, collateral.decimals, 18)
            .ok_or(VaultError::MathOverflow)?;

        let total_after = current_token_total(&env, &token_address)?
            .checked_add(amount_internal)
            .ok_or(VaultError::MathOverflow)?;
        if total_after > collateral.max_deposit_cap {
            return Err(VaultError::DepositCapExceeded);
        }

        let token_client = token::TokenClient::new(&env, &token_address);
        token_client.transfer(&user, env.current_contract_address(), &amount);

        update_balance(&env, &user, &token_address, amount_internal)?;
        env.events().publish(
            (symbol_short!("deposit"), user, token_address),
            amount_internal,
        );
        Ok(())
    }

    pub fn withdraw(
        env: Env,
        user: Address,
        token_address: Address,
        amount: i128,
    ) -> Result<(), VaultError> {
        bump_instance_ttl(&env);
        user.require_auth();

        if amount <= 0 {
            return Err(VaultError::InvalidAmount);
        }

        let collateral = read_active_collateral(&env, &token_address)?;
        let amount_internal = to_precision_checked(amount, collateral.decimals, 18)
            .ok_or(VaultError::MathOverflow)?;

        let balance = read_balance(&env, &user, &token_address);
        if balance < amount_internal {
            return Err(VaultError::InsufficientBalance);
        }

        // Phase SLP — MTM-aware solvency guard: remaining balance (18dp) must
        // be ≥ the user's stored locked margin after the withdrawal.
        //
        // We call `risk.get_account_equity` which returns
        // `(equity, locked_margin)` using stored position margins only (no
        // oracle calls — same budget constraint as before).  The check is:
        //
        //   balance - amount_internal >= locked_margin
        //
        // which is equivalent to `equity_after >= 0`.  Using the risk
        // call-site here means Phase 2 can tighten the guard to include
        // unrealized losses simply by upgrading the risk contract — no vault
        // upgrade needed.
        let risk = RiskClient::new(&env, &read_config(&env)?.risk);
        let (_equity, locked_margin) = risk.get_account_equity(&user);
        let remaining = balance
            .checked_sub(amount_internal)
            .ok_or(VaultError::MathOverflow)?;
        if remaining < locked_margin {
            return Err(VaultError::InsufficientFreeCollateral);
        }

        let native_amount = to_precision_checked(amount_internal, 18, collateral.decimals)
            .ok_or(VaultError::MathOverflow)?;

        authorize_token_transfer_from_current_contract(&env, &token_address, &user, native_amount);
        let token_client = token::TokenClient::new(&env, &token_address);
        token_client.transfer(&env.current_contract_address(), &user, &native_amount);

        update_balance(&env, &user, &token_address, -amount_internal)?;
        env.events().publish(
            (symbol_short!("withdraw"), user, token_address),
            amount_internal,
        );
        Ok(())
    }

    pub fn get_balance(
        env: Env,
        user: Address,
        token_address: Address,
    ) -> Result<i128, VaultError> {
        bump_instance_ttl(&env);
        let _ = read_collateral(&env, &token_address)?;
        Ok(read_balance(&env, &user, &token_address))
    }

    pub fn get_total_collateral_value(env: Env, user: Address) -> Result<i128, VaultError> {
        bump_instance_ttl(&env);
        compute_total_collateral_value(&env, &user)
    }

    pub fn get_free_collateral_value(env: Env, user: Address) -> Result<i128, VaultError> {
        bump_instance_ttl(&env);
        let total = compute_total_collateral_value(&env, &user)?;
        let margin_requirement = risk_margin_requirement(&env, &user, total)?;
        Ok(total.saturating_sub(margin_requirement))
    }

    pub fn set_margin_mode(
        env: Env,
        user: Address,
        margin_mode: MarginMode,
    ) -> Result<(), VaultError> {
        bump_instance_ttl(&env);
        user.require_auth();

        let key = DataKey::MarginMode(user);
        env.storage().persistent().set(&key, &margin_mode);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD_PERSISTENT, TTL_BUMP_PERSISTENT);
        Ok(())
    }

    pub fn get_margin_mode(env: Env, user: Address) -> Result<MarginMode, VaultError> {
        bump_instance_ttl(&env);
        Ok(read_margin_mode(&env, &user))
    }

    pub fn lock_margin(
        env: Env,
        caller: Address,
        user: Address,
        position_id: u64,
        amount: i128,
    ) -> Result<(), VaultError> {
        bump_instance_ttl(&env);
        require_authorized_caller(&env, &caller)?;
        caller.require_auth();

        if amount <= 0 {
            return Err(VaultError::InvalidAmount);
        }

        // The authorized caller (perp engine) has already validated the
        // user's margin requirement against the risk engine before making
        // this call. We therefore only enforce a local "cannot lock more
        // than on-deposit collateral" check here, avoiding a re-entrant
        // call from vault -> risk -> perp -> vault.
        let total_collateral = compute_total_collateral_value(&env, &user)?;
        let already_locked = locked_margin_total(&env, &user);
        let already_isolated = isolated_margin_total(&env, &user);
        let free = total_collateral
            .checked_sub(already_locked)
            .and_then(|v| v.checked_sub(already_isolated))
            .ok_or(VaultError::MarginLockExceeded)?;
        if amount > free {
            return Err(VaultError::MarginLockExceeded);
        }

        let key = DataKey::LockedMargin(user.clone(), position_id);
        let updated = env
            .storage()
            .persistent()
            .update(&key, |current: Option<i128>| {
                current.unwrap_or(0).checked_add(amount).unwrap()
            });
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD_PERSISTENT, TTL_BUMP_PERSISTENT);

        let total_key = DataKey::LockedMarginTotal(user.clone());
        env.storage().persistent().set(
            &total_key,
            &locked_margin_total(&env, &user)
                .checked_add(amount)
                .unwrap(),
        );
        env.storage().persistent().extend_ttl(
            &total_key,
            TTL_THRESHOLD_PERSISTENT,
            TTL_BUMP_PERSISTENT,
        );

        env.events().publish(
            (symbol_short!("lock_mgn"), caller, user, position_id),
            updated,
        );
        Ok(())
    }

    pub fn unlock_margin(
        env: Env,
        caller: Address,
        user: Address,
        position_id: u64,
        amount: i128,
    ) -> Result<(), VaultError> {
        bump_instance_ttl(&env);
        require_authorized_caller(&env, &caller)?;
        caller.require_auth();

        if amount <= 0 {
            return Err(VaultError::InvalidAmount);
        }

        let key = DataKey::LockedMargin(user.clone(), position_id);
        let current = env
            .storage()
            .persistent()
            .get::<_, i128>(&key)
            .ok_or(VaultError::UnknownPosition)?;
        if amount > current {
            return Err(VaultError::InvalidAmount);
        }

        let remaining = current - amount;
        if remaining == 0 {
            env.storage().persistent().remove(&key);
        } else {
            env.storage().persistent().set(&key, &remaining);
            env.storage().persistent().extend_ttl(
                &key,
                TTL_THRESHOLD_PERSISTENT,
                TTL_BUMP_PERSISTENT,
            );
        }

        let total_key = DataKey::LockedMarginTotal(user.clone());
        let total = locked_margin_total(&env, &user);
        env.storage()
            .persistent()
            .set(&total_key, &(total - amount));
        env.storage().persistent().extend_ttl(
            &total_key,
            TTL_THRESHOLD_PERSISTENT,
            TTL_BUMP_PERSISTENT,
        );

        env.events().publish(
            (symbol_short!("unlockmg"), caller, user, position_id),
            remaining,
        );
        Ok(())
    }

    // ─── Phase N — Isolated margin ────────────────────────────────────────
    //
    // Isolated margin segregates a position's collateral so that liquidation
    // cannot reach the user's cross-margin pool. The on-chain accounting
    // mirrors `lock_margin` / `unlock_margin` but lives on a parallel ledger
    // (`IsolatedMargin` / `IsolatedMarginTotal`). The free-collateral
    // calculation subtracts the isolated total alongside the cross-locked
    // total, so isolated USD value never counts toward new cross positions.

    /// Lock `amount` (18-dec USD) of the user's free collateral into the
    /// isolated bucket for `position_id`. Authorized-caller only (perp
    /// engine / options engine). The amount is _not_ moved between token
    /// balances — it is bookkeeping-only, like `lock_margin` — but it is
    /// added to the user's `IsolatedMarginTotal` so it stops counting as
    /// available cross collateral.
    pub fn lock_isolated(
        env: Env,
        caller: Address,
        user: Address,
        position_id: u64,
        amount: i128,
    ) -> Result<(), VaultError> {
        bump_instance_ttl(&env);
        require_authorized_caller(&env, &caller)?;
        caller.require_auth();

        if amount <= 0 {
            return Err(VaultError::InvalidAmount);
        }

        // Same free-collateral discipline as `lock_margin`: cannot lock more
        // than what is currently un-spoken-for.
        let total_collateral = compute_total_collateral_value(&env, &user)?;
        let cross_locked = locked_margin_total(&env, &user);
        let isolated_locked = isolated_margin_total(&env, &user);
        let already = cross_locked
            .checked_add(isolated_locked)
            .ok_or(VaultError::MathOverflow)?;
        let free = total_collateral
            .checked_sub(already)
            .ok_or(VaultError::MarginLockExceeded)?;
        if amount > free {
            return Err(VaultError::MarginLockExceeded);
        }

        let key = DataKey::IsolatedMargin(user.clone(), position_id);
        let updated = env
            .storage()
            .persistent()
            .update(&key, |current: Option<i128>| {
                current.unwrap_or(0).checked_add(amount).unwrap()
            });
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD_PERSISTENT, TTL_BUMP_PERSISTENT);

        let total_key = DataKey::IsolatedMarginTotal(user.clone());
        env.storage()
            .persistent()
            .set(&total_key, &isolated_locked.checked_add(amount).unwrap());
        env.storage().persistent().extend_ttl(
            &total_key,
            TTL_THRESHOLD_PERSISTENT,
            TTL_BUMP_PERSISTENT,
        );

        env.events().publish(
            (symbol_short!("isolock"), caller, user, position_id),
            updated,
        );
        Ok(())
    }

    /// Release `amount` from the isolated bucket back to free collateral
    /// (e.g. when the position closes profitably or shrinks).
    pub fn unlock_isolated(
        env: Env,
        caller: Address,
        user: Address,
        position_id: u64,
        amount: i128,
    ) -> Result<(), VaultError> {
        bump_instance_ttl(&env);
        require_authorized_caller(&env, &caller)?;
        caller.require_auth();

        if amount <= 0 {
            return Err(VaultError::InvalidAmount);
        }

        let key = DataKey::IsolatedMargin(user.clone(), position_id);
        let current = env
            .storage()
            .persistent()
            .get::<_, i128>(&key)
            .ok_or(VaultError::UnknownPosition)?;
        if amount > current {
            return Err(VaultError::InvalidAmount);
        }

        let remaining = current - amount;
        if remaining == 0 {
            env.storage().persistent().remove(&key);
        } else {
            env.storage().persistent().set(&key, &remaining);
            env.storage().persistent().extend_ttl(
                &key,
                TTL_THRESHOLD_PERSISTENT,
                TTL_BUMP_PERSISTENT,
            );
        }

        let total_key = DataKey::IsolatedMarginTotal(user.clone());
        let total = isolated_margin_total(&env, &user);
        env.storage()
            .persistent()
            .set(&total_key, &(total - amount));
        env.storage().persistent().extend_ttl(
            &total_key,
            TTL_THRESHOLD_PERSISTENT,
            TTL_BUMP_PERSISTENT,
        );

        env.events().publish(
            (symbol_short!("isounlk"), caller, user, position_id),
            remaining,
        );
        Ok(())
    }

    /// Apply realized PnL to an isolated position. Positive `pnl` means
    /// the position closed profitably — the isolated bucket is fully
    /// released and the profit is _not_ written back here (the perp engine
    /// already pays profit out via `move_balance`); negative `pnl` consumes
    /// the bucket up to the loss amount, with any residual reported as the
    /// shortfall the caller (risk engine) must socialize via insurance/ADL.
    ///
    /// Returns the shortfall (positive value) if the loss exceeded the
    /// isolated bucket, or `0` if fully covered.
    pub fn realize_isolated_pnl(
        env: Env,
        caller: Address,
        user: Address,
        position_id: u64,
        pnl: i128,
    ) -> Result<i128, VaultError> {
        bump_instance_ttl(&env);
        require_authorized_caller(&env, &caller)?;
        caller.require_auth();

        let key = DataKey::IsolatedMargin(user.clone(), position_id);
        let current = env
            .storage()
            .persistent()
            .get::<_, i128>(&key)
            .ok_or(VaultError::UnknownPosition)?;
        let total_key = DataKey::IsolatedMarginTotal(user.clone());
        let total = isolated_margin_total(&env, &user);

        let (shortfall, consumed) = if pnl >= 0 {
            // Profit (or break-even): release the full isolated bucket.
            (0i128, current)
        } else {
            let loss = -pnl;
            if loss <= current {
                (0i128, loss)
            } else {
                (loss - current, current)
            }
        };

        // Drain the bucket by `consumed`.
        let remaining = current - consumed;
        if remaining == 0 {
            env.storage().persistent().remove(&key);
        } else {
            env.storage().persistent().set(&key, &remaining);
            env.storage().persistent().extend_ttl(
                &key,
                TTL_THRESHOLD_PERSISTENT,
                TTL_BUMP_PERSISTENT,
            );
        }
        env.storage()
            .persistent()
            .set(&total_key, &(total - consumed));
        env.storage().persistent().extend_ttl(
            &total_key,
            TTL_THRESHOLD_PERSISTENT,
            TTL_BUMP_PERSISTENT,
        );

        env.events().publish(
            (symbol_short!("isornlz"), caller, user, position_id),
            (pnl, shortfall),
        );
        Ok(shortfall)
    }

    /// Read-only view of a specific isolated bucket.
    pub fn get_isolated_margin(
        env: Env,
        user: Address,
        position_id: u64,
    ) -> Result<i128, VaultError> {
        bump_instance_ttl(&env);
        Ok(env
            .storage()
            .persistent()
            .get(&DataKey::IsolatedMargin(user, position_id))
            .unwrap_or(0i128))
    }

    /// Read-only view of the user's cumulative isolated margin total.
    pub fn get_isolated_margin_total(env: Env, user: Address) -> Result<i128, VaultError> {
        bump_instance_ttl(&env);
        Ok(isolated_margin_total(&env, &user))
    }

    pub fn transfer_margin(
        env: Env,
        caller: Address,
        from: Address,
        to_insurance: bool,
        amount: i128,
    ) -> Result<(), VaultError> {
        bump_instance_ttl(&env);
        require_authorized_caller(&env, &caller)?;
        caller.require_auth();

        if amount <= 0 {
            return Err(VaultError::InvalidAmount);
        }

        let locked_total = locked_margin_total(&env, &from);
        if amount > locked_total {
            return Err(VaultError::MarginLockExceeded);
        }

        let config = read_config(&env)?;
        let recipient = if to_insurance {
            config.insurance_fund
        } else {
            config.treasury
        };

        let asset_count = config.supported_tokens.len();
        for index in 0..asset_count {
            let token = config.supported_tokens.get(index).unwrap();
            let balance = read_balance(&env, &from, &token);
            if balance == 0 {
                continue;
            }

            let deducted = balance.min(amount);
            update_balance(&env, &from, &token, -deducted)?;
            update_balance(&env, &recipient, &token, deducted)?;
            break;
        }

        let total_key = DataKey::LockedMarginTotal(from.clone());
        env.storage()
            .persistent()
            .set(&total_key, &(locked_total - amount));
        env.storage().persistent().extend_ttl(
            &total_key,
            TTL_THRESHOLD_PERSISTENT,
            TTL_BUMP_PERSISTENT,
        );

        env.events()
            .publish((symbol_short!("xfermgn"), caller, from, recipient), amount);
        Ok(())
    }

    pub fn move_balance(
        env: Env,
        caller: Address,
        from: Address,
        to: Address,
        token_address: Address,
        amount: i128,
    ) -> Result<(), VaultError> {
        bump_instance_ttl(&env);
        require_authorized_caller(&env, &caller)?;
        caller.require_auth();

        if amount <= 0 {
            return Err(VaultError::InvalidAmount);
        }

        let _ = read_collateral(&env, &token_address)?;
        update_balance(&env, &from, &token_address, -amount)?;
        update_balance(&env, &to, &token_address, amount)?;

        env.events().publish(
            (symbol_short!("movebal"), caller, from, to, token_address),
            amount,
        );
        Ok(())
    }

    pub fn update_collateral_config(
        env: Env,
        collateral: CollateralConfig,
    ) -> Result<(), VaultError> {
        bump_instance_ttl(&env);
        let mut cfg = read_config(&env)?;
        cfg.admin.require_auth();
        validate_collateral_config(&collateral)?;

        let key = DataKey::Token(collateral.token_address.clone());
        env.storage().persistent().set(&key, &collateral);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD_PERSISTENT, TTL_BUMP_PERSISTENT);
        if !contains_address(&cfg.supported_tokens, &collateral.token_address) {
            cfg.supported_tokens.push_back(collateral.token_address);
            write_config(&env, &cfg);
        }
        Ok(())
    }

    pub fn add_authorized_caller(env: Env, caller: Address) -> Result<(), VaultError> {
        bump_instance_ttl(&env);
        let mut cfg = read_config(&env)?;
        cfg.admin.require_auth();
        if !contains_address(&cfg.authorized_callers, &caller) {
            cfg.authorized_callers.push_back(caller);
            write_config(&env, &cfg);
        }
        Ok(())
    }

    /// Phase SLP — admin-gated bootstrap deposit that credits `amount` of
    /// `token_address` into the treasury's vault balance.
    ///
    /// Solves the bootstrap-insolvency defect: on a fresh deploy the treasury
    /// balance is zero, so the first profitable close cannot be paid out.
    /// The admin (deployer) calls this once after launch to seed the treasury
    /// with enough capital to cover initial trader profits until fee revenue
    /// builds up organically.
    ///
    /// Identical to `deposit` but targets `cfg.treasury` instead of the
    /// caller.  The transaction signer must be admin AND must own (or approve)
    /// the tokens; `token.transfer(admin → vault_contract, amount)` is
    /// executed, then the balance is credited to `cfg.treasury` in the vault
    /// ledger.
    pub fn seed_treasury(
        env: Env,
        admin: Address,
        token_address: Address,
        amount: i128,
    ) -> Result<(), VaultError> {
        bump_instance_ttl(&env);
        admin.require_auth();
        let cfg = read_config(&env)?;
        if admin != cfg.admin {
            return Err(VaultError::Unauthorized);
        }
        if amount <= 0 {
            return Err(VaultError::InvalidAmount);
        }
        let collateral = read_active_collateral(&env, &token_address)?;
        let amount_internal = to_precision_checked(amount, collateral.decimals, 18)
            .ok_or(VaultError::MathOverflow)?;

        let total_after = current_token_total(&env, &token_address)?
            .checked_add(amount_internal)
            .ok_or(VaultError::MathOverflow)?;
        if total_after > collateral.max_deposit_cap {
            return Err(VaultError::DepositCapExceeded);
        }

        let token_client = token::TokenClient::new(&env, &token_address);
        token_client.transfer(&admin, &env.current_contract_address(), &amount);

        update_balance(&env, &cfg.treasury, &token_address, amount_internal)?;
        env.events().publish(
            (symbol_short!("seedtres"), admin, token_address),
            amount_internal,
        );
        Ok(())
    }

    /// Phase SLP — admin-gated registration of protocol-owned sub-account
    /// addresses keyed by role.  Additive over `VaultConfig.{treasury,
    /// insurance_fund}`: legacy fields are left untouched and remain the
    /// fallback for readers.  Use this to register `SlpPool` and
    /// `FundingPool`, or to migrate `Treasury` / `Insurance` to a new
    /// address without a full config rewrite.
    pub fn set_sub_account(
        env: Env,
        role: SubAccountRole,
        account: Address,
    ) -> Result<(), VaultError> {
        bump_instance_ttl(&env);
        let cfg = read_config(&env)?;
        cfg.admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::SubAccountAddress(role), &account);
        env.events().publish(
            (symbol_short!("setsubac"), role_symbol(&role)),
            account,
        );
        Ok(())
    }

    /// Phase SLP — return the registered address for a sub-account role.
    ///
    /// For backward compatibility, `Treasury` and `Insurance` fall back to
    /// `VaultConfig.treasury` / `VaultConfig.insurance_fund` when no override
    /// has been registered via `set_sub_account`.  `SlpPool` and
    /// `FundingPool` have no legacy mirror and return
    /// `SubAccountRoleNotSet` until admin registers them.
    pub fn get_sub_account(env: Env, role: SubAccountRole) -> Result<Address, VaultError> {
        bump_instance_ttl(&env);
        if let Some(addr) = env
            .storage()
            .instance()
            .get::<_, Address>(&DataKey::SubAccountAddress(role))
        {
            return Ok(addr);
        }
        let cfg = read_config(&env)?;
        match role {
            SubAccountRole::Treasury => Ok(cfg.treasury),
            SubAccountRole::Insurance => Ok(cfg.insurance_fund),
            SubAccountRole::SlpPool | SubAccountRole::FundingPool => {
                Err(VaultError::SubAccountRoleNotSet)
            }
        }
    }

    /// Credit a user's vault balance without an on-chain token transfer.
    ///
    /// Used exclusively by the bridge contract for cross-chain inbound deposits
    /// where tokens are escrowed on the EVM side.  Authorized callers only.
    /// The caller (bridge contract) passes its own address, which must be
    /// registered via `add_authorized_caller`.
    pub fn credit(
        env: Env,
        caller: Address,
        user: Address,
        token_address: Address,
        amount: i128,
    ) -> Result<(), VaultError> {
        bump_instance_ttl(&env);
        require_authorized_caller(&env, &caller)?;
        caller.require_auth();

        if amount <= 0 {
            return Err(VaultError::InvalidAmount);
        }

        let collateral = read_active_collateral(&env, &token_address)?;
        let amount_internal = to_precision_checked(amount, collateral.decimals, 18)
            .ok_or(VaultError::MathOverflow)?;

        let total_after = current_token_total(&env, &token_address)?
            .checked_add(amount_internal)
            .ok_or(VaultError::MathOverflow)?;
        if total_after > collateral.max_deposit_cap {
            return Err(VaultError::DepositCapExceeded);
        }

        update_balance(&env, &user, &token_address, amount_internal)?;
        env.events().publish(
            (symbol_short!("credit"), caller, user, token_address),
            amount_internal,
        );
        Ok(())
    }

    /// Debit a user's vault balance without an on-chain token transfer.
    ///
    /// Used by the bridge contract for cross-chain outbound withdrawals.
    /// Tokens are released on the EVM side after this call.
    pub fn debit(
        env: Env,
        caller: Address,
        user: Address,
        token_address: Address,
        amount: i128,
    ) -> Result<(), VaultError> {
        bump_instance_ttl(&env);
        require_authorized_caller(&env, &caller)?;
        caller.require_auth();

        if amount <= 0 {
            return Err(VaultError::InvalidAmount);
        }

        let collateral = read_active_collateral(&env, &token_address)?;
        let amount_internal = to_precision_checked(amount, collateral.decimals, 18)
            .ok_or(VaultError::MathOverflow)?;

        let balance = read_balance(&env, &user, &token_address);
        if balance < amount_internal {
            return Err(VaultError::InsufficientBalance);
        }

        update_balance(&env, &user, &token_address, -amount_internal)?;
        env.events().publish(
            (symbol_short!("debit"), caller, user, token_address),
            amount_internal,
        );
        Ok(())
    }
    /// Used by governance when deploying a new oracle, risk engine, treasury,
    /// or insurance fund contract.
    pub fn update_dependencies(
        env: Env,
        oracle: Address,
        risk: Address,
        treasury: Address,
        insurance_fund: Address,
    ) -> Result<(), VaultError> {
        bump_instance_ttl(&env);
        let mut cfg = read_config(&env)?;
        cfg.admin.require_auth();
        cfg.oracle = oracle;
        cfg.risk = risk;
        cfg.treasury = treasury;
        cfg.insurance_fund = insurance_fund;
        write_config(&env, &cfg);
        Ok(())
    }

    // ─── Phase S — Sub-accounts ───────────────────────────────────────────
    //
    // Sub-accounts are lightweight earmarks _within_ the vault's custody.
    // Funds deposited via `deposit_sub` are still held by the vault contract
    // (so the on-chain balance moves identically to a regular deposit), but
    // are tracked under a separate `SubBalance(user, sub_id, token)` ledger
    // and _do not_ count toward `compute_total_collateral_value`. This means
    // sub-account funds cannot be used as margin for cross/isolated positions
    // until the user withdraws them back to their wallet (or, future work,
    // promotes them back into the master balance via a sub→master entry).
    //
    // Common use-case: a strategy / market-maker silo per sub_id where each
    // sub-account's PnL is reported separately for accounting purposes,
    // without requiring a fresh on-chain account per strategy.

    /// Deposit native-decimal `amount` of `token_address` into sub-account
    /// `sub_id` for `user`. Pulls tokens from the user's wallet just like a
    /// regular `deposit`, but credits the sub-account ledger instead of the
    /// master balance. `sub_id == 0` is reserved for the master account and
    /// rejected here.
    pub fn deposit_sub(
        env: Env,
        user: Address,
        sub_id: u32,
        token_address: Address,
        amount: i128,
    ) -> Result<(), VaultError> {
        bump_instance_ttl(&env);
        user.require_auth();

        if amount <= 0 {
            return Err(VaultError::InvalidAmount);
        }
        if sub_id == 0 {
            return Err(VaultError::InvalidConfig);
        }

        let collateral = read_active_collateral(&env, &token_address)?;
        let amount_internal = to_precision_checked(amount, collateral.decimals, 18)
            .ok_or(VaultError::MathOverflow)?;

        // Same global cap protection as `deposit`. The cap is asset-wide and
        // sub-account funds are also held by this contract, so they count.
        let total_after = current_token_total(&env, &token_address)?
            .checked_add(amount_internal)
            .ok_or(VaultError::MathOverflow)?;
        if total_after > collateral.max_deposit_cap {
            return Err(VaultError::DepositCapExceeded);
        }

        let token_client = token::TokenClient::new(&env, &token_address);
        token_client.transfer(&user, env.current_contract_address(), &amount);

        update_sub_balance(&env, &user, sub_id, &token_address, amount_internal)?;
        env.events().publish(
            (symbol_short!("subdep"), user, sub_id, token_address),
            amount_internal,
        );
        Ok(())
    }

    /// Withdraw `amount` (native decimals) from a sub-account back to the
    /// user's wallet. Auth-only on the user (no margin checks because
    /// sub-account funds are not pledged to any position).
    pub fn withdraw_sub(
        env: Env,
        user: Address,
        sub_id: u32,
        token_address: Address,
        amount: i128,
    ) -> Result<(), VaultError> {
        bump_instance_ttl(&env);
        user.require_auth();

        if amount <= 0 {
            return Err(VaultError::InvalidAmount);
        }
        if sub_id == 0 {
            return Err(VaultError::InvalidConfig);
        }

        let collateral = read_active_collateral(&env, &token_address)?;
        let amount_internal = to_precision_checked(amount, collateral.decimals, 18)
            .ok_or(VaultError::MathOverflow)?;

        let bal = read_sub_balance(&env, &user, sub_id, &token_address);
        if bal < amount_internal {
            return Err(VaultError::InsufficientBalance);
        }

        let native_amount = to_precision_checked(amount_internal, 18, collateral.decimals)
            .ok_or(VaultError::MathOverflow)?;

        authorize_token_transfer_from_current_contract(&env, &token_address, &user, native_amount);
        let token_client = token::TokenClient::new(&env, &token_address);
        token_client.transfer(&env.current_contract_address(), &user, &native_amount);

        update_sub_balance(&env, &user, sub_id, &token_address, -amount_internal)?;
        env.events().publish(
            (symbol_short!("subwd"), user, sub_id, token_address),
            amount_internal,
        );
        Ok(())
    }

    /// Move `amount_internal` (18-decimal) of `token_address` between two
    /// sub-accounts owned by the same user. Both sub_ids must be non-zero.
    /// No on-chain token transfer occurs.
    pub fn transfer_between_subs(
        env: Env,
        user: Address,
        from_sub: u32,
        to_sub: u32,
        token_address: Address,
        amount_internal: i128,
    ) -> Result<(), VaultError> {
        bump_instance_ttl(&env);
        user.require_auth();

        if amount_internal <= 0 {
            return Err(VaultError::InvalidAmount);
        }
        if from_sub == 0 || to_sub == 0 || from_sub == to_sub {
            return Err(VaultError::InvalidConfig);
        }

        let _ = read_collateral(&env, &token_address)?;

        let bal = read_sub_balance(&env, &user, from_sub, &token_address);
        if bal < amount_internal {
            return Err(VaultError::SubAccountNotFound);
        }

        update_sub_balance(&env, &user, from_sub, &token_address, -amount_internal)?;
        update_sub_balance(&env, &user, to_sub, &token_address, amount_internal)?;
        env.events().publish(
            (symbol_short!("subxfer"), user, from_sub, to_sub),
            (token_address, amount_internal),
        );
        Ok(())
    }

    /// Read-only sub-account balance in 18-decimal internal precision.
    pub fn get_sub_balance(
        env: Env,
        user: Address,
        sub_id: u32,
        token_address: Address,
    ) -> Result<i128, VaultError> {
        bump_instance_ttl(&env);
        let _ = read_collateral(&env, &token_address)?;
        Ok(read_sub_balance(&env, &user, sub_id, &token_address))
    }

    // ─── Phase T — Spot trading settlement ────────────────────────────────
    //
    // `atomic_swap` is the on-chain settlement primitive used by the CLOB
    // when it matches a spot trade between two parties (or the same party
    // across two sub-accounts mapped via offers). The vault performs both
    // legs in a single transaction: party_a sends `amount_a` of `token_a`
    // to party_b, and party_b sends `amount_b` of `token_b` to party_a.
    // Both amounts are 18-decimal internal precision.
    //
    // Authorized-caller only (CLOB / matching engine). Neither side needs to
    // sign here — the CLOB has already validated the order signatures and
    // is the trusted source of matched fills. The vault simply credits and
    // debits master balances.

    /// Settle a matched spot swap atomically. Debits `amount_a` of `token_a`
    /// from `party_a` and credits it to `party_b`; symmetrically for the
    /// other leg. Both tokens must be supported collateral. Returns
    /// `InsufficientBalance` if either side lacks the funds.
    pub fn atomic_swap(
        env: Env,
        caller: Address,
        party_a: Address,
        party_b: Address,
        token_a: Address,
        amount_a: i128,
        token_b: Address,
        amount_b: i128,
    ) -> Result<(), VaultError> {
        bump_instance_ttl(&env);
        require_authorized_caller(&env, &caller)?;
        caller.require_auth();

        if amount_a <= 0 || amount_b <= 0 {
            return Err(VaultError::InvalidAmount);
        }
        if token_a == token_b {
            // Self-swap is meaningless; reject so callers cannot use the
            // primitive to launder balances between unrelated users.
            return Err(VaultError::InvalidConfig);
        }

        let _ = read_collateral(&env, &token_a)?;
        let _ = read_collateral(&env, &token_b)?;

        // Leg 1: party_a → party_b in token_a.
        update_balance(&env, &party_a, &token_a, -amount_a)?;
        update_balance(&env, &party_b, &token_a, amount_a)?;
        // Leg 2: party_b → party_a in token_b.
        update_balance(&env, &party_b, &token_b, -amount_b)?;
        update_balance(&env, &party_a, &token_b, amount_b)?;

        env.events().publish(
            (symbol_short!("spotswap"), caller, party_a, party_b),
            (token_a, amount_a, token_b, amount_b),
        );
        Ok(())
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), VaultError> {
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

fn validate_collateral_config(cfg: &CollateralConfig) -> Result<(), VaultError> {
    if cfg.decimals > 18 || cfg.haircut_bps > BPS_DENOMINATOR || cfg.max_deposit_cap <= 0 {
        return Err(VaultError::InvalidConfig);
    }
    Ok(())
}

fn bump_instance_ttl(_env: &Env) {
    // No-op: see perp-engine for rationale. TTL extended out-of-band.
}

fn read_config(env: &Env) -> Result<VaultConfig, VaultError> {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(VaultError::InvalidConfig)
}

fn write_config(env: &Env, config: &VaultConfig) {
    env.storage().instance().set(&DataKey::Config, config);
}

fn contains_address(addresses: &Vec<Address>, needle: &Address) -> bool {
    for address in addresses.iter() {
        if address == *needle {
            return true;
        }
    }
    false
}

/// Phase SLP — stable event-friendly symbol for a sub-account role.
fn role_symbol(role: &SubAccountRole) -> Symbol {
    match role {
        SubAccountRole::Treasury => symbol_short!("treasury"),
        SubAccountRole::Insurance => symbol_short!("insrnce"),
        SubAccountRole::SlpPool => symbol_short!("slppool"),
        SubAccountRole::FundingPool => symbol_short!("fundpool"),
    }
}

fn read_collateral(env: &Env, token_address: &Address) -> Result<CollateralConfig, VaultError> {
    let key = DataKey::Token(token_address.clone());
    let cfg = env
        .storage()
        .persistent()
        .get::<_, CollateralConfig>(&key)
        .ok_or(VaultError::TokenNotSupported)?;
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_PERSISTENT, TTL_BUMP_PERSISTENT);
    Ok(cfg)
}

fn read_active_collateral(
    env: &Env,
    token_address: &Address,
) -> Result<CollateralConfig, VaultError> {
    let cfg = read_collateral(env, token_address)?;
    if !cfg.is_active {
        return Err(VaultError::TokenInactive);
    }
    Ok(cfg)
}

fn balance_key(user: &Address, token_address: &Address) -> DataKey {
    DataKey::Balance(user.clone(), token_address.clone())
}

fn read_balance(env: &Env, user: &Address, token_address: &Address) -> i128 {
    let key = balance_key(user, token_address);
    let value = env.storage().persistent().get(&key);
    if value.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD_PERSISTENT, TTL_BUMP_PERSISTENT);
    }
    value.unwrap_or(0i128)
}

fn update_balance(
    env: &Env,
    user: &Address,
    token_address: &Address,
    delta: i128,
) -> Result<i128, VaultError> {
    let key = balance_key(user, token_address);
    let updated = env
        .storage()
        .persistent()
        .try_update(&key, |current: Option<i128>| {
            let current = current.unwrap_or(0);
            let next = current.checked_add(delta).ok_or(VaultError::MathOverflow)?;
            if next < 0 {
                return Err(VaultError::InsufficientBalance);
            }
            Ok(next)
        })?;

    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_PERSISTENT, TTL_BUMP_PERSISTENT);
    Ok(updated)
}

// ─── Phase S — sub-account helpers ────────────────────────────────────────

fn sub_balance_key(user: &Address, sub_id: u32, token_address: &Address) -> DataKey {
    DataKey::SubBalance(user.clone(), sub_id, token_address.clone())
}

fn read_sub_balance(env: &Env, user: &Address, sub_id: u32, token_address: &Address) -> i128 {
    let key = sub_balance_key(user, sub_id, token_address);
    let value = env.storage().persistent().get(&key);
    if value.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD_PERSISTENT, TTL_BUMP_PERSISTENT);
    }
    value.unwrap_or(0i128)
}

fn update_sub_balance(
    env: &Env,
    user: &Address,
    sub_id: u32,
    token_address: &Address,
    delta: i128,
) -> Result<i128, VaultError> {
    let key = sub_balance_key(user, sub_id, token_address);
    let updated = env
        .storage()
        .persistent()
        .try_update(&key, |current: Option<i128>| {
            let current = current.unwrap_or(0);
            let next = current.checked_add(delta).ok_or(VaultError::MathOverflow)?;
            if next < 0 {
                return Err(VaultError::InsufficientBalance);
            }
            Ok(next)
        })?;
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_PERSISTENT, TTL_BUMP_PERSISTENT);
    Ok(updated)
}

fn current_token_total(env: &Env, token_address: &Address) -> Result<i128, VaultError> {
    let config = read_config(env)?;
    let mut total = 0i128;
    let token_client = token::TokenClient::new(env, token_address);
    for holder in [
        env.current_contract_address(),
        config.treasury,
        config.insurance_fund,
    ] {
        let native = token_client.balance(&holder);
        let collateral = read_collateral(env, token_address)?;
        total = total
            .checked_add(to_precision(native, collateral.decimals, 18))
            .ok_or(VaultError::MathOverflow)?;
    }
    Ok(total)
}

fn read_margin_mode(env: &Env, user: &Address) -> MarginMode {
    let key = DataKey::MarginMode(user.clone());
    let value = env.storage().persistent().get(&key);
    if value.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD_PERSISTENT, TTL_BUMP_PERSISTENT);
    }
    value.unwrap_or(MarginMode::Cross)
}

fn locked_margin_total(env: &Env, user: &Address) -> i128 {
    let key = DataKey::LockedMarginTotal(user.clone());
    let value = env.storage().persistent().get(&key);
    if value.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD_PERSISTENT, TTL_BUMP_PERSISTENT);
    }
    value.unwrap_or(0i128)
}

/// Phase N — cumulative isolated-margin total for `user`. Returns `0` when
/// no isolated positions are open. The free-collateral calculation
/// subtracts both the cross `LockedMarginTotal` and this value so isolated
/// margin can never be re-pledged to a cross position.
fn isolated_margin_total(env: &Env, user: &Address) -> i128 {
    let key = DataKey::IsolatedMarginTotal(user.clone());
    let value = env.storage().persistent().get(&key);
    if value.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD_PERSISTENT, TTL_BUMP_PERSISTENT);
    }
    value.unwrap_or(0i128)
}

fn compute_total_collateral_value(env: &Env, user: &Address) -> Result<i128, VaultError> {
    let config = read_config(env)?;
    let mut total = 0i128;
    for token_address in config.supported_tokens.iter() {
        let balance = read_balance(env, user, &token_address);
        if balance == 0 {
            continue;
        }

        let collateral = read_active_collateral(env, &token_address)?;
        total = total
            .checked_add(collateral_value_for_amount(env, &collateral, balance)?)
            .ok_or(VaultError::MathOverflow)?;
    }
    Ok(total)
}

fn collateral_value_for_amount(
    env: &Env,
    collateral: &CollateralConfig,
    balance_internal: i128,
) -> Result<i128, VaultError> {
    let oracle = OracleClient::new(env, &read_config(env)?.oracle);
    let price = oracle.get_price(&collateral.asset_symbol).price;
    // Divide balance by 10^9 before multiplying by price to avoid i128 overflow
    // for large deposit amounts. Then divide by 10^9 again to normalize.
    // Equivalent to `balance * price / 10^18` but without intermediate overflow.
    // Max safe balance ≈ 170 billion USDC-equivalent before overflow.
    let balance_scaled = balance_internal / 1_000_000_000i128;
    let gross = balance_scaled
        .checked_mul(price)
        .ok_or(VaultError::MathOverflow)?
        / 1_000_000_000i128;
    Ok(apply_haircut(gross, collateral.haircut_bps))
}

fn risk_margin_requirement(
    env: &Env,
    user: &Address,
    total_collateral: i128,
) -> Result<i128, VaultError> {
    let cfg = read_config(env)?;
    let risk = RiskClient::new(env, &cfg.risk);
    Ok(risk.margin_req_with_collateral(user, &total_collateral))
}

#[allow(dead_code)]
fn free_collateral_after_requirement(env: &Env, user: &Address) -> Result<i128, VaultError> {
    let total = compute_total_collateral_value(env, user)?;
    let required = risk_margin_requirement(env, user, total)?;
    let locked = locked_margin_total(env, user);
    let isolated = isolated_margin_total(env, user);
    total
        .checked_sub(required)
        .and_then(|value| value.checked_sub(locked))
        .and_then(|value| value.checked_sub(isolated))
        .ok_or(VaultError::InsufficientFreeCollateral)
}

fn require_authorized_caller(env: &Env, caller: &Address) -> Result<(), VaultError> {
    let cfg = read_config(env)?;
    if contains_address(&cfg.authorized_callers, caller) {
        Ok(())
    } else {
        Err(VaultError::Unauthorized)
    }
}

fn authorize_token_transfer_from_current_contract(
    env: &Env,
    token_address: &Address,
    to: &Address,
    amount: i128,
) {
    let auth = InvokerContractAuthEntry::Contract(SubContractInvocation {
        context: ContractContext {
            contract: token_address.clone(),
            fn_name: symbol_short!("transfer"),
            args: Vec::from_array(
                env,
                [
                    env.current_contract_address().to_val(),
                    to.to_val(),
                    amount.into_val(env),
                ],
            ),
        },
        sub_invocations: Vec::new(env),
    });
    env.authorize_as_current_contract(Vec::from_array(env, [auth]));
}

#[cfg(test)]
mod tests {
    use soroban_sdk::{contract, contractimpl, testutils::Address as _, Address};

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
    }

    #[contract]
    struct MockRisk;

    #[contracttype]
    #[derive(Clone, Debug, Eq, PartialEq)]
    enum MockRiskKey {
        Margin(Address),
    }

    #[contractimpl]
    impl MockRisk {
        pub fn set_margin_requirement(env: Env, user: Address, amount: i128) {
            env.storage()
                .persistent()
                .set(&MockRiskKey::Margin(user), &amount);
        }

        pub fn get_margin_requirement(env: Env, user: Address) -> i128 {
            env.storage()
                .persistent()
                .get(&MockRiskKey::Margin(user))
                .unwrap_or(0)
        }

        pub fn margin_req_with_collateral(
            env: Env,
            user: Address,
            _total_collateral: i128,
        ) -> i128 {
            Self::get_margin_requirement(env, user)
        }

        /// Implements the same interface as `risk.get_total_initial_margin_stored`.
        pub fn get_total_initial_margin_stored(env: Env, user: Address) -> i128 {
            Self::get_margin_requirement(env, user)
        }

        /// Phase SLP — implements `risk.get_account_equity`.
        /// Returns (0 - locked_margin, locked_margin) so the vault sees the
        /// same locked margin value regardless of which method it calls.
        /// The equity return is intentionally not meaningful for the test; only
        /// `locked_margin` drives the `withdraw` guard.
        pub fn get_account_equity(env: Env, user: Address) -> (i128, i128) {
            let locked = Self::get_margin_requirement(env, user);
            (0i128, locked)
        }
    }

    struct Setup {
        env: Env,
        user: Address,
        engine: Address,
        usdc: Address,
        xlm: Address,
        vault: StellaxVaultClient<'static>,
        risk: MockRiskClient<'static>,
        oracle: MockOracleClient<'static>,
    }

    fn setup() -> Setup {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let engine = Address::generate(&env);
        let treasury = Address::generate(&env);
        let insurance = Address::generate(&env);

        let usdc_contract = env.register_stellar_asset_contract_v2(admin.clone());
        let xlm_contract = env.register_stellar_asset_contract_v2(admin.clone());
        let usdc = usdc_contract.address();
        let xlm = xlm_contract.address();

        let usdc_admin = token::StellarAssetClient::new(&env, &usdc);
        let xlm_admin = token::StellarAssetClient::new(&env, &xlm);
        usdc_admin.mint(&user, &1_000_000_000i128);
        xlm_admin.mint(&user, &1_000_000_000i128);

        let oracle_id = env.register(MockOracle, ());
        let risk_id = env.register(MockRisk, ());
        let oracle = MockOracleClient::new(&env, &oracle_id);
        let risk = MockRiskClient::new(&env, &risk_id);

        oracle.set_price(&Symbol::new(&env, "USDC"), &1_000_000_000_000_000_000i128);
        oracle.set_price(&Symbol::new(&env, "XLM"), &120_000_000_000_000_000i128);

        let mut callers = Vec::new(&env);
        callers.push_back(engine.clone());
        let mut collateral = Vec::new(&env);
        collateral.push_back(CollateralConfig {
            token_address: usdc.clone(),
            asset_symbol: Symbol::new(&env, "USDC"),
            decimals: 6,
            haircut_bps: 0,
            max_deposit_cap: 10_000_000_000_000_000_000_000_000i128,
            is_active: true,
        });
        collateral.push_back(CollateralConfig {
            token_address: xlm.clone(),
            asset_symbol: Symbol::new(&env, "XLM"),
            decimals: 7,
            haircut_bps: 1_500,
            max_deposit_cap: 10_000_000_000_000_000_000_000_000i128,
            is_active: true,
        });

        let vault_id = env.register(
            StellaxVault,
            (
                admin.clone(),
                oracle_id.clone(),
                risk_id.clone(),
                treasury.clone(),
                insurance.clone(),
                callers,
                collateral,
            ),
        );
        let vault = StellaxVaultClient::new(&env, &vault_id);

        Setup {
            env,
            user,
            engine,
            usdc,
            xlm,
            vault,
            risk,
            oracle,
        }
    }

    #[test]
    fn deposit_tracks_balance_in_internal_precision() {
        let s = setup();
        s.vault.deposit(&s.user, &s.usdc, &1_500_000i128);
        assert_eq!(
            s.vault.get_balance(&s.user, &s.usdc),
            1_500_000_000_000_000_000i128
        );
    }

    #[test]
    fn withdraw_checks_margin_requirement() {
        let s = setup();
        s.vault.deposit(&s.user, &s.usdc, &2_000_000i128);
        s.risk
            .set_margin_requirement(&s.user, &1_500_000_000_000_000_000i128);

        assert_eq!(
            s.vault.try_withdraw(&s.user, &s.usdc, &1_000_000i128),
            Err(Ok(VaultError::InsufficientFreeCollateral))
        );
    }

    #[test]
    fn multi_asset_collateral_applies_haircuts() {
        let s = setup();
        s.vault.deposit(&s.user, &s.usdc, &1_000_000i128);
        s.vault.deposit(&s.user, &s.xlm, &10_000_000i128);

        let total = s.vault.get_total_collateral_value(&s.user);
        // USDC: $1.00, XLM: 1 token * $0.12 * 85% = $0.102.
        assert_eq!(total, 1_102_000_000_000_000_000i128);
    }

    #[test]
    fn updated_collateral_is_included_in_total_value() {
        let s = setup();
        let admin = Address::generate(&s.env);
        let benji_contract = s.env.register_stellar_asset_contract_v2(admin.clone());
        let benji = benji_contract.address();
        let benji_admin = token::StellarAssetClient::new(&s.env, &benji);
        let benji_symbol = Symbol::new(&s.env, "BENJI");

        benji_admin.mint(&s.user, &50_000_000i128);
        s.risk.set_margin_requirement(&s.user, &0);
        s.vault.update_collateral_config(&CollateralConfig {
            token_address: benji.clone(),
            asset_symbol: benji_symbol.clone(),
            decimals: 6,
            haircut_bps: 700,
            max_deposit_cap: 500_000_000_000_000_000_000_000i128,
            is_active: true,
        });
        s.oracle
            .set_price(&benji_symbol, &1_000_000_000_000_000_000i128);
        s.vault.deposit(&s.user, &benji, &50_000_000i128);
        assert_eq!(
            s.vault.get_total_collateral_value(&s.user),
            46_500_000_000_000_000_000i128
        );
    }

    #[test]
    fn lock_and_unlock_margin_adjusts_free_capacity() {
        let s = setup();
        s.vault.deposit(&s.user, &s.usdc, &3_000_000i128);

        s.vault
            .lock_margin(&s.engine, &s.user, &42u64, &1_000_000_000_000_000_000i128);

        assert_eq!(
            s.vault
                .try_lock_margin(&s.engine, &s.user, &43u64, &2_500_000_000_000_000_000i128),
            Err(Ok(VaultError::MarginLockExceeded))
        );

        s.vault
            .unlock_margin(&s.engine, &s.user, &42u64, &500_000_000_000_000_000i128);
        s.vault
            .lock_margin(&s.engine, &s.user, &43u64, &2_000_000_000_000_000_000i128);
    }

    #[test]
    fn unauthorized_caller_cannot_lock_margin() {
        let s = setup();
        s.vault.deposit(&s.user, &s.usdc, &3_000_000i128);
        let attacker = Address::generate(&s.env);

        assert_eq!(
            s.vault
                .try_lock_margin(&attacker, &s.user, &1u64, &1_000_000_000_000_000_000i128),
            Err(Ok(VaultError::Unauthorized))
        );
    }

    #[test]
    fn authorized_caller_can_move_internal_balance() {
        let s = setup();
        let other_user = Address::generate(&s.env);
        s.vault.deposit(&s.user, &s.usdc, &3_000_000i128);

        s.vault.move_balance(
            &s.engine,
            &s.user,
            &other_user,
            &s.usdc,
            &1_250_000_000_000_000_000i128,
        );

        assert_eq!(
            s.vault.get_balance(&s.user, &s.usdc),
            1_750_000_000_000_000_000i128
        );
        assert_eq!(
            s.vault.get_balance(&other_user, &s.usdc),
            1_250_000_000_000_000_000i128
        );
    }

    // ─── Phase N — Isolated margin tests ──────────────────────────────────

    #[test]
    fn phase_n_lock_isolated_segregates_collateral_from_cross_pool() {
        let s = setup();
        s.vault.deposit(&s.user, &s.usdc, &5_000_000i128);
        // Total collateral = 5 USDC = 5e18.

        // Lock 2 USDC isolated for position 7.
        s.vault
            .lock_isolated(&s.engine, &s.user, &7u64, &2_000_000_000_000_000_000i128);
        assert_eq!(
            s.vault.get_isolated_margin(&s.user, &7u64),
            2_000_000_000_000_000_000i128
        );
        assert_eq!(
            s.vault.get_isolated_margin_total(&s.user),
            2_000_000_000_000_000_000i128
        );

        // The cross pool should now see only 3 USDC of free collateral —
        // a cross lock for 4 USDC must fail with MarginLockExceeded.
        assert_eq!(
            s.vault
                .try_lock_margin(&s.engine, &s.user, &8u64, &4_000_000_000_000_000_000i128),
            Err(Ok(VaultError::MarginLockExceeded))
        );

        // 3 USDC cross lock fits exactly.
        s.vault
            .lock_margin(&s.engine, &s.user, &8u64, &3_000_000_000_000_000_000i128);
    }

    #[test]
    fn phase_n_unlock_isolated_restores_free_collateral() {
        let s = setup();
        s.vault.deposit(&s.user, &s.usdc, &4_000_000i128);
        s.vault
            .lock_isolated(&s.engine, &s.user, &1u64, &3_000_000_000_000_000_000i128);

        s.vault
            .unlock_isolated(&s.engine, &s.user, &1u64, &1_000_000_000_000_000_000i128);

        assert_eq!(
            s.vault.get_isolated_margin(&s.user, &1u64),
            2_000_000_000_000_000_000i128
        );
        // 1 USDC of capacity restored — cross can now lock 2 USDC total.
        s.vault
            .lock_margin(&s.engine, &s.user, &2u64, &2_000_000_000_000_000_000i128);
    }

    #[test]
    fn phase_n_realize_pnl_negative_within_bucket_returns_zero_shortfall() {
        let s = setup();
        s.vault.deposit(&s.user, &s.usdc, &5_000_000i128);
        s.vault
            .lock_isolated(&s.engine, &s.user, &9u64, &3_000_000_000_000_000_000i128);

        // Loss of 1 USDC: fully covered by the 3 USDC bucket.
        let shortfall = s.vault.realize_isolated_pnl(
            &s.engine,
            &s.user,
            &9u64,
            &-1_000_000_000_000_000_000i128,
        );
        assert_eq!(shortfall, 0i128);

        // Bucket reduced from 3 → 2 USDC.
        assert_eq!(
            s.vault.get_isolated_margin(&s.user, &9u64),
            2_000_000_000_000_000_000i128
        );
    }

    #[test]
    fn phase_n_realize_pnl_negative_exceeds_bucket_reports_shortfall() {
        let s = setup();
        s.vault.deposit(&s.user, &s.usdc, &5_000_000i128);
        s.vault
            .lock_isolated(&s.engine, &s.user, &11u64, &2_000_000_000_000_000_000i128);
        // Cross lock should not be touched even when the isolated position blows up.
        s.vault
            .lock_margin(&s.engine, &s.user, &12u64, &1_000_000_000_000_000_000i128);

        // Loss of 5 USDC: only 2 covered; 3 USDC shortfall reported.
        let shortfall = s.vault.realize_isolated_pnl(
            &s.engine,
            &s.user,
            &11u64,
            &-5_000_000_000_000_000_000i128,
        );
        assert_eq!(shortfall, 3_000_000_000_000_000_000i128);

        // Isolated bucket fully drained.
        assert_eq!(s.vault.get_isolated_margin(&s.user, &11u64), 0i128);
        assert_eq!(s.vault.get_isolated_margin_total(&s.user), 0i128);
        // Cross lock is untouched — the isolated wipe-out cannot reach it.
        // After the isolated bucket is wiped (2 USDC consumed), the user
        // has 5 - 2 = 3 USDC of total collateral remaining; with 1 USDC
        // still locked cross, free collateral = 2 USDC.
        s.vault
            .lock_margin(&s.engine, &s.user, &13u64, &2_000_000_000_000_000_000i128);
    }

    #[test]
    fn phase_n_realize_pnl_positive_releases_full_bucket() {
        let s = setup();
        s.vault.deposit(&s.user, &s.usdc, &5_000_000i128);
        s.vault
            .lock_isolated(&s.engine, &s.user, &21u64, &2_000_000_000_000_000_000i128);

        let shortfall =
            s.vault
                .realize_isolated_pnl(&s.engine, &s.user, &21u64, &500_000_000_000_000_000i128);
        assert_eq!(shortfall, 0i128);
        assert_eq!(s.vault.get_isolated_margin(&s.user, &21u64), 0i128);
        assert_eq!(s.vault.get_isolated_margin_total(&s.user), 0i128);
    }

    #[test]
    fn phase_n_unauthorized_caller_cannot_lock_isolated() {
        let s = setup();
        s.vault.deposit(&s.user, &s.usdc, &3_000_000i128);
        let attacker = Address::generate(&s.env);
        assert_eq!(
            s.vault
                .try_lock_isolated(&attacker, &s.user, &1u64, &1_000_000_000_000_000_000i128,),
            Err(Ok(VaultError::Unauthorized))
        );
    }

    // ─── Phase S — Sub-account tests ──────────────────────────────────────

    #[test]
    fn phase_s_deposit_sub_credits_silo_without_master_balance() {
        let s = setup();
        s.vault.deposit_sub(&s.user, &1u32, &s.usdc, &500_000i128);
        // Sub balance grows in 18-dec internal precision.
        assert_eq!(
            s.vault.get_sub_balance(&s.user, &1u32, &s.usdc),
            500_000_000_000_000_000i128
        );
        // Master balance is unchanged.
        assert_eq!(s.vault.get_balance(&s.user, &s.usdc), 0i128);
        // Sub balance does NOT count toward total collateral.
        assert_eq!(s.vault.get_total_collateral_value(&s.user), 0i128);
    }

    #[test]
    fn phase_s_withdraw_sub_returns_tokens_and_drains_balance() {
        let s = setup();
        s.vault.deposit_sub(&s.user, &2u32, &s.usdc, &1_000_000i128);
        s.vault.withdraw_sub(&s.user, &2u32, &s.usdc, &600_000i128);
        assert_eq!(
            s.vault.get_sub_balance(&s.user, &2u32, &s.usdc),
            400_000_000_000_000_000i128
        );
        // Cannot withdraw more than the sub balance.
        assert_eq!(
            s.vault
                .try_withdraw_sub(&s.user, &2u32, &s.usdc, &500_000i128),
            Err(Ok(VaultError::InsufficientBalance))
        );
    }

    #[test]
    fn phase_s_transfer_between_subs_moves_internal_balance() {
        let s = setup();
        s.vault.deposit_sub(&s.user, &3u32, &s.usdc, &1_000_000i128);
        s.vault
            .transfer_between_subs(&s.user, &3u32, &4u32, &s.usdc, &400_000_000_000_000_000i128);
        assert_eq!(
            s.vault.get_sub_balance(&s.user, &3u32, &s.usdc),
            600_000_000_000_000_000i128
        );
        assert_eq!(
            s.vault.get_sub_balance(&s.user, &4u32, &s.usdc),
            400_000_000_000_000_000i128
        );
    }

    #[test]
    fn phase_s_master_sub_id_zero_is_reserved() {
        let s = setup();
        assert_eq!(
            s.vault.try_deposit_sub(&s.user, &0u32, &s.usdc, &100i128),
            Err(Ok(VaultError::InvalidConfig))
        );
        assert_eq!(
            s.vault.try_withdraw_sub(&s.user, &0u32, &s.usdc, &100i128),
            Err(Ok(VaultError::InvalidConfig))
        );
        assert_eq!(
            s.vault
                .try_transfer_between_subs(&s.user, &0u32, &1u32, &s.usdc, &1i128,),
            Err(Ok(VaultError::InvalidConfig))
        );
    }

    #[test]
    fn phase_s_transfer_with_insufficient_sub_balance_fails() {
        let s = setup();
        s.vault.deposit_sub(&s.user, &5u32, &s.usdc, &500_000i128);
        assert_eq!(
            s.vault.try_transfer_between_subs(
                &s.user,
                &5u32,
                &6u32,
                &s.usdc,
                &600_000_000_000_000_000i128,
            ),
            Err(Ok(VaultError::SubAccountNotFound))
        );
    }

    // ─── Phase T — Spot swap tests ────────────────────────────────────────

    #[test]
    fn phase_t_atomic_swap_moves_both_legs_atomically() {
        let s = setup();
        let counter = Address::generate(&s.env);
        s.vault.deposit(&s.user, &s.usdc, &10_000_000i128); // 10 USDC
                                                            // Counter has no minted tokens; seed via the authorized-caller `credit`
                                                            // primitive (the bridge path) so we don't need a real SAC transfer.
        s.vault.credit(&s.engine, &counter, &s.xlm, &50_000_000i128); // 5 XLM

        // Trade: user gives 4 USDC, receives 2 XLM.
        s.vault.atomic_swap(
            &s.engine,
            &s.user,
            &counter,
            &s.usdc,
            &4_000_000_000_000_000_000i128,
            &s.xlm,
            &2_000_000_000_000_000_000i128,
        );

        assert_eq!(
            s.vault.get_balance(&s.user, &s.usdc),
            6_000_000_000_000_000_000i128
        );
        assert_eq!(
            s.vault.get_balance(&counter, &s.usdc),
            4_000_000_000_000_000_000i128
        );
        assert_eq!(
            s.vault.get_balance(&counter, &s.xlm),
            3_000_000_000_000_000_000i128
        );
        assert_eq!(
            s.vault.get_balance(&s.user, &s.xlm),
            2_000_000_000_000_000_000i128
        );
    }

    #[test]
    fn phase_t_atomic_swap_rejects_unauthorized_caller() {
        let s = setup();
        let counter = Address::generate(&s.env);
        let attacker = Address::generate(&s.env);
        s.vault.deposit(&s.user, &s.usdc, &1_000_000i128);
        s.vault.credit(&s.engine, &counter, &s.xlm, &10_000_000i128);
        assert_eq!(
            s.vault.try_atomic_swap(
                &attacker,
                &s.user,
                &counter,
                &s.usdc,
                &1_000_000_000_000_000_000i128,
                &s.xlm,
                &1_000_000_000_000_000_000i128,
            ),
            Err(Ok(VaultError::Unauthorized))
        );
    }

    #[test]
    fn phase_t_atomic_swap_rejects_self_swap_same_token() {
        let s = setup();
        let counter = Address::generate(&s.env);
        s.vault.deposit(&s.user, &s.usdc, &5_000_000i128);
        s.vault.credit(&s.engine, &counter, &s.usdc, &5_000_000i128);
        assert_eq!(
            s.vault.try_atomic_swap(
                &s.engine,
                &s.user,
                &counter,
                &s.usdc,
                &1_000_000_000_000_000_000i128,
                &s.usdc,
                &1_000_000_000_000_000_000i128,
            ),
            Err(Ok(VaultError::InvalidConfig))
        );
    }

    #[test]
    fn phase_t_atomic_swap_fails_when_either_side_underfunded() {
        let s = setup();
        let counter = Address::generate(&s.env);
        s.vault.deposit(&s.user, &s.usdc, &1_000_000i128);
        // counter has no XLM; second leg will fail.
        assert_eq!(
            s.vault.try_atomic_swap(
                &s.engine,
                &s.user,
                &counter,
                &s.usdc,
                &500_000_000_000_000_000i128,
                &s.xlm,
                &500_000_000_000_000_000i128,
            ),
            Err(Ok(VaultError::InsufficientBalance))
        );
        // Master balances are unchanged because the second leg reverts the
        // whole transaction.
        assert_eq!(
            s.vault.get_balance(&s.user, &s.usdc),
            1_000_000_000_000_000_000i128
        );
    }
}
