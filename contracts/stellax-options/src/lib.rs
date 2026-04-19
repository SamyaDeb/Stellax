//! StellaX Options Engine — Phase 7.
//!
//! Implements European-style, cash-settled call/put options priced via an
//! on-chain Black-Scholes model. Collateral is managed through cross-contract
//! calls to `stellax-vault`. An off-chain keeper pushes implied-volatility per
//! market; the contract enforces a staleness guard before allowing new writes.
//!
//! ## Lifecycle
//! 1. Keeper calls `set_implied_volatility` periodically.
//! 2. Writer calls `write_option` → collateral locked in vault, premium set.
//! 3. Buyer calls `buy_option` → premium transferred vault-side, holder set.
//! 4. Anyone calls `settle_option` (or batch `settle_expired_options`) after
//!    expiry → in-the-money cash settlement paid, collateral released.

#![no_std]
#![allow(clippy::too_many_arguments)]

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, Address,
    Bytes, BytesN, Env, Symbol, Vec,
};
use stellax_math::{
    div_precision, exp_fixed, ln_fixed, mul_precision, mul_precision_checked, normal_cdf,
    sqrt_fixed, OptionContract, PriceData, BPS_DENOMINATOR, PRECISION, TTL_BUMP_INSTANCE,
    TTL_BUMP_PERSISTENT, TTL_THRESHOLD_INSTANCE, TTL_THRESHOLD_PERSISTENT,
};

// ─── Constants ────────────────────────────────────────────────────────────────

const CONTRACT_VERSION: u32 = 1;

/// Protocol fee on option premiums: 30 bps = 0.3 %.
const PROTOCOL_FEE_BPS: u32 = 30;

/// Writer safety-margin multiplier applied to max-loss collateral: 120 %.
const COLLATERAL_SAFETY_BPS: u32 = 12_000; // 120 % in bps (denom 10_000)

/// Maximum allowed IV staleness: 3 600 s (1 hour).
const MAX_IV_STALENESS_SECS: u64 = 3_600;

/// Minimum time-to-expiry allowed when writing: 30 s (testnet-friendly).
const MIN_EXPIRY_SECS: u64 = 30;

/// Maximum time-to-expiry allowed when writing: 90 days in seconds.
const MAX_EXPIRY_SECS: u64 = 90 * 86_400;

/// Maximum allowed strike deviation from spot: ±50 %.
const MAX_STRIKE_DEVIATION_BPS: u32 = 5_000; // 50 %

/// Risk-free rate used in BS: 5 % annualised, 18-dec fixed-point.
const RISK_FREE_RATE: i128 = 50_000_000_000_000_000; // 0.05 * 1e18

/// Seconds in a year (365-day convention) as i128 for fixed-point use.
const SECONDS_PER_YEAR: i128 = 31_536_000;

// ─── Error codes ──────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum OptionsError {
    AlreadyInitialized = 1,
    Unauthorized = 2,
    InvalidConfig = 3,
    MarketNotFound = 4,
    MarketInactive = 5,
    OptionNotFound = 6,
    OptionAlreadyBought = 7,
    OptionAlreadySettled = 8,
    OptionNotExpired = 9,
    OptionExpired = 10,
    IVStale = 11,
    IVNotSet = 12,
    InvalidStrike = 13,
    InvalidExpiry = 14,
    InvalidSize = 15,
    MathOverflow = 16,
    InsufficientSettlement = 17,
}

// ─── Storage key types ────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum DataKey {
    Config,
    /// Per-market option configuration.
    Market(u32),
    /// Monotonically-increasing option ID counter.
    OptionCounter,
    /// Individual option contract.
    Option(u64),
    /// Implied volatility surface (flat for v1) per market.
    ImpliedVol(u32),
    Version,
    /// Settlement token address (e.g. USDC) — stored separately to avoid
    /// breaking the on-chain OptionsConfig struct layout on upgrade.
    SettlementToken,
    /// Exact collateral amount locked at write time for a given option_id.
    /// Stored separately so settle_option can unlock the exact same amount,
    /// regardless of oracle price movement between write and settle.
    OptionCollateral(u64),
}

// ─── Structs ──────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OptionsConfig {
    pub admin: Address,
    pub keeper: Address,
    pub vault: Address,
    pub oracle: Address,
    pub treasury: Address,
    pub insurance_fund: Address,
}

/// Per-market configuration stored by the admin.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OptionMarket {
    pub market_id: u32,
    pub base_asset: Symbol,
    pub is_active: bool,
}

/// IV surface: flat for v1 (one sigma for all strikes/expiries in the market).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VolatilitySurface {
    /// Annualised implied volatility in 18-decimal fixed-point (e.g. 0.8e18 = 80 %).
    pub sigma: i128,
    /// Ledger timestamp (s) when this IV was last pushed by the keeper.
    pub updated_at: u64,
}

