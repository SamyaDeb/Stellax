//! StellaX SLP Vault — Phase 2.
//!
//! A Hyperliquid HLP-style USDC-only liquidity-provider vault that acts as
//! the perpetual market's counterparty pool.
//!
//! ## Architecture
//!
//! ```text
//!  LP depositor
//!      │  deposit(user, amount_native)
//!      ▼
//!  StellaxSlpVault
//!      │  vault.deposit(self, usdc, amount)   ← register USDC in collateral vault
//!      │  mint shares → user
//!      │  set UnlockAt(user) = now + cooldown_secs
//!      ▼
//!  StellaxVault (collateral vault)
//!      │  perp-engine reads SLP balance when paying trader profit
//!      ▼
//!  SLP sub-account balance in collateral vault
//! ```
//!
//! ## NAV / share math (18-decimal PRECISION throughout)
//!
//! ```text
//!  nav_per_share = total_assets / total_shares   (1:1 at inception)
//!  shares_minted = amount_internal * total_shares / total_assets
//!  underlying    = shares * total_assets / total_shares
//! ```
//!
//! ## Withdrawal guards
//! 1. **Cooldown** — `ledger().timestamp() >= UnlockAt(user)`.
//! 2. **Skew cap** — `(sum_oi_long + sum_oi_short) / nav ≤ skew_cap_bps / 10_000`.
//!    Disabled when `skew_cap_bps == 0`.
//!
//! ## Fee sweep
//! The keeper calls `sweep_fees(amount_native)` which moves USDC from the
//! treasury's collateral-vault balance to this vault's collateral-vault balance,
//! uplifting NAV for all existing shares.

#![no_std]
#![allow(clippy::too_many_arguments)]
#![allow(deprecated)]

use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, token,
    Address, BytesN, Env, IntoVal, String, Vec,
};
use stellax_math::{mul_div, Market, BPS_DENOMINATOR, PRECISION, TTL_BUMP_INSTANCE,
    TTL_BUMP_PERSISTENT, TTL_THRESHOLD_INSTANCE, TTL_THRESHOLD_PERSISTENT};

// ─── Constants ────────────────────────────────────────────────────────────────

const CONTRACT_VERSION: u32 = 1;

/// Soroban USDC / XLM token decimals → 18dp internal PRECISION multiplier.
/// native (7dp) * NATIVE_TO_INTERNAL = internal (18dp).
const NATIVE_TO_INTERNAL: i128 = 100_000_000_000; // 10^11

// ─── Errors ───────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum SlpError {
    AlreadyInitialized = 1,
    Unauthorized = 2,
    InvalidConfig = 3,
    InvalidAmount = 4,
    InsufficientShares = 5,
    MathOverflow = 6,
    VaultCapExceeded = 7,
    CooldownNotMet = 8,
    SkewCapExceeded = 9,
    InsufficientAllowance = 10,
}

// ─── Storage keys ─────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum DataKey {
    Config,
    TotalShares, // i128, 18dp
    TotalAssets, // i128, 18dp — tracked NAV
    ShareBalance(Address),
    Allowance(Address, Address), // (owner, spender)
    /// Unix timestamp (seconds) at which the user's LP position unlocks.
    UnlockAt(Address),
    Version,
}

// ─── Config ───────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SlpConfig {
    pub admin: Address,
    pub keeper: Address,
    /// Main StellaX collateral vault (where USDC balances live).
    pub vault_contract: Address,
    /// Perp engine (queried for OI during skew-cap check; None = disabled).
    pub perp_engine: Address,
    /// USDC SEP-41 token.
    pub usdc_token: Address,
    /// Treasury — source of fee sweeps.
    pub treasury: Address,
    /// Withdrawal cooldown in seconds. Default 86 400 (24 h); testnet 3 600 (1 h).
    pub cooldown_secs: u64,
    /// Max `(oi_long + oi_short) / nav` in bps before withdrawals are blocked.
    /// Set to 0 to disable the skew cap entirely.
    pub skew_cap_bps: u32,
    /// Maximum LP deposits in 18-decimal internal units.
    pub max_vault_cap: i128,
    /// Perp market IDs whose OI is summed for the skew cap check.
    pub perp_market_ids: Vec<u32>,
}

// ─── Cross-contract clients ───────────────────────────────────────────────────

#[contractclient(name = "VaultClient")]
pub trait VaultInterface {
    fn deposit(
        env: Env,
        user: Address,
        token_address: Address,
        amount: i128,
    ) -> Result<(), soroban_sdk::Error>;

