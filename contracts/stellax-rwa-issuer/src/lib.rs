//! StellaX RWA Issuer — Phase M.1 (Mock Token, Real Price).
//!
//! A single-asset SEP-41-compliant fungible token contract used on Stellar
//! testnet to mock real-world assets (Franklin Templeton **BENJI**, Ondo
//! **USDY**). One contract instance per asset; deploy twice with different
//! `symbol` / `decimals` constructor inputs.
//!
//! ## What this contract is for
//! - Acts as a stand-in for the real BENJI / USDY Stellar Asset Contracts on
//!   mainnet. The on-chain code path used by the StellaX vault, perp engine,
//!   risk engine, bridge and frontend is **identical** to mainnet — only the
//!   token contract identity differs.
//! - Provides an admin-only batch `credit_yield` entry point used by the
//!   off-chain `yield-simulator` keeper to drip the **real** published APY
//!   (read from RedStone / Ondo NAV API) onto every holder's balance.
//! - Emits `RwaYieldCredited` events that the indexer aggregates into the
//!   "RWA Earnings" dashboard tile.
//!
//! ## What this contract is **not**
//! - Not a Stellar Classic Asset Contract (SAC) wrapper. It is a pure Soroban
//!   SEP-41 token, so the testnet faucet flow is one signed RPC call instead
//!   of going through Stellar Classic trustlines.
//! - Not authorisation-gated by default (no `AUTH_REQUIRED` analogue). The
//!   companion `BENJI_AUTH` / `USDY_AUTH` deployments set
//!   `auth_required = true` to exercise our error paths in integration tests.
//!
//! ## SEP-41 surface
//! All standard SEP-41 entry points are implemented: `name`, `symbol`,
//! `decimals`, `balance`, `allowance`, `approve`, `transfer`,
//! `transfer_from`, `burn`, `burn_from`. Admin-only extras: `mint`,
//! `credit_yield`, `set_admin`, `set_apy_bps`, `set_auth_required`,
//! `pause`, `unpause`, `upgrade`.
//!
//! ## Storage layout
//! - Instance: `Config` (immutable-ish admin metadata + APY + flags),
//!   `Version`.
//! - Persistent: `Balance(Address)`, `Allowance(from, spender)`,
//!   `Authorized(Address)` (only consulted when `auth_required = true`),
//!   `CumulativeYield(Address)` (lifetime yield credited, used by indexer
//!   reconciliation cron).
//!
//! All economic values are stored at the token's native decimals (6 for
//! BENJI/USDY) — **not** the 18-decimal internal precision used elsewhere.
//! Conversion to 18-decimal happens in the vault on deposit, exactly as it
//! does for USDC.

#![no_std]
#![allow(deprecated)]
#![allow(clippy::too_many_arguments)]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, BytesN, Env,
    String, Symbol, Vec,
};
use stellax_math::{
    TTL_BUMP_INSTANCE, TTL_BUMP_PERSISTENT, TTL_THRESHOLD_INSTANCE, TTL_THRESHOLD_PERSISTENT,
};

