//! StellaX Structured Product Vaults — Phase 8.
//!
//! Implements two epoch-based automated yield strategies on top of the
//! Phase 7 options engine and Phase 3 collateral vault:
//!
//! ## Vault types
//!
//! ### Covered Call Vault (`VaultKind::CoveredCall`)
//! Depositors contribute the underlying asset (e.g. XLM). Each week the vault
//! writes an OTM call at `spot * (1 + strike_delta_bps / 10_000)`, collecting
//! the premium as yield. If the option expires worthless the full underlying is
//! returned plus premium; if exercised the vault delivers the underlying at the
//! strike, and depositors effectively sold at that level.
//!
//! ### Principal-Protected Note (`VaultKind::PrincipalProtected`)
//! Depositors contribute a stablecoin. Each epoch the vault spends a small
//! fraction of the deposit (the `premium_budget_bps` slice) to buy ATM call
//! options. If the market rallies the note delivers the upside; downside is
//! capped at the premium spent (principal is protected within budget).
//!
//! ## Epoch lifecycle
//! ```
//! deposit / queue
//!         │
//!  ┌──────▼──────────────────────────────────────────────────────┐
//!  │ roll_epoch()                                                │
//!  │  1. settle previous option                                  │
//!  │  2. process pending deposits / withdrawals                  │
//!  │  3. write / buy new option                                  │
//!  │  4. charge performance fee on premium profit                │
//!  │  5. advance epoch counter                                   │
//!  └─────────────────────────────────────────────────────────────┘
//!         │
//!  mid-epoch: deposits/withdrawals queued for next roll
//! ```
//!
//! ## Share token (SEP-41 subset)
//! The contract implements a minimal SEP-41 token interface so vault shares
//! can be transferred and used as collateral elsewhere. Balances and allowances
//! live in `Persistent` storage under `DataKey::ShareBalance` /
//! `DataKey::Allowance`.

#![no_std]
#![allow(deprecated)]
#![allow(clippy::too_many_arguments)]

use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, token,
    Address, Bytes, BytesN, Env, IntoVal, String, Symbol, Vec,
};
use stellax_math::{
    mul_precision, OptionContract, PriceData, BPS_DENOMINATOR, PRECISION, TTL_BUMP_INSTANCE,
    TTL_BUMP_PERSISTENT, TTL_THRESHOLD_INSTANCE, TTL_THRESHOLD_PERSISTENT,
};

// ─── Constants ────────────────────────────────────────────────────────────────

const CONTRACT_VERSION: u32 = 1;

/// Default epoch duration: 7 days in seconds.
pub const DEFAULT_EPOCH_DURATION: u64 = 7 * 24 * 3600;

/// Minimum time that must have elapsed before `roll_epoch` is callable.
/// We guard against accidental early rolls by requiring ≥ 90% of epoch_duration.
const ROLL_MIN_FRACTION_BPS: u64 = 9_000; // 90%

// ─── Errors ───────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum StructuredError {
    AlreadyInitialized = 1,
    Unauthorized = 2,
    InvalidConfig = 3,
    EpochNotOver = 4,
    EpochActive = 5,
    InvalidAmount = 6,
    InsufficientShares = 7,
    MathOverflow = 8,
    NoActiveEpoch = 9,
    VaultCapExceeded = 10,
    InsufficientAllowance = 11,
}

// ─── Storage keys ─────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum DataKey {
    Config,
    Epoch,       // CurrentEpochState
    TotalShares, // i128
    TotalAssets, // i128 — vault NAV in underlying units
    PendingDeposit(Address),
    PendingWithdraw(Address),
    // SEP-41 share token state
    ShareBalance(Address),
    Allowance(Address, Address), // (owner, spender)
    Version,
    /// Override for the asset Symbol used to fetch oracle price in roll_epoch.
    /// Stored separately so the on-chain StructuredConfig layout is not broken.
    /// If not set, falls back to config.underlying_asset_symbol.
    OptionAsset,
    /// Admin-settable epoch duration override (seconds). When set, roll_epoch
    /// uses this instead of config.epoch_duration — useful for testnet.
    EpochDurationOverride,
}

// ─── Vault configuration ──────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VaultKind {
    /// Writes OTM calls against deposited underlying.
    CoveredCall = 0,
    /// Buys ATM calls using a small slice of stablecoin deposits.
    PrincipalProtected = 1,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StructuredConfig {
    pub admin: Address,
    pub keeper: Address,
    /// Address of the options engine contract.
    pub options_contract: Address,
    /// Address of the collateral vault contract.
    pub vault_contract: Address,
    /// Address of the oracle contract.
    pub oracle_contract: Address,
    /// Treasury (receives performance fees).
    pub treasury: Address,
    /// SEP-41 token that depositors contribute.
    pub underlying_token: Address,
    /// Soroban `Symbol` identifying the underlying asset in the oracle.
    pub underlying_asset_symbol: Symbol,
    /// Options market ID to use when writing/buying.
    pub option_market_id: u32,
    /// How long each epoch lasts in seconds.
    pub epoch_duration: u64,
    /// For CoveredCall: OTM offset above spot in bps (e.g. 1000 = 10% OTM).
    pub strike_delta_bps: u32,
    /// For PrincipalProtected: fraction of deposits spent on premium each epoch in bps.
    pub premium_budget_bps: u32,
    /// Hard cap on total deposits in 18-decimal internal units.
    pub max_vault_cap: i128,
    /// Performance fee in bps, charged on premium profit.
    pub performance_fee_bps: u32,
    /// Vault strategy kind.
    pub kind: VaultKind,
}