    fn withdraw(
        env: Env,
        user: Address,
        token_address: Address,
        amount: i128,
    ) -> Result<(), soroban_sdk::Error>;

    fn move_balance(
        env: Env,
        caller: Address,
        from: Address,
        to: Address,
        token_address: Address,
        amount: i128,
    ) -> Result<(), soroban_sdk::Error>;
}

/// Minimal mirror of `MarketParams` in `stellax-perp-engine`.
/// Must match the XDR contracttype layout exactly.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketParams {
    pub min_position_size: i128,
}

/// Minimal mirror of `MarketInfo` in `stellax-perp-engine`.
/// Only the fields we read are listed; the full struct must have the same
/// field order as the on-chain encoding to deserialise correctly.
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

#[contractclient(name = "PerpEngineClient")]
pub trait PerpEngineInterface {
    fn get_market_info(env: Env, market_id: u32) -> Result<MarketInfo, soroban_sdk::Error>;
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct StellaxSlpVault;

#[contractimpl]
impl StellaxSlpVault {
    // ── Version / Init ───────────────────────────────────────────────────

    pub fn version(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Version)
            .unwrap_or(CONTRACT_VERSION)
    }

    pub fn initialize(env: Env, config: SlpConfig) -> Result<(), SlpError> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(SlpError::AlreadyInitialized);
        }
        config.admin.require_auth();
        if config.max_vault_cap <= 0 || config.skew_cap_bps > 10 * BPS_DENOMINATOR as u32 {
            return Err(SlpError::InvalidConfig);
        }
        env.storage().instance().set(&DataKey::Config, &config);
        env.storage().instance().set(&DataKey::TotalShares, &0i128);
        env.storage().instance().set(&DataKey::TotalAssets, &0i128);
        env.storage()
            .instance()
            .set(&DataKey::Version, &CONTRACT_VERSION);
        bump_instance(&env);
        Ok(())
    }

    // ── Deposit ──────────────────────────────────────────────────────────

    /// Deposit `amount_native` USDC into the SLP vault.
    ///
    /// - Converts 7dp native → 18dp internal.
    /// - Mints proportional shares (1:1 for the first depositor).
    /// - Sets `UnlockAt(user) = now + cooldown_secs`.
    pub fn deposit(env: Env, user: Address, amount_native: i128) -> Result<(), SlpError> {
        user.require_auth();
        let config = load_config(&env)?;
        if amount_native <= 0 {
            return Err(SlpError::InvalidAmount);
        }
        let amount_internal = amount_native
            .checked_mul(NATIVE_TO_INTERNAL)
            .ok_or(SlpError::MathOverflow)?;

        // ── Cap check ─────────────────────────────────────────────────
        let current_assets = load_i128(&env, &DataKey::TotalAssets);
        if current_assets + amount_internal > config.max_vault_cap {
            return Err(SlpError::VaultCapExceeded);
        }

        // ── Pull USDC from user into this contract ────────────────────
        let token = token::TokenClient::new(&env, &config.usdc_token);
        token.transfer(&user, &env.current_contract_address(), &amount_native);

        // ── Register balance in the collateral vault ──────────────────
        // vault.deposit(self, usdc, amount_native) will call
        // self.require_auth() internally — satisfied because the SLP
        // vault IS the current contract executing this call.
        // We also pre-authorise the inner token.transfer(self → vault).
        authorize_token_transfer(
            &env,
            &config.usdc_token,
            &config.vault_contract,
            amount_native,
        );
        let vault = VaultClient::new(&env, &config.vault_contract);
        vault.deposit(
            &env.current_contract_address(),
            &config.usdc_token,
            &amount_native,
        );

        // ── Mint shares ───────────────────────────────────────────────
        mint_shares(&env, &user, amount_internal)?;

        // ── Set cooldown ──────────────────────────────────────────────
        let unlock_at = env
            .ledger()
            .timestamp()
            .saturating_add(config.cooldown_secs);
        env.storage()
            .persistent()
            .set(&DataKey::UnlockAt(user.clone()), &unlock_at);
        env.storage().persistent().extend_ttl(
            &DataKey::UnlockAt(user.clone()),
            TTL_THRESHOLD_PERSISTENT,
            TTL_BUMP_PERSISTENT,
        );

        bump_instance(&env);
        env.events()
            .publish((symbol_short!("slpdep"), user), (amount_internal, unlock_at));
        Ok(())
    }

    // ── Seed (admin bootstrap, no cooldown) ──────────────────────────────

    /// Admin-only bootstrap deposit — used to seed the pool with the initial
    /// $10k USDC before opening to the public. Does NOT set a withdrawal
    /// cooldown so the deployer can reclaim funds if needed.
    pub fn seed(env: Env, amount_native: i128) -> Result<(), SlpError> {
        let config = load_config(&env)?;
        config.admin.require_auth();
        if amount_native <= 0 {
            return Err(SlpError::InvalidAmount);
        }
        let amount_internal = amount_native
            .checked_mul(NATIVE_TO_INTERNAL)
            .ok_or(SlpError::MathOverflow)?;

        let current_assets = load_i128(&env, &DataKey::TotalAssets);
        if current_assets + amount_internal > config.max_vault_cap {
            return Err(SlpError::VaultCapExceeded);
        }

        let token = token::TokenClient::new(&env, &config.usdc_token);
        token.transfer(
            &config.admin,
            &env.current_contract_address(),
            &amount_native,
        );

        authorize_token_transfer(
            &env,
            &config.usdc_token,
            &config.vault_contract,
            amount_native,
        );
        let vault = VaultClient::new(&env, &config.vault_contract);
        vault.deposit(
            &env.current_contract_address(),
            &config.usdc_token,
            &amount_native,
        );

        mint_shares(&env, &config.admin, amount_internal)?;

        bump_instance(&env);
        env.events().publish(
            (symbol_short!("slpseed"), config.admin.clone()),
            amount_internal,
        );
        Ok(())
    }

    // ── Withdraw ─────────────────────────────────────────────────────────

    /// Burn `shares` and receive proportional USDC.
    ///
    /// Guards (in order):
    /// 1. User must hold ≥ `shares`.
    /// 2. `ledger().timestamp() >= UnlockAt(user)` (cooldown).
    /// 3. OI/NAV ≤ skew_cap_bps (if non-zero).
    pub fn withdraw(env: Env, user: Address, shares: i128) -> Result<(), SlpError> {
        user.require_auth();
        let config = load_config(&env)?;
        if shares <= 0 {
            return Err(SlpError::InvalidAmount);
        }
        let user_balance = load_share_balance(&env, &user);
        if user_balance < shares {
            return Err(SlpError::InsufficientShares);
        }

        // ── Cooldown guard ────────────────────────────────────────────
        let unlock_at: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::UnlockAt(user.clone()))
            .unwrap_or(0);
        if env.ledger().timestamp() < unlock_at {
            return Err(SlpError::CooldownNotMet);
        }

        // ── Skew cap guard ────────────────────────────────────────────
        if config.skew_cap_bps > 0 && !config.perp_market_ids.is_empty() {
            let total_assets = load_i128(&env, &DataKey::TotalAssets);
            let total_shares = load_i128(&env, &DataKey::TotalShares);

            if total_shares > 0 && total_assets > 0 {
                // NAV after this withdrawal (conservative — use post-burn NAV).
                let underlying = mul_div(shares, total_assets, total_shares);
                let nav_after = total_assets.saturating_sub(underlying);

                if nav_after > 0 {
                    let perp = PerpEngineClient::new(&env, &config.perp_engine);
                    let mut total_oi: i128 = 0;
                    for i in 0..config.perp_market_ids.len() {
                        let market_id = config.perp_market_ids.get(i).unwrap();
                        if let Ok(info) = perp.try_get_market_info(&market_id) {
                            if let Ok(info) = info {
                                total_oi = total_oi
                                    .saturating_add(info.oi_long)
                                    .saturating_add(info.oi_short);
                            }
                        }
                    }
                    // skew = total_oi / nav_after; block if > skew_cap_bps / BPS_DENOMINATOR.
                    // Equivalent: total_oi * BPS_DENOMINATOR > nav_after * skew_cap_bps.
                    let lhs = total_oi
                        .checked_mul(BPS_DENOMINATOR as i128)
                        .unwrap_or(i128::MAX);
                    let rhs = nav_after
                        .checked_mul(config.skew_cap_bps as i128)
                        .unwrap_or(i128::MAX);
                    if lhs > rhs {
                        return Err(SlpError::SkewCapExceeded);
                    }
                }
            }
        }

        // ── Burn shares and redeem USDC ───────────────────────────────
        let native = burn_shares_and_redeem(&env, &user, shares)?;

        // Withdraw from collateral vault to this contract, then forward to user.
        let vault = VaultClient::new(&env, &config.vault_contract);
        vault.withdraw(
            &env.current_contract_address(),
            &config.usdc_token,
            &native,
        );
        // Forward: current contract now holds the USDC.
        authorize_token_transfer(&env, &config.usdc_token, &user, native);
        let token = token::TokenClient::new(&env, &config.usdc_token);
        token.transfer(&env.current_contract_address(), &user, &native);

        bump_instance(&env);
        env.events()
            .publish((symbol_short!("slpwdraw"), user), (shares, native));
        Ok(())
    }

    // ── Fee sweep (keeper-only) ───────────────────────────────────────────

    /// Move `amount_native` USDC from treasury's collateral-vault balance to
    /// this vault's collateral-vault balance, uplifting NAV for all LPs.
    ///
    /// The SLP vault contract must be registered as an `authorized_caller` in
    /// the main collateral vault by the admin before this can be called.
    pub fn sweep_fees(env: Env, amount_native: i128) -> Result<(), SlpError> {
        let config = load_config(&env)?;
        config.keeper.require_auth();
        if amount_native <= 0 {
            return Err(SlpError::InvalidAmount);
        }
        let amount_internal = amount_native
            .checked_mul(NATIVE_TO_INTERNAL)
            .ok_or(SlpError::MathOverflow)?;

        // move_balance takes 18dp amounts (same unit as stored balances in vault).
        let vault = VaultClient::new(&env, &config.vault_contract);
        vault.move_balance(
            &env.current_contract_address(), // caller (must be in vault.authorized_callers)
            &config.treasury,                // from
            &env.current_contract_address(), // to (SLP vault's sub-account)
            &config.usdc_token,
            &amount_internal,
        );

        // Uplift NAV tracking.
        let total_assets = load_i128(&env, &DataKey::TotalAssets);
        env.storage()
            .instance()
            .set(&DataKey::TotalAssets, &(total_assets + amount_internal));

        bump_instance(&env);
        env.events().publish(
            (symbol_short!("slpfee"), config.treasury),
            (amount_internal,),
        );
        Ok(())
    }

    // ── Admin setters ─────────────────────────────────────────────────────

    pub fn set_cooldown_secs(env: Env, secs: u64) -> Result<(), SlpError> {
        bump_instance(&env);
        let mut config = load_config(&env)?;
        config.admin.require_auth();
        config.cooldown_secs = secs;
        env.storage().instance().set(&DataKey::Config, &config);
        Ok(())
    }

    pub fn set_skew_cap_bps(env: Env, bps: u32) -> Result<(), SlpError> {
        bump_instance(&env);
        let mut config = load_config(&env)?;
        config.admin.require_auth();
        config.skew_cap_bps = bps;
        env.storage().instance().set(&DataKey::Config, &config);
        Ok(())
    }

    pub fn set_max_vault_cap(env: Env, cap: i128) -> Result<(), SlpError> {
        bump_instance(&env);
        let mut config = load_config(&env)?;
        config.admin.require_auth();
        if cap <= 0 {
            return Err(SlpError::InvalidConfig);
        }
        config.max_vault_cap = cap;
        env.storage().instance().set(&DataKey::Config, &config);
        Ok(())
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), SlpError> {
        bump_instance(&env);
        let config = load_config(&env)?;
        config.admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        env.storage()
            .instance()
            .set(&DataKey::Version, &(CONTRACT_VERSION + 1));
        Ok(())
    }

    // ── Read helpers ─────────────────────────────────────────────────────

    pub fn get_config(env: Env) -> Result<SlpConfig, SlpError> {
        bump_instance(&env);
        load_config(&env)
    }

    pub fn total_shares(env: Env) -> i128 {
        bump_instance(&env);
        load_i128(&env, &DataKey::TotalShares)
    }

    pub fn total_assets(env: Env) -> i128 {
        bump_instance(&env);
        load_i128(&env, &DataKey::TotalAssets)
    }

    /// NAV per share in 18-decimal fixed-point. Returns PRECISION (1.0) when
    /// no shares have been issued yet (inception price = 1:1).
    pub fn nav_per_share(env: Env) -> i128 {
        bump_instance(&env);
        let shares = load_i128(&env, &DataKey::TotalShares);
        let assets = load_i128(&env, &DataKey::TotalAssets);
        if shares == 0 {
            return PRECISION; // 1:1 at inception
        }
        mul_div(assets, PRECISION, shares)
    }

    /// Unlock timestamp (seconds) for `user`. 0 means no lock set.
    pub fn unlock_at(env: Env, user: Address) -> u64 {
        bump_instance(&env);
        env.storage()
            .persistent()
            .get(&DataKey::UnlockAt(user))
            .unwrap_or(0)
    }

    // ── SEP-41 share token interface ──────────────────────────────────────

    pub fn name(_env: Env) -> String {
        String::from_str(&_env, "StellaX LP Share")
    }

    pub fn symbol(_env: Env) -> String {
        String::from_str(&_env, "sxSLP")
    }

    pub fn decimals(_env: Env) -> u32 {
        18
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        bump_instance(&env);
        load_share_balance(&env, &id)
    }

    pub fn transfer(
        env: Env,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), SlpError> {
        from.require_auth();
        if amount <= 0 {
            return Err(SlpError::InvalidAmount);
        }
        let bal = load_share_balance(&env, &from);
        if bal < amount {
            return Err(SlpError::InsufficientShares);
        }
        set_share_balance(&env, &from, bal - amount);
        let to_bal = load_share_balance(&env, &to);
        set_share_balance(&env, &to, to_bal + amount);
        bump_instance(&env);
        env.events()
            .publish((symbol_short!("transfer"), from, to), amount);
        Ok(())
    }

    pub fn approve(
        env: Env,
        from: Address,
        spender: Address,
        amount: i128,
        _expiration_ledger: u32,
    ) -> Result<(), SlpError> {
        from.require_auth();
        env.storage()
            .persistent()
            .set(&DataKey::Allowance(from.clone(), spender.clone()), &amount);
        env.storage().persistent().extend_ttl(
            &DataKey::Allowance(from.clone(), spender),
            TTL_THRESHOLD_PERSISTENT,
            TTL_BUMP_PERSISTENT,
        );
        bump_instance(&env);
        Ok(())
    }

    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        bump_instance(&env);
        env.storage()
            .persistent()
            .get(&DataKey::Allowance(from, spender))
            .unwrap_or(0)
    }

    pub fn transfer_from(
        env: Env,
        spender: Address,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), SlpError> {
        spender.require_auth();
        if amount <= 0 {
            return Err(SlpError::InvalidAmount);
        }
        let allowance_key = DataKey::Allowance(from.clone(), spender.clone());
        let allowed: i128 = env
            .storage()
            .persistent()
            .get(&allowance_key)
            .unwrap_or(0);
        if allowed < amount {
            return Err(SlpError::InsufficientAllowance);
        }
        let from_bal = load_share_balance(&env, &from);
        if from_bal < amount {
            return Err(SlpError::InsufficientShares);
        }
        env.storage()
            .persistent()
            .set(&allowance_key, &(allowed - amount));
        set_share_balance(&env, &from, from_bal - amount);
        let to_bal = load_share_balance(&env, &to);
        set_share_balance(&env, &to, to_bal + amount);
        bump_instance(&env);
        env.events()
            .publish((symbol_short!("xfer_from"), from, to), (spender, amount));
        Ok(())
    }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/// Pre-authorise `token.transfer(current_contract → to, amount)` for the next