const CONTRACT_VERSION: u32 = 1;

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RwaError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    InvalidAmount = 4,
    InvalidConfig = 5,
    InsufficientBalance = 6,
    InsufficientAllowance = 7,
    Paused = 8,
    NotAuthorized = 9, // returned when auth_required=true and recipient is not whitelisted
    LengthMismatch = 10,
    MathOverflow = 11,
    Expired = 12,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IssuerConfig {
    pub admin: Address,
    pub name: String,
    pub symbol: String,
    pub decimals: u32,
    /// Annualised yield rate in basis points (e.g. 505 = 5.05% APY).
    /// Updated by the keeper from the real published issuer feed.
    pub apy_bps: u32,
    /// Set true on `BENJI_AUTH` / `USDY_AUTH` test deployments to mirror
    /// mainnet's `AUTH_REQUIRED` flag. When true, recipients must have an
    /// `Authorized(addr) = true` flag set by admin before they can receive
    /// the token.
    pub auth_required: bool,
    pub paused: bool,
    /// Total minted minus burned, in native decimals.
    pub total_supply: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AllowanceValue {
    pub amount: i128,
    pub expiration_ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum DataKey {
    Config,
    Version,
    Balance(Address),
    Allowance(Address, Address),
    Authorized(Address),
    CumulativeYield(Address),
}

#[contract]
pub struct StellaxRwaIssuer;

#[contractimpl]
impl StellaxRwaIssuer {
    pub fn __constructor(
        env: Env,
        admin: Address,
        name: String,
        symbol: String,
        decimals: u32,
        apy_bps: u32,
        auth_required: bool,
    ) -> Result<(), RwaError> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(RwaError::AlreadyInitialized);
        }
        if decimals > 18 {
            return Err(RwaError::InvalidConfig);
        }
        let cfg = IssuerConfig {
            admin,
            name,
            symbol,
            decimals,
            apy_bps,
            auth_required,
            paused: false,
            total_supply: 0,
        };
        env.storage().instance().set(&DataKey::Config, &cfg);
        env.storage()
            .instance()
            .set(&DataKey::Version, &CONTRACT_VERSION);
        bump_instance(&env);
        Ok(())
    }

    pub fn version(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Version)
            .unwrap_or(CONTRACT_VERSION)
    }

    pub fn get_config(env: Env) -> Result<IssuerConfig, RwaError> {
        bump_instance(&env);
        read_config(&env)
    }

    // ─── SEP-41 metadata ────────────────────────────────────────────────────
    pub fn name(env: Env) -> Result<String, RwaError> {
        Ok(read_config(&env)?.name)
    }
    pub fn symbol(env: Env) -> Result<String, RwaError> {
        Ok(read_config(&env)?.symbol)
    }
    pub fn decimals(env: Env) -> Result<u32, RwaError> {
        Ok(read_config(&env)?.decimals)
    }

    // ─── SEP-41 balances ────────────────────────────────────────────────────
    pub fn balance(env: Env, id: Address) -> i128 {
        bump_instance(&env);
        read_balance(&env, &id)
    }

    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        bump_instance(&env);
        match env
            .storage()
            .persistent()
            .get::<_, AllowanceValue>(&DataKey::Allowance(from, spender))
        {
            Some(v) if v.expiration_ledger >= env.ledger().sequence() => v.amount,
            _ => 0,
        }
    }

    pub fn approve(
        env: Env,
        from: Address,
        spender: Address,
        amount: i128,
        expiration_ledger: u32,
    ) -> Result<(), RwaError> {
        bump_instance(&env);
        from.require_auth();
        if amount < 0 {
            return Err(RwaError::InvalidAmount);
        }
        if amount > 0 && expiration_ledger < env.ledger().sequence() {
            return Err(RwaError::Expired);
        }
        let key = DataKey::Allowance(from.clone(), spender.clone());
        if amount == 0 {
            env.storage().persistent().remove(&key);
        } else {
            env.storage().persistent().set(
                &key,
                &AllowanceValue {
                    amount,
                    expiration_ledger,
                },
            );
            env.storage().persistent().extend_ttl(
                &key,
                TTL_THRESHOLD_PERSISTENT,
                TTL_BUMP_PERSISTENT,
            );
        }
        env.events()
            .publish((symbol_short!("approve"), from, spender), amount);
        Ok(())
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) -> Result<(), RwaError> {
        bump_instance(&env);
        from.require_auth();
        do_transfer(&env, &from, &to, amount)?;
        env.events()
            .publish((symbol_short!("transfer"), from, to), amount);
        Ok(())
    }

    pub fn transfer_from(
        env: Env,
        spender: Address,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), RwaError> {
        bump_instance(&env);
        spender.require_auth();
        spend_allowance(&env, &from, &spender, amount)?;
        do_transfer(&env, &from, &to, amount)?;
        env.events()
            .publish((symbol_short!("xfer_from"), from, to), amount);
        Ok(())
    }

    pub fn burn(env: Env, from: Address, amount: i128) -> Result<(), RwaError> {
        bump_instance(&env);
        from.require_auth();
        do_burn(&env, &from, amount)?;
        env.events().publish((symbol_short!("burn"), from), amount);
        Ok(())
    }

    pub fn burn_from(
        env: Env,
        spender: Address,
        from: Address,
        amount: i128,
    ) -> Result<(), RwaError> {
        bump_instance(&env);
        spender.require_auth();
        spend_allowance(&env, &from, &spender, amount)?;
        do_burn(&env, &from, amount)?;
        env.events()
            .publish((symbol_short!("burn_from"), from, spender), amount);
        Ok(())
    }

    // ─── Admin: mint / faucet ───────────────────────────────────────────────
    pub fn mint(env: Env, to: Address, amount: i128) -> Result<(), RwaError> {
        bump_instance(&env);
        let mut cfg = read_config(&env)?;
        cfg.admin.require_auth();
        ensure_not_paused(&cfg)?;
        if amount <= 0 {
            return Err(RwaError::InvalidAmount);
        }
        ensure_authorized_recipient(&env, &cfg, &to)?;

        let new_balance = read_balance(&env, &to)
            .checked_add(amount)
            .ok_or(RwaError::MathOverflow)?;
        write_balance(&env, &to, new_balance);
        cfg.total_supply = cfg
            .total_supply
            .checked_add(amount)
            .ok_or(RwaError::MathOverflow)?;
        env.storage().instance().set(&DataKey::Config, &cfg);
        env.events().publish((symbol_short!("mint"), to), amount);
        Ok(())
    }

    /// Batch yield drip — the heart of Phase M.4. Called by the keeper at
    /// each epoch (typically every 1 hour for snappy demos). For each pair
    /// in `(holders[i], deltas[i])`, mint `deltas[i]` of the token to
    /// `holders[i]`, increment the per-holder cumulative-yield counter, and
    /// emit a single `RwaYieldCredited` event per holder so the indexer can
    /// render the dashboard tile and the keeper can detect missed credits.
    pub fn credit_yield(
        env: Env,
        holders: Vec<Address>,
        deltas: Vec<i128>,
        epoch_id: u64,
    ) -> Result<(), RwaError> {
        bump_instance(&env);
        let mut cfg = read_config(&env)?;
        cfg.admin.require_auth();
        ensure_not_paused(&cfg)?;
        if holders.len() != deltas.len() {
            return Err(RwaError::LengthMismatch);
        }

        let mut total_minted: i128 = 0;
        for i in 0..holders.len() {
            let to = holders.get(i).unwrap();
            let amount = deltas.get(i).unwrap();
            if amount <= 0 {
                // skip zero / non-positive entries gracefully — keeper may
                // batch holders whose delta rounds to zero in this epoch.
                continue;
            }

            // For credit_yield we deliberately ignore `auth_required`: the
            // mainnet equivalent (T-bill rebase) does not require liquidator-
            // style KYC re-authorisation. Holding the token already implies
            // authorisation when auth_required=true (admin gates `mint` /
            // `transfer` upstream).
            let new_balance = read_balance(&env, &to)
                .checked_add(amount)
                .ok_or(RwaError::MathOverflow)?;
            write_balance(&env, &to, new_balance);

            let cum_key = DataKey::CumulativeYield(to.clone());
            let cum: i128 = env.storage().persistent().get(&cum_key).unwrap_or(0);
            let new_cum = cum.checked_add(amount).ok_or(RwaError::MathOverflow)?;
            env.storage().persistent().set(&cum_key, &new_cum);
            env.storage().persistent().extend_ttl(
                &cum_key,
                TTL_THRESHOLD_PERSISTENT,
                TTL_BUMP_PERSISTENT,
            );

            total_minted = total_minted
                .checked_add(amount)
                .ok_or(RwaError::MathOverflow)?;

            env.events().publish(
                (Symbol::new(&env, "yield_credit"), to),
                (amount, new_cum, epoch_id),
            );
        }

        cfg.total_supply = cfg
            .total_supply
            .checked_add(total_minted)
            .ok_or(RwaError::MathOverflow)?;
        env.storage().instance().set(&DataKey::Config, &cfg);

        env.events().publish(
            (Symbol::new(&env, "yield_epoch"), epoch_id),
            (total_minted, holders.len(), cfg.apy_bps),
        );
        Ok(())
    }

    /// Lifetime yield credited to a holder, in native token decimals.
    pub fn cumulative_yield(env: Env, holder: Address) -> i128 {
        bump_instance(&env);
        env.storage()
            .persistent()
            .get(&DataKey::CumulativeYield(holder))
            .unwrap_or(0)
    }

    // ─── Admin: configuration ───────────────────────────────────────────────
    pub fn set_apy_bps(env: Env, apy_bps: u32) -> Result<(), RwaError> {
        bump_instance(&env);
        let mut cfg = read_config(&env)?;
        cfg.admin.require_auth();
        // Sanity bound: reject anything above 50% to catch keeper bugs.
        if apy_bps > 5_000 {
            return Err(RwaError::InvalidConfig);
        }
        cfg.apy_bps = apy_bps;
        env.storage().instance().set(&DataKey::Config, &cfg);
        env.events().publish((symbol_short!("apy_set"),), apy_bps);
        Ok(())
    }

    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), RwaError> {
        bump_instance(&env);
        let mut cfg = read_config(&env)?;
        cfg.admin.require_auth();
        cfg.admin = new_admin.clone();
        env.storage().instance().set(&DataKey::Config, &cfg);
        env.events()
            .publish((symbol_short!("admin_set"),), new_admin);
        Ok(())
    }

    pub fn set_authorized(env: Env, holder: Address, ok: bool) -> Result<(), RwaError> {
        bump_instance(&env);
        let cfg = read_config(&env)?;
        cfg.admin.require_auth();
        let key = DataKey::Authorized(holder.clone());
        if ok {
            env.storage().persistent().set(&key, &true);
            env.storage().persistent().extend_ttl(
                &key,
                TTL_THRESHOLD_PERSISTENT,
                TTL_BUMP_PERSISTENT,
            );
        } else {
            env.storage().persistent().remove(&key);
        }
        env.events().publish((symbol_short!("authz"), holder), ok);
        Ok(())
    }

    pub fn set_auth_required(env: Env, required: bool) -> Result<(), RwaError> {
        bump_instance(&env);
        let mut cfg = read_config(&env)?;
        cfg.admin.require_auth();
        cfg.auth_required = required;
        env.storage().instance().set(&DataKey::Config, &cfg);
        env.events().publish((symbol_short!("authreq"),), required);
        Ok(())
    }

    pub fn pause(env: Env) -> Result<(), RwaError> {
        bump_instance(&env);
        let mut cfg = read_config(&env)?;
        cfg.admin.require_auth();
        cfg.paused = true;
        env.storage().instance().set(&DataKey::Config, &cfg);
        env.events().publish((symbol_short!("pause"),), true);
        Ok(())
    }

    pub fn unpause(env: Env) -> Result<(), RwaError> {
        bump_instance(&env);
        let mut cfg = read_config(&env)?;
        cfg.admin.require_auth();
        cfg.paused = false;
        env.storage().instance().set(&DataKey::Config, &cfg);
        env.events().publish((symbol_short!("pause"),), false);
        Ok(())
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), RwaError> {
        bump_instance(&env);
        let cfg = read_config(&env)?;
        cfg.admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        env.storage()
            .instance()
            .set(&DataKey::Version, &(CONTRACT_VERSION + 1));
        Ok(())
    }
}