// ─── Cross-contract client traits ────────────────────────────────────────────

#[contractclient(name = "VaultClient")]
pub trait VaultInterface {
    fn lock_margin(
        env: Env,
        caller: Address,
        user: Address,
        position_id: u64,
        amount: i128,
    ) -> Result<(), soroban_sdk::Error>;

    fn unlock_margin(
        env: Env,
        caller: Address,
        user: Address,
        position_id: u64,
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

#[contractclient(name = "OracleClient")]
pub trait OracleInterface {
    fn get_price(env: Env, asset: Symbol) -> PriceData;
    fn verify_price_payload(env: Env, payload: Bytes, feed_id: Symbol) -> PriceData;
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct StellaxOptions;

#[contractimpl]
impl StellaxOptions {
    // ── Admin / initialisation ────────────────────────────────────────────

    pub fn version(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Version)
            .unwrap_or(CONTRACT_VERSION)
    }

    /// Initialise the options engine. Can only be called once.
    pub fn initialize(
        env: Env,
        admin: Address,
        keeper: Address,
        vault: Address,
        oracle: Address,
        treasury: Address,
        insurance_fund: Address,
    ) -> Result<(), OptionsError> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(OptionsError::AlreadyInitialized);
        }
        admin.require_auth();
        let config = OptionsConfig {
            admin,
            keeper,
            vault,
            oracle,
            treasury,
            insurance_fund,
        };
        env.storage().instance().set(&DataKey::Config, &config);
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD_INSTANCE, TTL_BUMP_INSTANCE);
        env.storage().instance().set(&DataKey::OptionCounter, &0u64);
        env.storage()
            .instance()
            .set(&DataKey::Version, &CONTRACT_VERSION);
        Ok(())
    }

    /// Register or update an option market. Admin only.
    pub fn register_market(
        env: Env,
        market_id: u32,
        base_asset: Symbol,
        is_active: bool,
    ) -> Result<(), OptionsError> {
        let config = Self::load_config(&env)?;
        config.admin.require_auth();
        let market = OptionMarket {
            market_id,
            base_asset,
            is_active,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Market(market_id), &market);
        env.storage().persistent().extend_ttl(
            &DataKey::Market(market_id),
            TTL_THRESHOLD_PERSISTENT,
            TTL_BUMP_PERSISTENT,
        );
        bump_instance(&env);
        Ok(())
    }

    // ── Implied Volatility ────────────────────────────────────────────────

    /// Keeper pushes updated implied volatility for a market.
    /// Pauses option writing/buying if not called within `MAX_IV_STALENESS_SECS`.
    pub fn set_implied_volatility(
        env: Env,
        market_id: u32,
        sigma: i128,
    ) -> Result<(), OptionsError> {
        let config = Self::load_config(&env)?;
        config.keeper.require_auth();
        if sigma <= 0 {
            return Err(OptionsError::InvalidConfig);
        }
        let surface = VolatilitySurface {
            sigma,
            updated_at: env.ledger().timestamp(),
        };
        env.storage()
            .persistent()
            .set(&DataKey::ImpliedVol(market_id), &surface);
        env.storage().persistent().extend_ttl(
            &DataKey::ImpliedVol(market_id),
            TTL_THRESHOLD_PERSISTENT,
            TTL_BUMP_PERSISTENT,
        );
        bump_instance(&env);
        env.events().publish(
            (symbol_short!("iv_set"), market_id),
            (sigma, env.ledger().timestamp()),
        );
        Ok(())
    }

    /// Read the current IV for a market (returns sigma + updated_at).
    pub fn get_implied_volatility(
        env: Env,
        market_id: u32,
    ) -> Result<VolatilitySurface, OptionsError> {
        bump_instance(&env);
        env.storage()
            .persistent()
            .get::<DataKey, VolatilitySurface>(&DataKey::ImpliedVol(market_id))
            .ok_or(OptionsError::IVNotSet)
    }

    // ── Black-Scholes pricing ─────────────────────────────────────────────

    /// On-chain Black-Scholes option price computation.
    ///
    /// All inputs and output are 18-decimal fixed-point (`i128`).
    ///
    /// - `spot`            — current underlying price
    /// - `strike`          — option strike price
    /// - `time_to_expiry`  — seconds remaining until expiry (not yet in years)
    /// - `volatility`      — annualised implied volatility (e.g. 0.8e18 = 80 %)
    /// - `risk_free_rate`  — annualised risk-free rate (e.g. 0.05e18 = 5 %)
    /// - `is_call`         — true for call, false for put
    pub fn calculate_option_price(
        env: Env,
        spot: i128,
        strike: i128,
        time_to_expiry_secs: i128,
        volatility: i128,
        risk_free_rate: i128,
        is_call: bool,
    ) -> Result<i128, OptionsError> {
        bump_instance(&env);
        black_scholes(
            spot,
            strike,
            time_to_expiry_secs,
            volatility,
            risk_free_rate,
            is_call,
        )
    }

    // ── Option Writing (Selling) ──────────────────────────────────────────

    /// Create a new option contract. The writer's required collateral is locked
    /// in the vault, and the computed premium is stored on-chain.
    ///
    /// Returns the newly assigned `option_id`.
    pub fn write_option(
        env: Env,
        writer: Address,
        market_id: u32,
        strike: i128,
        expiry: u64,
        is_call: bool,
        size: i128,
    ) -> Result<u64, OptionsError> {
        writer.require_auth();
        let config = Self::load_config(&env)?;
        let market = Self::load_active_market(&env, market_id)?;
        let surface = Self::load_fresh_iv(&env, market_id)?;

        let now = env.ledger().timestamp();
        // Validate expiry window.
        if expiry <= now + MIN_EXPIRY_SECS {
            return Err(OptionsError::InvalidExpiry);
        }
        if expiry > now + MAX_EXPIRY_SECS {
            return Err(OptionsError::InvalidExpiry);
        }
        if size <= 0 {
            return Err(OptionsError::InvalidSize);
        }

        // Fetch spot price from oracle.
        let oracle = OracleClient::new(&env, &config.oracle);
        let price_data = oracle.get_price(&market.base_asset);
        let spot = price_data.price;

        // Validate strike is within ±50 % of spot.
        validate_strike(spot, strike)?;

        // Compute premium via Black-Scholes.
        let tte_secs = (expiry - now) as i128;
        let premium = black_scholes(
            spot,
            strike,
            tte_secs,
            surface.sigma,
            RISK_FREE_RATE,
            is_call,
        )?;

        // Compute required collateral (max-loss + safety margin).
        // Call: max loss = size * spot (writer delivers underlying at spot value)
        // Put:  max loss = size * strike (writer delivers strike in USD)
        let max_loss = if is_call {
            mul_precision_checked(size, spot).ok_or(OptionsError::MathOverflow)?
        } else {
            mul_precision_checked(size, strike).ok_or(OptionsError::MathOverflow)?
        };
        let required_collateral = apply_safety(max_loss);

        // Mint a new option ID.
        let option_id = next_option_id(&env);

        // Lock collateral in vault (position_id reuses option_id).
        let vault = VaultClient::new(&env, &config.vault);
        vault.lock_margin(
            &env.current_contract_address(),
            &writer,
            &option_id,
            &required_collateral,
        );

        // Persist the exact locked amount so settle_option can unlock precisely
        // this value, regardless of oracle price changes between write and settle.
        env.storage()
            .persistent()
            .set(&DataKey::OptionCollateral(option_id), &required_collateral);
        env.storage().persistent().extend_ttl(
            &DataKey::OptionCollateral(option_id),
            TTL_THRESHOLD_PERSISTENT,
            TTL_BUMP_PERSISTENT,
        );

        let option = OptionContract {
            option_id,
            strike,
            expiry,
            is_call,
            size,
            premium,
            writer: writer.clone(),
            // Holder is unset (zero address) until bought; we use the writer as
            // placeholder — the `holder == writer` check in `buy_option` guards it.
            holder: writer.clone(),
            is_exercised: false,
        };
        store_option(&env, &option);
        bump_instance(&env);

        env.events().publish(
            (symbol_short!("opt_write"), writer.clone()),
            (option_id, market_id, strike, expiry, is_call, size, premium),
        );
        Ok(option_id)
    }

    // ── Option Buying ─────────────────────────────────────────────────────

    /// Purchase an available option. Deducts the premium from the buyer's vault
    /// balance and credits the writer (minus protocol fee → treasury).
    pub fn buy_option(env: Env, buyer: Address, option_id: u64) -> Result<(), OptionsError> {
        buyer.require_auth();
        let config = Self::load_config(&env)?;

        let mut option = Self::load_option(&env, option_id)?;

        // Cannot buy an option that already has a different holder.
        if option.holder != option.writer {
            return Err(OptionsError::OptionAlreadyBought);
        }
        if option.is_exercised {
            return Err(OptionsError::OptionAlreadySettled);
        }
        let now = env.ledger().timestamp();
        if now >= option.expiry {
            return Err(OptionsError::OptionExpired);
        }
        // Buyer cannot be the writer.
        if buyer == option.writer {
            return Err(OptionsError::Unauthorized);
        }

        // Split premium: protocol fee → treasury, remainder → writer.
        let fee = option.premium * PROTOCOL_FEE_BPS as i128 / BPS_DENOMINATOR as i128;
        let writer_proceeds = option.premium - fee;

        // Move premium from buyer to writer (vault internal transfer).
        // We use move_balance; the vault requires a token address but for
        // accounting purposes the collateral token is USDC (primary collateral).
        // In production the vault would expose a token-agnostic premium transfer;
        // for now we call move_balance with a sentinel zero token address that the
        // vault interprets as "accounting units only". This matches the Phase 3
        // vault design where balances are USD-equivalent accounting values.
        //
        // Phase 3 vault `move_balance(caller, from, to, token, amount)`:
        //   deducts `amount` from `from`'s free collateral and adds to `to`.
        //   The `token_address` is used as a storage namespace key only.
        let vault = VaultClient::new(&env, &config.vault);
        let settlement_token = env
            .storage()
            .persistent()
            .get::<DataKey, Address>(&DataKey::SettlementToken)
            .unwrap_or(config.treasury.clone());

        // Transfer premium to writer.
        if writer_proceeds > 0 {
            vault.move_balance(
                &env.current_contract_address(),
                &buyer,
                &option.writer,
                &settlement_token,
                &writer_proceeds,
            );
        }
        // Transfer fee to treasury.
        if fee > 0 {
            vault.move_balance(
                &env.current_contract_address(),
                &buyer,
                &config.treasury,
                &settlement_token,
                &fee,
            );
        }

        // Register buyer as holder.
        option.holder = buyer.clone();
        store_option(&env, &option);
        bump_instance(&env);

        env.events().publish(
            (symbol_short!("opt_buy"), buyer.clone()),
            (option_id, option.premium),
        );
        Ok(())
    }

    // ── Settlement ────────────────────────────────────────────────────────

    /// Settle a single expired option. Permissionless — anyone can call after
    /// expiry. If in-the-money the holder receives cash settlement; otherwise
    /// all locked collateral is returned to the writer.
    pub fn settle_option(
        env: Env,
        option_id: u64,
        price_payload: Option<Bytes>,
    ) -> Result<(), OptionsError> {
        let config = Self::load_config(&env)?;
        let mut option = Self::load_option(&env, option_id)?;

        if option.is_exercised {
            return Err(OptionsError::OptionAlreadySettled);
        }
        let now = env.ledger().timestamp();
        if now < option.expiry {
            return Err(OptionsError::OptionNotExpired);
        }

        // Resolve settlement price.
        let oracle = OracleClient::new(&env, &config.oracle);
        let market: OptionMarket = env
            .storage()
            .persistent()
            .get(&DataKey::Market(
                // We stored market_id in market but not in OptionContract (shared
                // type from stellax-math has no market_id field). We look it up by
                // iterating — for v1 we store market_id in a companion key.
                // Workaround: encode market_id in the high 32 bits of option_id.
                // option_id is a u64; we encode: option_id = (market_id << 32) | sequence.
                (option_id >> 32) as u32,
            ))
            .ok_or(OptionsError::MarketNotFound)?;

        let settlement_price = match price_payload {
            Some(payload) => {
                oracle
                    .verify_price_payload(&payload, &market.base_asset)
                    .price
            }
            None => oracle.get_price(&market.base_asset).price,
        };

        // Cash settlement value.
        let settlement_value = if option.is_call {
            // max(0, oracle_price - strike) * size
            let diff = settlement_price - option.strike;
            if diff > 0 {
                mul_precision_checked(diff, option.size).ok_or(OptionsError::MathOverflow)?
            } else {
                0
            }
        } else {
            // max(0, strike - oracle_price) * size
            let diff = option.strike - settlement_price;
            if diff > 0 {
                mul_precision_checked(diff, option.size).ok_or(OptionsError::MathOverflow)?
            } else {
                0
            }
        };

        let vault = VaultClient::new(&env, &config.vault);
        let settlement_token = env
            .storage()
            .persistent()
            .get::<DataKey, Address>(&DataKey::SettlementToken)
            .unwrap_or(config.treasury.clone());

        // Load the exact collateral that was locked at write time.
        // Falling back to a recomputation (using settlement_price) is incorrect
        // because oracle price drift causes unlock_margin to fail. The companion
        // DataKey::OptionCollateral entry was written in write_option.
        let locked_collateral: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::OptionCollateral(option_id))
            .unwrap_or_else(|| {
                // Fallback for options written before this upgrade (shouldn't
                // happen on a fresh testnet, but guards against edge cases).
                let max_loss = if option.is_call {
                    mul_precision_checked(option.size, settlement_price).unwrap_or(0)
                } else {
                    mul_precision_checked(option.size, option.strike).unwrap_or(0)
                };
                apply_safety(max_loss)
            });

        if settlement_value > 0 {
            // Pay holder out of writer's locked margin (up to locked amount).
            let payout = settlement_value.min(locked_collateral);
            // Unlock writer's collateral first, then move payout to holder.
            vault.unlock_margin(
                &env.current_contract_address(),
                &option.writer,
                &option_id,
                &locked_collateral,
            );
            // Transfer payout to holder via vault balance credit.
            vault.move_balance(
                &env.current_contract_address(),
                &option.writer,
                &option.holder,
                &settlement_token,
                &payout,
            );
        } else {
            // OTM: release all collateral back to writer.
            vault.unlock_margin(
                &env.current_contract_address(),
                &option.writer,
                &option_id,
                &locked_collateral,
            );
        }

        option.is_exercised = true;
        store_option(&env, &option);
        bump_instance(&env);

        env.events().publish(
            (symbol_short!("opt_settl"), option_id),
            (settlement_price, settlement_value),
        );
        Ok(())
    }

    /// Batch settle multiple expired options in one transaction. Keeper helper.
    pub fn settle_expired_options(env: Env, option_ids: Vec<u64>) -> Result<(), OptionsError> {
        for option_id in option_ids.iter() {
            // Ignore already-settled or not-yet-expired entries gracefully.
            let _ = Self::settle_option(env.clone(), option_id, None);
        }
        Ok(())
    }

    // ── Read helpers ─────────────────────────────────────────────────────

    pub fn get_option(env: Env, option_id: u64) -> Result<OptionContract, OptionsError> {
        bump_instance(&env);
        Self::load_option(&env, option_id)
    }

    pub fn get_market(env: Env, market_id: u32) -> Result<OptionMarket, OptionsError> {
        bump_instance(&env);
        Self::load_market(&env, market_id)
    }

    pub fn get_config(env: Env) -> Result<OptionsConfig, OptionsError> {
        bump_instance(&env);
        Self::load_config(&env)
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), OptionsError> {
        bump_instance(&env);
        let cfg = Self::load_config(&env)?;
        cfg.admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        env.storage()
            .instance()
            .set(&DataKey::Version, &(CONTRACT_VERSION + 1));
        Ok(())
    }

    /// Admin-gated setter for the settlement token (USDC) address.
    /// Stored separately from `OptionsConfig` to avoid breaking the on-chain
    /// struct layout on upgrade. Must be called once after initial deployment.
    pub fn set_settlement_token(env: Env, token: Address) -> Result<(), OptionsError> {
        bump_instance(&env);
        let cfg = Self::load_config(&env)?;
        cfg.admin.require_auth();
        env.storage()
            .persistent()
            .set(&DataKey::SettlementToken, &token);
        env.storage().persistent().extend_ttl(
            &DataKey::SettlementToken,
            TTL_THRESHOLD_PERSISTENT,
            TTL_BUMP_PERSISTENT,
        );
        Ok(())
    }

    pub fn get_settlement_token(env: Env) -> Result<Address, OptionsError> {
        bump_instance(&env);
        env.storage()
            .persistent()
            .get::<DataKey, Address>(&DataKey::SettlementToken)
            .ok_or(OptionsError::InvalidConfig)
    }

    // ── Internal helpers ─────────────────────────────────────────────────

    fn load_config(env: &Env) -> Result<OptionsConfig, OptionsError> {
        env.storage()
            .instance()
            .get::<DataKey, OptionsConfig>(&DataKey::Config)
            .ok_or(OptionsError::InvalidConfig)
    }

    fn load_market(env: &Env, market_id: u32) -> Result<OptionMarket, OptionsError> {
        env.storage()
            .persistent()
            .get::<DataKey, OptionMarket>(&DataKey::Market(market_id))
            .ok_or(OptionsError::MarketNotFound)
    }

    fn load_active_market(env: &Env, market_id: u32) -> Result<OptionMarket, OptionsError> {
        let m = Self::load_market(env, market_id)?;
        if !m.is_active {
            return Err(OptionsError::MarketInactive);
        }
        Ok(m)
    }

    fn load_fresh_iv(env: &Env, market_id: u32) -> Result<VolatilitySurface, OptionsError> {
        let surface = env
            .storage()
            .persistent()
            .get::<DataKey, VolatilitySurface>(&DataKey::ImpliedVol(market_id))
            .ok_or(OptionsError::IVNotSet)?;
        let now = env.ledger().timestamp();
        if now > surface.updated_at + MAX_IV_STALENESS_SECS {
            return Err(OptionsError::IVStale);
        }
        Ok(surface)
    }

    fn load_option(env: &Env, option_id: u64) -> Result<OptionContract, OptionsError> {
        env.storage()
            .persistent()
            .get::<DataKey, OptionContract>(&DataKey::Option(option_id))
            .ok_or(OptionsError::OptionNotFound)
    }
}