/// sub-call. Required when the SLP vault hands tokens to another contract.
fn authorize_token_transfer(env: &Env, token_address: &Address, to: &Address, amount: i128) {
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

fn load_config(env: &Env) -> Result<SlpConfig, SlpError> {
    env.storage()
        .instance()
        .get::<DataKey, SlpConfig>(&DataKey::Config)
        .ok_or(SlpError::InvalidConfig)
}

fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_INSTANCE, TTL_BUMP_INSTANCE);
}

fn load_i128(env: &Env, key: &DataKey) -> i128 {
    env.storage()
        .instance()
        .get::<DataKey, i128>(key)
        .unwrap_or(0)
}

fn load_share_balance(env: &Env, user: &Address) -> i128 {
    env.storage()
        .persistent()
        .get::<DataKey, i128>(&DataKey::ShareBalance(user.clone()))
        .unwrap_or(0)
}

fn set_share_balance(env: &Env, user: &Address, amount: i128) {
    env.storage()
        .persistent()
        .set(&DataKey::ShareBalance(user.clone()), &amount);
    env.storage().persistent().extend_ttl(
        &DataKey::ShareBalance(user.clone()),
        TTL_THRESHOLD_PERSISTENT,
        TTL_BUMP_PERSISTENT,
    );
}

/// Mint shares proportional to `amount_internal` (18dp).
/// First depositor: 1:1 (amount_internal shares per amount_internal assets).
fn mint_shares(env: &Env, user: &Address, amount_internal: i128) -> Result<(), SlpError> {
    let total_shares = load_i128(env, &DataKey::TotalShares);
    let total_assets = load_i128(env, &DataKey::TotalAssets);

    let shares_to_mint = if total_shares == 0 || total_assets == 0 {
        amount_internal // 1:1 at inception
    } else {
        // shares = amount_internal * total_shares / total_assets
        mul_div(amount_internal, total_shares, total_assets)
    };

    if shares_to_mint <= 0 {
        return Err(SlpError::MathOverflow);
    }

    let prev_bal = load_share_balance(env, user);
    set_share_balance(env, user, prev_bal + shares_to_mint);

    env.storage()
        .instance()
        .set(&DataKey::TotalShares, &(total_shares + shares_to_mint));
    env.storage()
        .instance()
        .set(&DataKey::TotalAssets, &(total_assets + amount_internal));
    Ok(())
}