// ─── Internal helpers ──────────────────────────────────────────────────────

fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_INSTANCE, TTL_BUMP_INSTANCE);
}

fn read_config(env: &Env) -> Result<IssuerConfig, RwaError> {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(RwaError::NotInitialized)
}

fn read_balance(env: &Env, id: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::Balance(id.clone()))
        .unwrap_or(0)
}

fn write_balance(env: &Env, id: &Address, amount: i128) {
    let key = DataKey::Balance(id.clone());
    if amount == 0 {
        env.storage().persistent().remove(&key);
    } else {
        env.storage().persistent().set(&key, &amount);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD_PERSISTENT, TTL_BUMP_PERSISTENT);
    }
}

fn ensure_not_paused(cfg: &IssuerConfig) -> Result<(), RwaError> {
    if cfg.paused {
        Err(RwaError::Paused)
    } else {
        Ok(())
    }
}

fn ensure_authorized_recipient(
    env: &Env,
    cfg: &IssuerConfig,
    holder: &Address,
) -> Result<(), RwaError> {
    if !cfg.auth_required {
        return Ok(());
    }
    let ok: bool = env
        .storage()
        .persistent()
        .get(&DataKey::Authorized(holder.clone()))
        .unwrap_or(false);
    if ok {
        Ok(())
    } else {
        Err(RwaError::NotAuthorized)
    }
}