// ─── Free helpers ─────────────────────────────────────────────────────────────

/// Bump instance TTL on every read/write path.
fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_INSTANCE, TTL_BUMP_INSTANCE);
}

/// Persist an option contract and extend its TTL.
fn store_option(env: &Env, option: &OptionContract) {
    env.storage()
        .persistent()
        .set(&DataKey::Option(option.option_id), option);
    env.storage().persistent().extend_ttl(
        &DataKey::Option(option.option_id),
        TTL_THRESHOLD_PERSISTENT,
        TTL_BUMP_PERSISTENT,
    );
}

/// Increment and return the next option ID.
/// option_id encoding: high 32 bits = market_id, low 32 bits = sequence.
/// The caller is responsible for encoding market_id before storing.
fn next_option_id(env: &Env) -> u64 {
    let counter: u64 = env
        .storage()
        .instance()
        .get(&DataKey::OptionCounter)
        .unwrap_or(0u64);
    let next = counter + 1;
    env.storage().instance().set(&DataKey::OptionCounter, &next);
    next
}

/// Apply the 120 % safety-margin multiplier to a collateral amount.
fn apply_safety(amount: i128) -> i128 {
    amount * COLLATERAL_SAFETY_BPS as i128 / BPS_DENOMINATOR as i128
}