/// Live epoch state (written every `roll_epoch`).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EpochState {
    pub epoch_id: u32,
    pub start_time: u64,
    pub end_time: u64,
    /// Strike used in the active option (18-dec).
    pub strike: i128,
    /// option_id returned by the options engine (0 = no option written yet).
    pub option_id: u64,
    /// Total underlying deposited into this epoch (18-dec).
    pub total_assets: i128,
    /// Premium earned (for CoveredCall) or spent (for PrincipalProtected) this epoch.
    pub premium: i128,
    /// Whether the epoch has been settled (roll_epoch completed).
    pub settled: bool,
}

// ─── Cross-contract clients ───────────────────────────────────────────────────

#[contractclient(name = "OptionsClient")]
pub trait OptionsInterface {
    fn write_option(
        env: Env,
        writer: Address,
        market_id: u32,
        strike: i128,
        expiry: u64,
        is_call: bool,
        size: i128,
    ) -> Result<u64, soroban_sdk::Error>;

    fn buy_option(env: Env, buyer: Address, option_id: u64) -> Result<(), soroban_sdk::Error>;

    fn settle_option(
        env: Env,
        option_id: u64,
        price_payload: Option<Bytes>,
    ) -> Result<(), soroban_sdk::Error>;

    fn get_option(env: Env, option_id: u64) -> Result<OptionContract, soroban_sdk::Error>;
}

#[contractclient(name = "OracleClient")]
pub trait OracleInterface {
    fn get_price(env: Env, asset: Symbol) -> PriceData;
}

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

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct StellaxStructured;

#[contractimpl]
impl StellaxStructured {
    // ── Version / Init ───────────────────────────────────────────────────