/// Burn `shares`, deduct from total_shares/total_assets, return native amount.
fn burn_shares_and_redeem(env: &Env, user: &Address, shares: i128) -> Result<i128, SlpError> {
    let total_shares = load_i128(env, &DataKey::TotalShares);
    let total_assets = load_i128(env, &DataKey::TotalAssets);

    if total_shares == 0 {
        return Err(SlpError::MathOverflow);
    }

    // underlying (18dp) = shares * total_assets / total_shares
    let underlying = mul_div(shares, total_assets, total_shares);

    let user_bal = load_share_balance(env, user);
    if user_bal < shares {
        return Err(SlpError::InsufficientShares);
    }
    set_share_balance(env, user, user_bal - shares);

    env.storage()
        .instance()
        .set(&DataKey::TotalShares, &(total_shares - shares));
    env.storage()
        .instance()
        .set(&DataKey::TotalAssets, &(total_assets - underlying));

    // Convert 18dp → 7dp native.
    let native = underlying / NATIVE_TO_INTERNAL;
    if native <= 0 {
        return Err(SlpError::InvalidAmount);
    }
    Ok(native)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    fn default_config(
        env: &Env,
        admin: &Address,
        keeper: &Address,
        vault: &Address,
        perp: &Address,
        usdc: &Address,
        treasury: &Address,
    ) -> SlpConfig {
        SlpConfig {
            admin: admin.clone(),
            keeper: keeper.clone(),
            vault_contract: vault.clone(),
            perp_engine: perp.clone(),
            usdc_token: usdc.clone(),
            treasury: treasury.clone(),
            cooldown_secs: 3_600, // 1h for tests
            skew_cap_bps: 0,      // disabled by default
            max_vault_cap: 1_000_000 * PRECISION,
            perp_market_ids: Vec::new(env),
        }
    }

    fn setup() -> (Env, Address, Address, StellaxSlpVaultClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let keeper = Address::generate(&env);
        let vault = Address::generate(&env);
        let perp = Address::generate(&env);
        let usdc = Address::generate(&env);
        let treasury = Address::generate(&env);

        let cid = env.register(StellaxSlpVault, ());
        let client = StellaxSlpVaultClient::new(&env, &cid);
        let cfg = default_config(&env, &admin, &keeper, &vault, &perp, &usdc, &treasury);
        client.initialize(&cfg);
        (env, admin, keeper, client)
    }

    // ─────────────────────────────────────────────────────────────────────
    // Initialisation
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn initialize_ok() {
        let (_env, _admin, _keeper, client) = setup();
        assert_eq!(client.version(), CONTRACT_VERSION);
    }

    #[test]
    fn double_init_fails() {
        let (env, admin, keeper, client) = setup();
        let dummy = Address::generate(&env);
        let cfg = default_config(&env, &admin, &keeper, &dummy, &dummy, &dummy, &dummy);
        let res = client.try_initialize(&cfg);
        assert!(res.is_err());
    }

    // ─────────────────────────────────────────────────────────────────────
    // NAV / share math
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn nav_per_share_is_one_at_inception() {
        let (_env, _admin, _keeper, client) = setup();
        assert_eq!(client.nav_per_share(), PRECISION);
    }

    #[test]
    fn first_depositor_gets_1_to_1_shares() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let dummy = Address::generate(&env);

        let cid = env.register(StellaxSlpVault, ());
        let client = StellaxSlpVaultClient::new(&env, &cid);
        let cfg = default_config(&env, &admin, &dummy, &dummy, &dummy, &dummy, &dummy);
        client.initialize(&cfg);

        let alice = Address::generate(&env);
        let amount_internal = 100 * PRECISION;

        env.as_contract(&cid, || {
            mint_shares(&env, &alice, amount_internal).unwrap();
        });

        assert_eq!(client.balance(&alice), amount_internal);
        assert_eq!(client.total_shares(), amount_internal);
        assert_eq!(client.total_assets(), amount_internal);
    }

    #[test]
    fn second_depositor_gets_proportional_shares_when_nav_grew() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let dummy = Address::generate(&env);

        let cid = env.register(StellaxSlpVault, ());
        let client = StellaxSlpVaultClient::new(&env, &cid);
        let cfg = default_config(&env, &admin, &dummy, &dummy, &dummy, &dummy, &dummy);
        client.initialize(&cfg);

        let alice = Address::generate(&env);
        let bob = Address::generate(&env);

        env.as_contract(&cid, || {
            // Alice deposits 100 → 100 shares at 1:1.
            mint_shares(&env, &alice, 100 * PRECISION).unwrap();
            // Simulate fee uplift: +20 in assets only (total_assets → 120).
            let ta = load_i128(&env, &DataKey::TotalAssets);
            env.storage()
                .instance()
                .set(&DataKey::TotalAssets, &(ta + 20 * PRECISION));
            // Bob deposits 100. NAV = 120/100 = 1.2 → Bob gets 100*100/120 ≈ 83.33 shares.
            mint_shares(&env, &bob, 100 * PRECISION).unwrap();
        });

        let alice_shares = client.balance(&alice);
        let bob_shares = client.balance(&bob);
        assert_eq!(alice_shares, 100 * PRECISION);
        assert!(bob_shares < alice_shares, "bob={bob_shares} alice={alice_shares}");

        let expected_bob: i128 = 83_333_333_333_333_333_333;
        let tol = PRECISION / 100;
        let diff = (bob_shares - expected_bob).abs();
        assert!(diff <= tol, "bob shares {bob_shares} not ≈ {expected_bob}");
    }

    #[test]
    fn burn_returns_correct_underlying() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let dummy = Address::generate(&env);

        let cid = env.register(StellaxSlpVault, ());
        let client = StellaxSlpVaultClient::new(&env, &cid);
        let cfg = default_config(&env, &admin, &dummy, &dummy, &dummy, &dummy, &dummy);
        client.initialize(&cfg);

        let alice = Address::generate(&env);

        // Alice deposits 1000 USDC (native 7dp = 10_000_000_000 stroops).
        let amount_native: i128 = 1_000 * 10_000_000; // 1000 USDC in 7dp
        let amount_internal = amount_native * NATIVE_TO_INTERNAL;

        env.as_contract(&cid, || {
            mint_shares(&env, &alice, amount_internal).unwrap();
        });

        // Full burn — Alice should get back the same native amount.
        let shares = client.balance(&alice);
        let native_back = env.as_contract(&cid, || {
            burn_shares_and_redeem(&env, &alice, shares).unwrap()
        });
        assert_eq!(native_back, amount_native);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Cooldown
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn cooldown_blocks_early_withdraw() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let dummy = Address::generate(&env);

        let cid = env.register(StellaxSlpVault, ());
        let client = StellaxSlpVaultClient::new(&env, &cid);
        let cfg = default_config(&env, &admin, &dummy, &dummy, &dummy, &dummy, &dummy);
        client.initialize(&cfg);

        let alice = Address::generate(&env);
        // Manually set UnlockAt to far future.
        let future_ts: u64 = env.ledger().timestamp() + 10_000;
        env.as_contract(&cid, || {
            env.storage()
                .persistent()
                .set(&DataKey::UnlockAt(alice.clone()), &future_ts);
            mint_shares(&env, &alice, 100 * PRECISION).unwrap();
        });

        // withdraw should fail with CooldownNotMet.
        let res = client.try_withdraw(&alice, &(100 * PRECISION));
        assert!(res.is_err());
        // Confirm it's the right error code.
        let err = res.unwrap_err().unwrap();
        assert_eq!(err, SlpError::CooldownNotMet);
    }

    #[test]
    fn cooldown_allows_withdraw_after_unlock() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let dummy = Address::generate(&env);

        let cid = env.register(StellaxSlpVault, ());
        let client = StellaxSlpVaultClient::new(&env, &cid);
        let cfg = default_config(&env, &admin, &dummy, &dummy, &dummy, &dummy, &dummy);
        client.initialize(&cfg);

        let alice = Address::generate(&env);
        // Set UnlockAt to past timestamp.
        let past_ts: u64 = env.ledger().timestamp().saturating_sub(1);
        env.as_contract(&cid, || {
            env.storage()
                .persistent()
                .set(&DataKey::UnlockAt(alice.clone()), &past_ts);
            mint_shares(&env, &alice, 100 * PRECISION).unwrap();
        });

        // withdraw will fail because vault.withdraw is a real cross-contract
        // call to a dummy address in unit tests, but the cooldown path passes.
        // We confirm the error is NOT CooldownNotMet.
        let res = client.try_withdraw(&alice, &(100 * PRECISION));
        match res {
            Err(Ok(SlpError::CooldownNotMet)) => panic!("should not hit cooldown"),
            _ => {} // any other error or success is fine in unit test context
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // SEP-41 share token
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn transfer_moves_balance() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let dummy = Address::generate(&env);

        let cid = env.register(StellaxSlpVault, ());
        let client = StellaxSlpVaultClient::new(&env, &cid);
        let cfg = default_config(&env, &admin, &dummy, &dummy, &dummy, &dummy, &dummy);
        client.initialize(&cfg);

        let alice = Address::generate(&env);
        let bob = Address::generate(&env);

        env.as_contract(&cid, || {
            mint_shares(&env, &alice, 100 * PRECISION).unwrap();
        });

        client.transfer(&alice, &bob, &(40 * PRECISION));
        assert_eq!(client.balance(&alice), 60 * PRECISION);
        assert_eq!(client.balance(&bob), 40 * PRECISION);
    }

    #[test]
    fn approve_and_transfer_from() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let dummy = Address::generate(&env);

        let cid = env.register(StellaxSlpVault, ());
        let client = StellaxSlpVaultClient::new(&env, &cid);
        let cfg = default_config(&env, &admin, &dummy, &dummy, &dummy, &dummy, &dummy);
        client.initialize(&cfg);

        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        let charlie = Address::generate(&env);

        env.as_contract(&cid, || {
            mint_shares(&env, &alice, 100 * PRECISION).unwrap();
        });

        client.approve(&alice, &bob, &(50 * PRECISION), &1000u32);
        assert_eq!(client.allowance(&alice, &bob), 50 * PRECISION);

        client.transfer_from(&bob, &alice, &charlie, &(30 * PRECISION));
        assert_eq!(client.balance(&alice), 70 * PRECISION);
        assert_eq!(client.balance(&charlie), 30 * PRECISION);
        assert_eq!(client.allowance(&alice, &bob), 20 * PRECISION);
    }

    #[test]
    fn transfer_from_fails_without_allowance() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let dummy = Address::generate(&env);

        let cid = env.register(StellaxSlpVault, ());
        let client = StellaxSlpVaultClient::new(&env, &cid);
        let cfg = default_config(&env, &admin, &dummy, &dummy, &dummy, &dummy, &dummy);
        client.initialize(&cfg);

        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        let charlie = Address::generate(&env);

        env.as_contract(&cid, || {
            mint_shares(&env, &alice, 100 * PRECISION).unwrap();
        });

        let res = client.try_transfer_from(&bob, &alice, &charlie, &(10 * PRECISION));
        assert!(res.is_err());
    }

    // ─────────────────────────────────────────────────────────────────────
    // Admin setters
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn set_cooldown_secs_updates_config() {
        let (_env, _admin, _keeper, client) = setup();
        client.set_cooldown_secs(&7200u64);
        let cfg = client.get_config();
        assert_eq!(cfg.cooldown_secs, 7200);
    }

    #[test]
    fn set_skew_cap_bps_updates_config() {
        let (_env, _admin, _keeper, client) = setup();
        client.set_skew_cap_bps(&8000u32);
        let cfg = client.get_config();
        assert_eq!(cfg.skew_cap_bps, 8000);
    }

    #[test]
    fn metadata_returns_expected() {
        let (_env, _admin, _keeper, client) = setup();
        assert_eq!(client.decimals(), 18u32);
        let _ = client.name();
        let _ = client.symbol();
    }
}