fn do_transfer(env: &Env, from: &Address, to: &Address, amount: i128) -> Result<(), RwaError> {
    let cfg = read_config(env)?;
    ensure_not_paused(&cfg)?;
    if amount <= 0 {
        return Err(RwaError::InvalidAmount);
    }
    ensure_authorized_recipient(env, &cfg, to)?;
    let from_bal = read_balance(env, from);
    if from_bal < amount {
        return Err(RwaError::InsufficientBalance);
    }
    write_balance(env, from, from_bal - amount);
    let to_bal = read_balance(env, to)
        .checked_add(amount)
        .ok_or(RwaError::MathOverflow)?;
    write_balance(env, to, to_bal);
    Ok(())
}

fn do_burn(env: &Env, from: &Address, amount: i128) -> Result<(), RwaError> {
    let mut cfg = read_config(env)?;
    ensure_not_paused(&cfg)?;
    if amount <= 0 {
        return Err(RwaError::InvalidAmount);
    }
    let bal = read_balance(env, from);
    if bal < amount {
        return Err(RwaError::InsufficientBalance);
    }
    write_balance(env, from, bal - amount);
    cfg.total_supply = cfg
        .total_supply
        .checked_sub(amount)
        .ok_or(RwaError::MathOverflow)?;
    env.storage().instance().set(&DataKey::Config, &cfg);
    Ok(())
}

fn spend_allowance(
    env: &Env,
    from: &Address,
    spender: &Address,
    amount: i128,
) -> Result<(), RwaError> {
    if amount < 0 {
        return Err(RwaError::InvalidAmount);
    }
    let key = DataKey::Allowance(from.clone(), spender.clone());
    let current: AllowanceValue = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(RwaError::InsufficientAllowance)?;
    if current.expiration_ledger < env.ledger().sequence() {
        return Err(RwaError::InsufficientAllowance);
    }
    if current.amount < amount {
        return Err(RwaError::InsufficientAllowance);
    }
    let remaining = current.amount - amount;
    if remaining == 0 {
        env.storage().persistent().remove(&key);
    } else {
        env.storage().persistent().set(
            &key,
            &AllowanceValue {
                amount: remaining,
                expiration_ledger: current.expiration_ledger,
            },
        );
    }
    Ok(())
}

#[cfg(test)]
mod test;