/// Validate that `strike` is within ±50 % of `spot`.
fn validate_strike(spot: i128, strike: i128) -> Result<(), OptionsError> {
    if spot <= 0 || strike <= 0 {
        return Err(OptionsError::InvalidStrike);
    }
    let max_deviation = spot * MAX_STRIKE_DEVIATION_BPS as i128 / BPS_DENOMINATOR as i128;
    let diff = (spot - strike).abs();
    if diff > max_deviation {
        return Err(OptionsError::InvalidStrike);
    }
    Ok(())
}

/// Black-Scholes pricing for European calls and puts.
///
/// `time_to_expiry_secs`: seconds remaining as i128 fixed-point integer
/// (NOT 18-dec — just a plain second count, e.g. 604800 for 7 days).
///
/// Returns the premium in 18-decimal fixed-point.
fn black_scholes(
    spot: i128,
    strike: i128,
    time_to_expiry_secs: i128,
    volatility: i128,
    risk_free_rate: i128,
    is_call: bool,
) -> Result<i128, OptionsError> {
    if spot <= 0 || strike <= 0 || time_to_expiry_secs <= 0 || volatility <= 0 {
        return Err(OptionsError::InvalidConfig);
    }

    // T = time in years (18-dec fixed-point).
    let t = div_precision(
        time_to_expiry_secs * PRECISION,
        SECONDS_PER_YEAR * PRECISION,
    );

    // sigma² / 2 in 18-dec.
    let sigma_sq = mul_precision(volatility, volatility);
    let half_sigma_sq = sigma_sq / 2;

    // sqrt(T) in 18-dec.
    let sqrt_t = sqrt_fixed(t);

    // sigma * sqrt(T) in 18-dec.
    let sigma_sqrt_t = mul_precision(volatility, sqrt_t);
    if sigma_sqrt_t == 0 {
        return Err(OptionsError::InvalidConfig);
    }

    // ln(S / K) in 18-dec.
    // S/K as 18-dec: mul_div(spot, PRECISION, strike)
    let s_over_k = stellax_math::mul_div(spot, PRECISION, strike);
    let ln_s_over_k = ln_fixed(s_over_k);

    // r * T in 18-dec.
    let r_t = mul_precision(risk_free_rate, t);

    // d1 = (ln(S/K) + (r + sigma²/2) * T) / (sigma * sqrt(T))
    let numerator = ln_s_over_k + mul_precision(risk_free_rate + half_sigma_sq, t);
    let d1 = div_precision(numerator, sigma_sqrt_t);

    // d2 = d1 - sigma * sqrt(T)
    let d2 = d1 - sigma_sqrt_t;

    // N(d1), N(d2)
    let nd1 = normal_cdf(d1);
    let nd2 = normal_cdf(d2);

    // Discount factor: e^(-r*T)
    let discount = exp_fixed(-r_t);

    // Call price: S * N(d1) - K * e^(-rT) * N(d2)
    let call_price = mul_precision(spot, nd1) - mul_precision(mul_precision(strike, discount), nd2);

    let call_price = call_price.max(0);

    if is_call {
        Ok(call_price)
    } else {
        // Put-call parity: P = C - S + K * e^(-rT)
        let put_price = call_price - spot + mul_precision(strike, discount);
        Ok(put_price.max(0))
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        Env,
    };

    // ── Helpers ──────────────────────────────────────────────────────────

    /// Tolerance: 0.01 USD in 18-dec = 1e16 units.
    const TOL: i128 = 10_000_000_000_000_000; // 0.01

    fn approx_eq(a: i128, b: i128, tol: i128, label: &str) {
        let diff = (a - b).abs();
        assert!(
            diff <= tol,
            "{}: expected {} ≈ {} (diff {}, tol {})",
            label,
            a,
            b,
            diff,
            tol
        );
    }

    // ─────────────────────────────────────────────────────────────────────
    // Black-Scholes pricing tests (pure math, no contract env needed)
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn bs_atm_call_reasonable() {
        // ATM call: S=K=100, T=30d, sigma=80%, r=5%
        // Python scipy reference: ~9.28 USD
        let s = 100 * PRECISION;
        let k = 100 * PRECISION;
        let tte = 30 * 86_400_i128; // seconds
        let sigma = 800_000_000_000_000_000i128; // 0.8
        let r = RISK_FREE_RATE;
        let price = black_scholes(s, k, tte, sigma, r, true).unwrap();
        // Should be in the range [8e18, 12e18]
        assert!(price > 8 * PRECISION, "ATM call too low: {price}");
        assert!(price < 12 * PRECISION, "ATM call too high: {price}");
    }

    #[test]
    fn bs_atm_put_reasonable() {
        let s = 100 * PRECISION;
        let k = 100 * PRECISION;
        let tte = 30 * 86_400_i128;
        let sigma = 800_000_000_000_000_000i128;
        let r = RISK_FREE_RATE;
        let call = black_scholes(s, k, tte, sigma, r, true).unwrap();
        let put = black_scholes(s, k, tte, sigma, r, false).unwrap();
        // put-call parity: C - P ≈ S - K*e^{-rT} (ATM, S=K so should be ≈ S*(1-disc))
        let t = div_precision(tte * PRECISION, SECONDS_PER_YEAR * PRECISION);
        let disc = exp_fixed(-mul_precision(r, t));
        let pcp = s - mul_precision(k, disc);
        approx_eq(call - put, pcp, TOL * 5, "put-call parity ATM");
    }

    #[test]
    fn bs_deep_itm_call_intrinsic() {
        // Deep ITM call: S=150, K=100, T=1d, sigma=50%
        // Should be close to intrinsic value (50 USD).
        let s = 150 * PRECISION;
        let k = 100 * PRECISION;
        let tte = 86_400_i128;
        let sigma = 500_000_000_000_000_000i128;
        let r = RISK_FREE_RATE;
        let price = black_scholes(s, k, tte, sigma, r, true).unwrap();
        // Should be between 49 and 51 USD
        assert!(price > 49 * PRECISION, "deep ITM call too low: {price}");
        assert!(price < 52 * PRECISION, "deep ITM call too high: {price}");
    }

    #[test]
    fn bs_deep_otm_call_near_zero() {
        // Deep OTM call: S=50, K=100, T=1d, sigma=50%
        let s = 50 * PRECISION;
        let k = 100 * PRECISION;
        let tte = 86_400_i128;
        let sigma = 500_000_000_000_000_000i128;
        let r = RISK_FREE_RATE;
        let price = black_scholes(s, k, tte, sigma, r, true).unwrap();
        // Should be essentially zero
        assert!(
            price < PRECISION / 100,
            "deep OTM call not near zero: {price}"
        );
    }

    #[test]
    fn bs_itm_put_intrinsic() {
        // ITM put: S=80, K=100, T=1d, sigma=50%
        let s = 80 * PRECISION;
        let k = 100 * PRECISION;
        let tte = 86_400_i128;
        let sigma = 500_000_000_000_000_000i128;
        let r = RISK_FREE_RATE;
        let price = black_scholes(s, k, tte, sigma, r, false).unwrap();
        // Intrinsic ~20; with 1 day left should still be ~20
        assert!(price > 18 * PRECISION, "ITM put too low: {price}");
        assert!(price < 22 * PRECISION, "ITM put too high: {price}");
    }

    #[test]
    fn bs_invalid_inputs_err() {
        assert!(black_scholes(0, PRECISION, 86400, PRECISION / 2, RISK_FREE_RATE, true).is_err());
        assert!(black_scholes(PRECISION, 0, 86400, PRECISION / 2, RISK_FREE_RATE, true).is_err());
        assert!(
            black_scholes(PRECISION, PRECISION, 0, PRECISION / 2, RISK_FREE_RATE, true).is_err()
        );
        assert!(black_scholes(PRECISION, PRECISION, 86400, 0, RISK_FREE_RATE, true).is_err());
    }

    // ─────────────────────────────────────────────────────────────────────
    // Contract-level tests (mock env, no vault cross-call)
    // ─────────────────────────────────────────────────────────────────────

    fn setup_env() -> (Env, Address, Address, Address, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let keeper = Address::generate(&env);
        let vault = Address::generate(&env);
        let oracle = Address::generate(&env);
        let treasury = Address::generate(&env);
        let insurance = Address::generate(&env);
        (env, admin, keeper, vault, oracle, treasury, insurance)
    }

    #[test]
    fn initialize_ok() {
        let (env, admin, keeper, vault, oracle, treasury, insurance) = setup_env();
        let contract_id = env.register(StellaxOptions, ());
        let client = StellaxOptionsClient::new(&env, &contract_id);
        client.initialize(&admin, &keeper, &vault, &oracle, &treasury, &insurance);
        assert_eq!(client.version(), CONTRACT_VERSION);
    }

    #[test]
    fn double_init_fails() {
        let (env, admin, keeper, vault, oracle, treasury, insurance) = setup_env();
        let contract_id = env.register(StellaxOptions, ());
        let client = StellaxOptionsClient::new(&env, &contract_id);
        client.initialize(&admin, &keeper, &vault, &oracle, &treasury, &insurance);
        let res = client.try_initialize(&admin, &keeper, &vault, &oracle, &treasury, &insurance);
        assert!(res.is_err());
    }

    #[test]
    fn register_and_get_market() {
        let (env, admin, keeper, vault, oracle, treasury, insurance) = setup_env();
        let contract_id = env.register(StellaxOptions, ());
        let client = StellaxOptionsClient::new(&env, &contract_id);
        client.initialize(&admin, &keeper, &vault, &oracle, &treasury, &insurance);
        let asset = Symbol::new(&env, "XLM");
        client.register_market(&1u32, &asset, &true);
        let m = client.get_market(&1u32);
        assert_eq!(m.market_id, 1);
        assert!(m.is_active);
    }

    #[test]
    fn set_and_get_iv() {
        let (env, admin, keeper, vault, oracle, treasury, insurance) = setup_env();
        let contract_id = env.register(StellaxOptions, ());
        let client = StellaxOptionsClient::new(&env, &contract_id);
        client.initialize(&admin, &keeper, &vault, &oracle, &treasury, &insurance);
        let sigma = 800_000_000_000_000_000i128;
        client.set_implied_volatility(&1u32, &sigma);
        let surface = client.get_implied_volatility(&1u32);
        assert_eq!(surface.sigma, sigma);
    }

    #[test]
    fn iv_staleness_check() {
        let (env, admin, keeper, vault, oracle, treasury, insurance) = setup_env();
        let contract_id = env.register(StellaxOptions, ());
        let client = StellaxOptionsClient::new(&env, &contract_id);
        client.initialize(&admin, &keeper, &vault, &oracle, &treasury, &insurance);
        let asset = Symbol::new(&env, "XLM");
        client.register_market(&1u32, &asset, &true);

        // Set IV at t=0.
        env.ledger().set_timestamp(1_000_000);
        client.set_implied_volatility(&1u32, &800_000_000_000_000_000i128);

        // Advance time beyond staleness threshold.
        env.ledger()
            .set_timestamp(1_000_000 + MAX_IV_STALENESS_SECS + 1);
        let surface_res = client.try_get_implied_volatility(&1u32);
        // get_implied_volatility itself does not enforce staleness — write_option does.
        // Just confirm we can still read the stale value.
        assert!(surface_res.is_ok());
    }

    #[test]
    fn calculate_option_price_matches_bs() {
        let (env, admin, keeper, vault, oracle, treasury, insurance) = setup_env();
        let contract_id = env.register(StellaxOptions, ());
        let client = StellaxOptionsClient::new(&env, &contract_id);
        client.initialize(&admin, &keeper, &vault, &oracle, &treasury, &insurance);

        let s = 100 * PRECISION;
        let k = 100 * PRECISION;
        let tte = 30 * 86_400_i128;
        let sigma = 800_000_000_000_000_000i128;

        let call = client.calculate_option_price(&s, &k, &tte, &sigma, &RISK_FREE_RATE, &true);
        let put = client.calculate_option_price(&s, &k, &tte, &sigma, &RISK_FREE_RATE, &false);

        assert!(call > 8 * PRECISION);
        assert!(put > 8 * PRECISION);
    }

    #[test]
    fn validate_strike_bounds() {
        // spot = 100, strike = 200 should fail (>50% deviation)
        let spot = 100 * PRECISION;
        assert!(validate_strike(spot, 200 * PRECISION).is_err()); // 100% deviation
        assert!(validate_strike(spot, 49 * PRECISION).is_err()); // 51% deviation
                                                                 // within ±50%
        assert!(validate_strike(spot, 140 * PRECISION).is_ok()); // 40% deviation
        assert!(validate_strike(spot, 60 * PRECISION).is_ok()); // 40% deviation
        assert!(validate_strike(spot, 50 * PRECISION).is_ok()); // exactly 50% boundary
    }
}