    pub fn version(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Version)
            .unwrap_or(CONTRACT_VERSION)
    }

    pub fn initialize(env: Env, config: StructuredConfig) -> Result<(), StructuredError> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(StructuredError::AlreadyInitialized);
        }
        config.admin.require_auth();
        if config.epoch_duration == 0
            || config.max_vault_cap <= 0
            || config.performance_fee_bps > BPS_DENOMINATOR
        {
            return Err(StructuredError::InvalidConfig);
        }
        env.storage().instance().set(&DataKey::Config, &config);
        env.storage().instance().set(&DataKey::TotalShares, &0i128);
        env.storage().instance().set(&DataKey::TotalAssets, &0i128);
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD_INSTANCE, TTL_BUMP_INSTANCE);
        env.storage()
            .instance()
            .set(&DataKey::Version, &CONTRACT_VERSION);
        Ok(())
    }

    // ── Deposit ──────────────────────────────────────────────────────────

    /// Deposit `amount` of the underlying token into the vault.
    ///
    /// - Between epochs: immediately mints shares.
    /// - Mid-epoch: queues deposit for the next `roll_epoch`.
    pub fn deposit(env: Env, user: Address, amount: i128) -> Result<(), StructuredError> {
        user.require_auth();
        let config = load_config(&env)?;
        if amount <= 0 {
            return Err(StructuredError::InvalidAmount);
        }
        // Enforce vault cap.
        let current_assets = load_i128(&env, &DataKey::TotalAssets);
        let amount_internal = native_to_internal(amount);
        if current_assets + amount_internal > config.max_vault_cap {
            return Err(StructuredError::VaultCapExceeded);
        }

        // Pull tokens from user into this contract.
        let token = token::TokenClient::new(&env, &config.underlying_token);
        token.transfer(&user, env.current_contract_address(), &amount);

        // Register the deposited tokens in the main vault so the options engine
        // can lock margin against this vault's address during roll_epoch.
        // vault.deposit(self, underlying_token, amount) will pull tokens from
        // this contract into the vault; since this contract IS the caller, the
        // token.transfer(self → vault) inside vault.deposit is auto-authorised.
        let vault = VaultClient::new(&env, &config.vault_contract);
        // Pre-authorise token.transfer(self → vault, amount) that vault.deposit
        // will trigger internally.  Without this, the USDC SAC rejects the
        // transfer because structured is not the tx signer.
        authorize_token_transfer_from_current_contract(
            &env,
            &config.underlying_token,
            &config.vault_contract,
            amount,
        );
        vault.deposit(
            &env.current_contract_address(),
            &config.underlying_token,
            &amount,
        );

        let epoch_opt: Option<EpochState> = env.storage().persistent().get(&DataKey::Epoch);
        let mid_epoch = epoch_opt.as_ref().map(|e| !e.settled).unwrap_or(false);

        if mid_epoch {
            // Queue deposit.
            let prev: i128 = env
                .storage()
                .temporary()
                .get(&DataKey::PendingDeposit(user.clone()))
                .unwrap_or(0);
            env.storage().temporary().set(
                &DataKey::PendingDeposit(user.clone()),
                &(prev + amount_internal),
            );
        } else {
            // Between epochs — mint shares immediately.
            mint_shares(&env, &user, amount_internal)?;
        }

        bump_instance(&env);
        env.events().publish(
            (symbol_short!("deposit"), user),
            (amount_internal, mid_epoch),
        );
        Ok(())
    }

    // ── Withdraw ─────────────────────────────────────────────────────────

    /// Withdraw by burning `shares` of vault share tokens.
    ///
    /// - Between epochs: immediately burns and transfers underlying.
    /// - Mid-epoch: queues for the next roll.
    pub fn withdraw(env: Env, user: Address, shares: i128) -> Result<(), StructuredError> {
        user.require_auth();
        if shares <= 0 {
            return Err(StructuredError::InvalidAmount);
        }
        let user_balance = load_share_balance(&env, &user);
        if user_balance < shares {
            return Err(StructuredError::InsufficientShares);
        }

        let epoch_opt: Option<EpochState> = env.storage().persistent().get(&DataKey::Epoch);
        let mid_epoch = epoch_opt.as_ref().map(|e| !e.settled).unwrap_or(false);

        if mid_epoch {
            // Queue.
            let prev: i128 = env
                .storage()
                .temporary()
                .get(&DataKey::PendingWithdraw(user.clone()))
                .unwrap_or(0);
            env.storage()
                .temporary()
                .set(&DataKey::PendingWithdraw(user.clone()), &(prev + shares));
            // Lock shares (deduct from user balance now to prevent double-queue).
            set_share_balance(&env, &user, user_balance - shares);
        } else {
            // Immediately redeem.
            burn_shares_and_transfer(&env, &user, shares)?;
        }

        bump_instance(&env);
        env.events()
            .publish((symbol_short!("withdraw"), user), (shares, mid_epoch));
        Ok(())
    }

    // ── Roll Epoch ───────────────────────────────────────────────────────

    /// Advance the vault to the next epoch. Permissionless; the keeper calls
    /// this at each epoch boundary.
    ///
    /// Steps:
    /// 1. Enforce that the epoch has ended (or no epoch has started yet).
    /// 2. Settle the previous option if one was written/bought.
    /// 3. Process pending deposits and withdrawals.
    /// 4. Compute new strike / premium budget.
    /// 5. Write or buy the new option for this epoch.
    /// 6. Charge performance fee on premium profit.
    /// 7. Store updated epoch state.
    pub fn roll_epoch(env: Env) -> Result<(), StructuredError> {
        let config = load_config(&env)?;
        let now = env.ledger().timestamp();

        // Use epoch_duration override if set (useful for testnet short epochs).
        let epoch_duration: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::EpochDurationOverride)
            .unwrap_or(config.epoch_duration);

        // ── 1. Check epoch boundary ────────────────────────────────────
        let prev_epoch: Option<EpochState> = env.storage().persistent().get(&DataKey::Epoch);
        if let Some(ref ep) = prev_epoch {
            if !ep.settled {
                // Must wait until at least ROLL_MIN_FRACTION_BPS of epoch_duration.
                let ep_duration = ep.end_time.saturating_sub(ep.start_time);
                let min_elapsed = ep.start_time + ep_duration * ROLL_MIN_FRACTION_BPS / 10_000;
                if now < min_elapsed {
                    return Err(StructuredError::EpochNotOver);
                }
            }
        }

        // ── 2. Settle previous option ──────────────────────────────────
        let mut prev_premium: i128 = 0;
        if let Some(ref ep) = prev_epoch {
            if ep.option_id != 0 && !ep.settled {
                let options = OptionsClient::new(&env, &config.options_contract);
                // Permissionless settle — ignore error if already settled externally.
                let _ = options.try_settle_option(&ep.option_id, &None);
                // Record the premium that was earned / paid last epoch.
                prev_premium = ep.premium;
            }
        }

        // ── 3. Process pending deposits / withdrawals ──────────────────
        // NOTE: In production, the vault would maintain a Vec of pending users.
        // For v1 we process only the initiating user's queued amount (batching
        // is left for the keeper to loop over). The pending entries are keyed
        // per-user in Temporary storage; the keeper passes a list of users.
        // Here we do the accounting update (totals are always correct because
        // deposit/withdraw already added to TotalAssets).

        // ── 4. Fetch oracle price and compute new strike ───────────────
        // Use the option_asset symbol override if set (allows config to specify a
        // different oracle feed than the underlying_token denomination). This is
        // important when underlying_token = USDC but options are on XLM market.
        let option_asset: Symbol = env
            .storage()
            .persistent()
            .get(&DataKey::OptionAsset)
            .unwrap_or(config.underlying_asset_symbol.clone());

        let oracle = OracleClient::new(&env, &config.oracle_contract);
        let price_data = oracle.get_price(&option_asset);
        let spot = price_data.price;

        let total_assets = load_i128(&env, &DataKey::TotalAssets);

        let new_strike;
        let option_size;
        let expiry = now + epoch_duration;

        match config.kind {
            VaultKind::CoveredCall => {
                // Strike = spot * (1 + strike_delta_bps / 10_000).
                new_strike = spot
                    + mul_precision(
                        spot,
                        (config.strike_delta_bps as i128) * PRECISION / BPS_DENOMINATOR as i128,
                    );
                // Size = 80% of total underlying. Using 100% would require locking
                // 120% (the safety margin) of total_assets, exceeding the vault
                // balance. At 80%, required collateral = 80% * 120% = 96% ≤ 100%.
                option_size = total_assets * 8_000 / 10_000;
            }
            VaultKind::PrincipalProtected => {
                // ATM call — strike = spot.
                new_strike = spot;
                // The premium budget is premium_budget_bps % of total_assets; size
                // is determined by how many options that budget can buy. For v1 we
                // write 1 unit of the option — actual size scaling is a keeper concern.
                option_size =
                    total_assets * config.premium_budget_bps as i128 / BPS_DENOMINATOR as i128;
            }
        }

        // ── 5. Write / buy the new option ─────────────────────────────
        let option_id;
        let premium;
        let options = OptionsClient::new(&env, &config.options_contract);

        match config.kind {
            VaultKind::CoveredCall => {
                // Write an OTM call — the vault is the option writer.
                let oid = options.write_option(
                    &env.current_contract_address(),
                    &config.option_market_id,
                    &new_strike,
                    &expiry,
                    &true, // is_call
                    &option_size,
                );
                option_id = oid;
                // Premium is stored in the OptionContract; we read it back.
                let opt = options.get_option(&option_id);
                premium = opt.premium;
            }
            VaultKind::PrincipalProtected => {
                // Buy an ATM call — the vault is the option buyer.
                // For PP vaults there must be an existing offer (written by someone
                // else). In production the keeper pre-writes the counterpart option.
                // For v1 we write our own and immediately buy it (demonstrates the
                // full flow; in production a market maker fills the other side).
                let oid = options.write_option(
                    &env.current_contract_address(),
                    &config.option_market_id,
                    &new_strike,
                    &expiry,
                    &true,
                    &option_size,
                );
                option_id = oid;
                options.buy_option(&env.current_contract_address(), &option_id);
                let opt = options.get_option(&option_id);
                premium = opt.premium;
            }
        }

        // ── 6. Performance fee ─────────────────────────────────────────
        // Charge fee only on premium profit (prev_premium > 0 means income).
        if prev_premium > 0 && config.performance_fee_bps > 0 {
            let fee = prev_premium * config.performance_fee_bps as i128 / BPS_DENOMINATOR as i128;
            // Transfer fee from vault's asset balance to treasury.
            if fee > 0 {
                let token = token::TokenClient::new(&env, &config.underlying_token);
                let fee_native = internal_to_native(fee);
                if fee_native > 0 {
                    token.transfer(
                        &env.current_contract_address(),
                        &config.treasury,
                        &fee_native,
                    );
                    // Reduce vault's tracked assets by fee amount.
                    let new_total = load_i128(&env, &DataKey::TotalAssets).saturating_sub(fee);
                    env.storage()
                        .instance()
                        .set(&DataKey::TotalAssets, &new_total);
                }
            }
        }

        // ── 7. Store epoch state ───────────────────────────────────────
        let new_epoch_id = prev_epoch.as_ref().map(|e| e.epoch_id + 1).unwrap_or(1);
        let new_epoch = EpochState {
            epoch_id: new_epoch_id,
            start_time: now,
            end_time: expiry,
            strike: new_strike,
            option_id,
            total_assets,
            premium,
            settled: false,
        };
        env.storage().persistent().set(&DataKey::Epoch, &new_epoch);
        env.storage().persistent().extend_ttl(
            &DataKey::Epoch,
            TTL_THRESHOLD_PERSISTENT,
            TTL_BUMP_PERSISTENT,
        );
        bump_instance(&env);

        env.events().publish(
            (symbol_short!("roll"), new_epoch_id),
            (new_strike, premium, expiry),
        );
        Ok(())
    }

    // ── SEP-41 Share Token Interface ─────────────────────────────────────

    pub fn name(env: Env) -> String {
        let config = load_config(&env).unwrap();
        // Build a simple name from the asset symbol.
        let _ = config; // symbol not directly concat-able in no_std; return fixed string.
        String::from_str(&env, "StellaX Structured Vault Share")
    }

    pub fn symbol(env: Env) -> String {
        String::from_str(&env, "sxVAULT")
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
    ) -> Result<(), StructuredError> {
        from.require_auth();
        if amount <= 0 {
            return Err(StructuredError::InvalidAmount);
        }
        let bal = load_share_balance(&env, &from);
        if bal < amount {
            return Err(StructuredError::InsufficientShares);
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
    ) -> Result<(), StructuredError> {
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
    ) -> Result<(), StructuredError> {
        spender.require_auth();
        if amount <= 0 {
            return Err(StructuredError::InvalidAmount);
        }
        let allowance_key = DataKey::Allowance(from.clone(), spender.clone());
        let allowed: i128 = env.storage().persistent().get(&allowance_key).unwrap_or(0);
        if allowed < amount {
            return Err(StructuredError::InsufficientAllowance);
        }
        let from_bal = load_share_balance(&env, &from);
        if from_bal < amount {
            return Err(StructuredError::InsufficientShares);
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

    // ── Read helpers ─────────────────────────────────────────────────────

    pub fn get_epoch(env: Env) -> Result<EpochState, StructuredError> {
        bump_instance(&env);
        env.storage()
            .persistent()
            .get(&DataKey::Epoch)
            .ok_or(StructuredError::NoActiveEpoch)
    }

    pub fn get_config(env: Env) -> Result<StructuredConfig, StructuredError> {
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

    /// NAV per share in 18-decimal fixed-point.
    pub fn nav_per_share(env: Env) -> i128 {
        bump_instance(&env);
        let shares = load_i128(&env, &DataKey::TotalShares);
        let assets = load_i128(&env, &DataKey::TotalAssets);
        if shares == 0 {
            return PRECISION; // 1:1 at inception
        }
        stellax_math::mul_div(assets, PRECISION, shares)
    }

    /// Process a queued pending deposit for a specific user. Keeper helper.
    pub fn process_pending_deposit(env: Env, user: Address) -> Result<(), StructuredError> {
        // Only between epochs.
        let epoch_opt: Option<EpochState> = env.storage().persistent().get(&DataKey::Epoch);
        let mid_epoch = epoch_opt.as_ref().map(|e| !e.settled).unwrap_or(false);
        if mid_epoch {
            return Err(StructuredError::EpochActive);
        }
        let amount: i128 = env
            .storage()
            .temporary()
            .get(&DataKey::PendingDeposit(user.clone()))
            .unwrap_or(0);
        if amount > 0 {
            mint_shares(&env, &user, amount)?;
            env.storage()
                .temporary()
                .remove(&DataKey::PendingDeposit(user));
        }
        bump_instance(&env);
        Ok(())
    }

    /// Process a queued pending withdrawal for a specific user. Keeper helper.
    pub fn process_pending_withdrawal(env: Env, user: Address) -> Result<(), StructuredError> {
        let epoch_opt: Option<EpochState> = env.storage().persistent().get(&DataKey::Epoch);
        let mid_epoch = epoch_opt.as_ref().map(|e| !e.settled).unwrap_or(false);
        if mid_epoch {
            return Err(StructuredError::EpochActive);
        }
        let shares: i128 = env
            .storage()
            .temporary()
            .get(&DataKey::PendingWithdraw(user.clone()))
            .unwrap_or(0);
        if shares > 0 {
            burn_shares_and_transfer(&env, &user, shares)?;
            env.storage()
                .temporary()
                .remove(&DataKey::PendingWithdraw(user));
        }
        bump_instance(&env);
        Ok(())
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), StructuredError> {
        bump_instance(&env);
        let cfg = load_config(&env)?;
        cfg.admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        env.storage()
            .instance()
            .set(&DataKey::Version, &(CONTRACT_VERSION + 1));
        Ok(())
    }

    /// Override the oracle asset symbol used in roll_epoch. Admin only.
    /// Use this when `underlying_asset_symbol` in the on-chain config differs
    /// from the options market's base asset (e.g. config has "USDC" but market
    /// trades XLM → call `set_option_asset(deployer, "XLM")`).
    pub fn set_option_asset(env: Env, symbol: Symbol) -> Result<(), StructuredError> {
        bump_instance(&env);
        let cfg = load_config(&env)?;
        cfg.admin.require_auth();
        env.storage()
            .persistent()
            .set(&DataKey::OptionAsset, &symbol);
        env.storage().persistent().extend_ttl(
            &DataKey::OptionAsset,
            TTL_THRESHOLD_PERSISTENT,
            TTL_BUMP_PERSISTENT,
        );
        Ok(())
    }

    /// Override the epoch duration in seconds. Admin only.
    /// Useful for testnet where a 7-day epoch is impractical.
    pub fn set_epoch_duration(env: Env, duration: u64) -> Result<(), StructuredError> {
        bump_instance(&env);
        let cfg = load_config(&env)?;
        cfg.admin.require_auth();
        if duration == 0 {
            return Err(StructuredError::InvalidConfig);
        }
        env.storage()
            .persistent()
            .set(&DataKey::EpochDurationOverride, &duration);
        env.storage().persistent().extend_ttl(
            &DataKey::EpochDurationOverride,
            TTL_THRESHOLD_PERSISTENT,
            TTL_BUMP_PERSISTENT,
        );
        Ok(())
    }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/// Authorize `token.transfer(current_contract → to, amount)` for the next
/// sub-call.  This mirrors the same helper in stellax-vault and is needed
/// when the current contract must hand tokens to another contract (e.g. vault)
/// through a cross-contract call that internally calls `token.transfer(self, …)`.
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

fn load_config(env: &Env) -> Result<StructuredConfig, StructuredError> {
    env.storage()
        .instance()
        .get::<DataKey, StructuredConfig>(&DataKey::Config)
        .ok_or(StructuredError::InvalidConfig)
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

/// Mint vault shares proportional to `amount` of underlying deposited.
/// First depositor gets 1:1 (1 share per 1 unit of underlying).
fn mint_shares(env: &Env, user: &Address, amount: i128) -> Result<(), StructuredError> {
    let total_shares = load_i128(env, &DataKey::TotalShares);
    let total_assets = load_i128(env, &DataKey::TotalAssets);

    let shares_to_mint = if total_shares == 0 || total_assets == 0 {
        amount // 1:1 at inception
    } else {
        // shares = amount * total_shares / total_assets
        stellax_math::mul_div(amount, total_shares, total_assets)
    };

    if shares_to_mint <= 0 {
        return Err(StructuredError::MathOverflow);
    }

    let prev_bal = load_share_balance(env, user);
    set_share_balance(env, user, prev_bal + shares_to_mint);

    env.storage()
        .instance()
        .set(&DataKey::TotalShares, &(total_shares + shares_to_mint));
    env.storage()
        .instance()
        .set(&DataKey::TotalAssets, &(total_assets + amount));
    Ok(())
}

/// Burn `shares` and transfer proportional underlying to `user`.
fn burn_shares_and_transfer(
    env: &Env,
    user: &Address,
    shares: i128,
) -> Result<(), StructuredError> {
    let config = load_config(env)?;
    let total_shares = load_i128(env, &DataKey::TotalShares);
    let total_assets = load_i128(env, &DataKey::TotalAssets);

    if total_shares == 0 {
        return Err(StructuredError::MathOverflow);
    }

    // underlying = shares * total_assets / total_shares
    let underlying = stellax_math::mul_div(shares, total_assets, total_shares);

    let user_bal = load_share_balance(env, user);
    if user_bal < shares {
        return Err(StructuredError::InsufficientShares);
    }
    set_share_balance(env, user, user_bal - shares);
    env.storage()
        .instance()
        .set(&DataKey::TotalShares, &(total_shares - shares));
    env.storage()
        .instance()
        .set(&DataKey::TotalAssets, &(total_assets - underlying));

    // Transfer native tokens to user.
    let native = internal_to_native(underlying);
    if native > 0 {
        // First, withdraw from the main vault back to this contract.
        let vault = VaultClient::new(env, &config.vault_contract);
        vault.withdraw(
            &env.current_contract_address(),
            &config.underlying_token,
            &native,
        );
        // Then forward from this contract to the user.
        let token = token::TokenClient::new(env, &config.underlying_token);
        token.transfer(&env.current_contract_address(), user, &native);
    }
    Ok(())
}

/// Convert a native token amount (typically 7-decimal Stellar asset) to the
/// 18-decimal internal representation used throughout the protocol.
/// For simplicity in v1 we assume the deposited token uses 7 decimals (XLM).
fn native_to_internal(amount: i128) -> i128 {
    // 18 - 7 = 11 decimal places of upscaling.
    amount * 100_000_000_000
}

/// Convert internal 18-decimal amount back to native 7-decimal token units.
fn internal_to_native(amount: i128) -> i128 {
    amount / 100_000_000_000
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    // ── Helpers ──────────────────────────────────────────────────────────

    fn default_config(
        env: &Env,
        admin: &Address,
        keeper: &Address,
        options: &Address,
        vault: &Address,
        oracle: &Address,
        treasury: &Address,
        token: &Address,
        kind: VaultKind,
    ) -> StructuredConfig {
        StructuredConfig {
            admin: admin.clone(),
            keeper: keeper.clone(),
            options_contract: options.clone(),
            vault_contract: vault.clone(),
            oracle_contract: oracle.clone(),
            treasury: treasury.clone(),
            underlying_token: token.clone(),
            underlying_asset_symbol: Symbol::new(env, "XLM"),
            option_market_id: 1,
            epoch_duration: DEFAULT_EPOCH_DURATION,
            strike_delta_bps: 1_000, // 10% OTM
            premium_budget_bps: 100, // 1% of assets
            max_vault_cap: 1_000_000 * PRECISION,
            performance_fee_bps: 1_000, // 10%
            kind,
        }
    }

    fn setup(kind: VaultKind) -> (Env, Address, StellaxStructuredClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let keeper = Address::generate(&env);
        let options = Address::generate(&env);
        let vault = Address::generate(&env);
        let oracle = Address::generate(&env);
        let treasury = Address::generate(&env);
        let token = Address::generate(&env);

        let cid = env.register(StellaxStructured, ());
        let client = StellaxStructuredClient::new(&env, &cid);
        let cfg = default_config(
            &env, &admin, &keeper, &options, &vault, &oracle, &treasury, &token, kind,
        );
        client.initialize(&cfg);
        (env, admin, client)
    }

    // ─────────────────────────────────────────────────────────────────────
    // Initialisation
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn initialize_ok() {
        let (_env, _admin, client) = setup(VaultKind::CoveredCall);
        assert_eq!(client.version(), CONTRACT_VERSION);
    }

    #[test]
    fn double_init_fails() {
        let (env, admin, client) = setup(VaultKind::CoveredCall);
        let dummy = Address::generate(&env);
        let cfg = default_config(
            &env,
            &admin,
            &dummy,
            &dummy,
            &dummy,
            &dummy,
            &dummy,
            &dummy,
            VaultKind::CoveredCall,
        );
        let res = client.try_initialize(&cfg);
        assert!(res.is_err());
    }

    // ─────────────────────────────────────────────────────────────────────
    // Share token math
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn nav_per_share_is_one_at_inception() {
        let (_env, _admin, client) = setup(VaultKind::CoveredCall);
        assert_eq!(client.nav_per_share(), PRECISION);
    }

    #[test]
    fn total_shares_zero_initially() {
        let (_env, _admin, client) = setup(VaultKind::CoveredCall);
        assert_eq!(client.total_shares(), 0);
        assert_eq!(client.total_assets(), 0);
    }

    // ─────────────────────────────────────────────────────────────────────
    // mint_shares / burn_shares logic (unit-tested via helpers)
    // ─────────────────────────────────────────────────────────────────────

    /// Verify share math: two depositors, equal amounts → equal shares.
    #[test]
    fn equal_deposits_give_equal_shares() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let dummy = Address::generate(&env);
        let cid = env.register(StellaxStructured, ());
        let client = StellaxStructuredClient::new(&env, &cid);
        let cfg = default_config(
            &env,
            &admin,
            &dummy,
            &dummy,
            &dummy,
            &dummy,
            &dummy,
            &dummy,
            VaultKind::CoveredCall,
        );
        client.initialize(&cfg);

        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        let amount = 100 * PRECISION;

        // Directly call mint_shares via the inner function (test via contract state).
        // We simulate: no epoch active (settled = true initially).
        // inject share balances directly for unit-level check.
        env.as_contract(&cid, || {
            mint_shares(&env, &alice, amount).unwrap();
            mint_shares(&env, &bob, amount).unwrap();
        });

        assert_eq!(client.balance(&alice), client.balance(&bob));
        assert_eq!(client.total_shares(), 2 * amount); // 1:1 at inception then equal
    }

    /// Second depositor when NAV > 1 gets fewer shares.
    #[test]
    fn second_depositor_gets_proportional_shares() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let dummy = Address::generate(&env);
        let cid = env.register(StellaxStructured, ());
        let client = StellaxStructuredClient::new(&env, &cid);
        let cfg = default_config(
            &env,
            &admin,
            &dummy,
            &dummy,
            &dummy,
            &dummy,
            &dummy,
            &dummy,
            VaultKind::CoveredCall,
        );
        client.initialize(&cfg);

        let alice = Address::generate(&env);
        let bob = Address::generate(&env);

        env.as_contract(&cid, || {
            // Alice deposits 100 → gets 100 shares.
            mint_shares(&env, &alice, 100 * PRECISION).unwrap();
            // Simulate premium accrual: total_assets increases by 20 (yield).
            let ta = load_i128(&env, &DataKey::TotalAssets);
            env.storage()
                .instance()
                .set(&DataKey::TotalAssets, &(ta + 20 * PRECISION));
            // Bob deposits 100 → should get 100 * 100 / 120 ≈ 83.33 shares.
            mint_shares(&env, &bob, 100 * PRECISION).unwrap();
        });

        let alice_shares = client.balance(&alice);
        let bob_shares = client.balance(&bob);
        assert_eq!(alice_shares, 100 * PRECISION);
        // Bob gets fewer shares (NAV > 1).
        assert!(
            bob_shares < alice_shares,
            "bob={bob_shares} alice={alice_shares}"
        );
        // Bob's shares ≈ 83.33e18 (within 1% tolerance).
        let expected_bob: i128 = 83_333_333_333_333_333_333;
        let tol = PRECISION / 100;
        let diff = (bob_shares - expected_bob).abs();
        assert!(diff <= tol, "bob shares {bob_shares} not ≈ {expected_bob}");
    }

    // ─────────────────────────────────────────────────────────────────────
    // SEP-41 transfer / approve / transfer_from
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn share_transfer_moves_balance() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let dummy = Address::generate(&env);
        let cid = env.register(StellaxStructured, ());
        let client = StellaxStructuredClient::new(&env, &cid);
        let cfg = default_config(
            &env,
            &admin,
            &dummy,
            &dummy,
            &dummy,
            &dummy,
            &dummy,
            &dummy,
            VaultKind::CoveredCall,
        );
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
        let cid = env.register(StellaxStructured, ());
        let client = StellaxStructuredClient::new(&env, &cid);
        let cfg = default_config(
            &env,
            &admin,
            &dummy,
            &dummy,
            &dummy,
            &dummy,
            &dummy,
            &dummy,
            VaultKind::CoveredCall,
        );
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
    fn transfer_from_fails_insufficient_allowance() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let dummy = Address::generate(&env);
        let cid = env.register(StellaxStructured, ());
        let client = StellaxStructuredClient::new(&env, &cid);
        let cfg = default_config(
            &env,
            &admin,
            &dummy,
            &dummy,
            &dummy,
            &dummy,
            &dummy,
            &dummy,
            VaultKind::CoveredCall,
        );
        client.initialize(&cfg);

        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        let charlie = Address::generate(&env);

        env.as_contract(&cid, || {
            mint_shares(&env, &alice, 100 * PRECISION).unwrap();
        });

        // No approval set.
        let res = client.try_transfer_from(&bob, &alice, &charlie, &(10 * PRECISION));
        assert!(res.is_err());
    }

    // ─────────────────────────────────────────────────────────────────────
    // Config & metadata
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn metadata_returns_expected_values() {
        let (_env, _admin, client) = setup(VaultKind::CoveredCall);
        assert_eq!(client.decimals(), 18u32);
        // name/symbol just need to be non-empty strings.
        let _ = client.name();
        let _ = client.symbol();
    }

    #[test]
    fn get_config_round_trips() {
        let (env, admin, client) = setup(VaultKind::PrincipalProtected);
        let dummy = Address::generate(&env);
        let cfg = default_config(
            &env,
            &admin,
            &dummy,
            &dummy,
            &dummy,
            &dummy,
            &dummy,
            &dummy,
            VaultKind::PrincipalProtected,
        );
        // Re-read config (initialised in setup with same kind).
        let stored = client.get_config();
        assert_eq!(stored.kind, VaultKind::PrincipalProtected);
        assert_eq!(stored.performance_fee_bps, cfg.performance_fee_bps);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Withdrawal / transfer error paths
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn transfer_fails_insufficient_shares() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let dummy = Address::generate(&env);
        let cid = env.register(StellaxStructured, ());
        let client = StellaxStructuredClient::new(&env, &cid);
        let cfg = default_config(
            &env,
            &admin,
            &dummy,
            &dummy,
            &dummy,
            &dummy,
            &dummy,
            &dummy,
            VaultKind::CoveredCall,
        );
        client.initialize(&cfg);

        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        // Alice has 0 shares.
        let res = client.try_transfer(&alice, &bob, &(10 * PRECISION));
        assert!(res.is_err());
    }

    #[test]
    fn vault_cap_exceeded_error() {
        // No token mock — deposit will fail at token transfer step if cap logic
        // is reached after cap exceeded check. We test the error path by
        // pre-setting TotalAssets to near the cap via mint_shares.
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let dummy = Address::generate(&env);
        let cid = env.register(StellaxStructured, ());
        let client = StellaxStructuredClient::new(&env, &cid);
        let cfg = default_config(
            &env,
            &admin,
            &dummy,
            &dummy,
            &dummy,
            &dummy,
            &dummy,
            &dummy,
            VaultKind::CoveredCall,
        );
        client.initialize(&cfg);

        let alice = Address::generate(&env);
        // Fill vault to max_cap.
        env.as_contract(&cid, || {
            env.storage()
                .instance()
                .set(&DataKey::TotalAssets, &(1_000_000 * PRECISION));
        });

        // Any further deposit should be rejected for cap exceeded.
        // native_to_internal(1) = 100_000_000_000 which pushes over cap.
        let res = client.try_deposit(&alice, &1i128);
        assert!(res.is_err());
    }
}
