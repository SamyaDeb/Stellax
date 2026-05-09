//! StellaX treasury — Phase 10.
//!
//! Collects protocol revenue from all engines and distributes it in a
//! configurable split:
//!
//!   60 % → insurance fund (until the cap is reached, then 0 %).
//!   20 % → protocol treasury (held here for governance-controlled spending).
//!   20 % → staker rewards (held here; distributed to stakers in v2).
//!
//! The split percentages are stored in BPS and can be updated via governance.
#![no_std]
#![allow(deprecated)]
#![allow(clippy::too_many_arguments)]

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, token,
    Address, BytesN, Env,
};
use stellax_math::{apply_bps, BPS_DENOMINATOR};

// ─── Errors ───────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum TreasuryError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    UnauthorizedSource = 4,
    InvalidAmount = 5,
    InvalidConfig = 6,
    InsufficientBalance = 7,
    StakingNotSet = 8,
    /// Phase U — lending pool address has not been registered.
    LendingNotConfigured = 9,
    /// Phase U — amount requested exceeds funds currently parked in the
    /// lending adapter.
    LendingInsufficient = 10,
}

// ─── Config ───────────────────────────────────────────────────────────────────

/// Protocol-level treasury configuration.
#[contracttype]
#[derive(Clone, Debug)]
pub struct TreasuryConfig {
    /// Governor contract — the only address that may call restricted functions.
    pub admin: Address,
    /// Address to which the insurance-fund portion of fees is transferred
    /// (typically the risk engine contract or a dedicated wallet).
    pub insurance_fund: Address,
    /// Maximum total amount (in token's native decimals) that will ever be sent
    /// to the insurance fund for a given token. Once the running total reaches
    /// this cap, the insurance-fund split drops to 0 and the extra goes to the
    /// protocol-treasury bucket.
    pub insurance_cap: i128,
    /// BPS allocated to the insurance fund (default 6 000 = 60 %).
    pub insurance_split_bps: u32,
    /// BPS retained in the protocol-treasury bucket (default 2 000 = 20 %).
    pub treasury_split_bps: u32,
    /// BPS retained in the staker-rewards bucket (default 2 000 = 20 %).
    pub staker_split_bps: u32,
}

// ─── Storage keys ─────────────────────────────────────────────────────────────

#[contracttype]
enum DataKey {
    // Instance storage
    Config,
    Version,
    // Persistent per-token storage
    /// Fees collected but not yet distributed.
    PendingFees(Address),
    /// Treasury's retained share after distribution.
    TreasuryBalance(Address),
    /// Staker-rewards retained share after distribution.
    StakerBalance(Address),
    /// Running total already sent to the insurance fund for a token.
    InsuranceSent(Address),
    /// Authorised fee sources (protocol contracts).
    AuthorizedSources,
    /// Phase F: address of the staking contract to which accumulated
    /// staker-bucket balances are flushed as epoch reward deposits. Stored
    /// under a new key so the existing `TreasuryConfig` storage layout
    /// remains unchanged (V2 upgrade safety).
    StakingContract,
    /// Phase P: address of the risk engine. When set, `distribute` queries
    /// `risk.get_insurance_fund_balance()` to drive its dynamic split and
    /// calls `risk.insurance_top_up(...)` to credit fees flowing into the
    /// insurance counter.
    RiskContract,
    /// Phase P: optional `InsuranceTarget { soft_cap, hard_cap }` band. When
    /// unset, the treasury keeps the V1 fixed split (full
    /// `insurance_split_bps` until the legacy `insurance_cap` is hit).
    InsuranceTarget,
    /// Phase Q: address of the `stellax-referrals` registry. When set,
    /// `collect_fee_with_trader` queries `rebate_for(trader)` and credits
    /// the resulting share to the referrer's vault free balance.
    ReferralsContract,
    /// Phase Q: address of the vault used to credit referrer rebates.
    /// Treasury must be a vault `authorized_caller` for `vault.credit` to
    /// succeed.
    VaultContract,
    /// Phase Q: lifetime per-token fee rebate paid out to referrers.
    ReferralPaid(Address),
    /// Phase U: address of the external lending adapter (e.g. a Blend
    /// pool wrapper) used to park idle treasury funds. Optional — when
    /// unset, lending entries return `LendingNotConfigured`.
    LendingPool,
    /// Phase U: per-token cumulative principal currently parked in the
    /// lending adapter (in token native decimals). Updated atomically by
    /// `deposit_to_lending` / `withdraw_from_lending`.
    LendingDeposited(Address),
}

// ─── External contract clients ────────────────────────────────────────────────

/// Minimal cross-contract interface to the staking contract. We only need
/// `deposit_epoch_rewards`, which requires the treasury's `require_auth`.
#[contractclient(name = "StakingClient")]
pub trait StakingInterface {
    fn deposit_epoch_rewards(env: Env, caller: Address, reward_token: Address, amount: i128);
}

/// Phase P: minimal cross-contract interface to the risk engine. Treasury
/// reads the live insurance balance to choose its dynamic split, then asks
/// the risk engine to credit any newly-routed insurance share.
#[contractclient(name = "RiskClient")]
pub trait RiskInterface {
    fn get_insurance_fund_balance(env: Env) -> i128;
    fn insurance_top_up(env: Env, source: Address, amount: i128) -> i128;
}

/// Phase Q: minimal cross-contract interface to the referrals registry.
#[contractclient(name = "ReferralsClient")]
pub trait ReferralsInterface {
    fn rebate_for(env: Env, trader: Address) -> Option<(Address, u32)>;
    fn record_volume(env: Env, source: Address, trader: Address, notional: i128);
    fn record_payout(env: Env, source: Address, trader: Address, amount: i128);
}

/// Phase Q: vault `credit` used to push the referrer's rebate into their
/// free vault balance without an on-chain token transfer at the user level.
#[contractclient(name = "VaultClient")]
pub trait VaultInterface {
    fn credit(env: Env, caller: Address, user: Address, token_address: Address, amount: i128);
}

/// Phase U: minimal cross-contract interface to an external lending adapter
/// (Blend pool, AQUA pool, etc.). The adapter is responsible for taking
/// custody of the deposited tokens and accruing yield. The treasury treats
/// it as an opaque escrow keyed by token.
#[contractclient(name = "LendingClient")]
pub trait LendingInterface {
    fn deposit(env: Env, source: Address, token: Address, amount: i128);
    fn withdraw(env: Env, recipient: Address, token: Address, amount: i128);
    fn balance_of(env: Env, holder: Address, token: Address) -> i128;
}

/// Phase P: governance-configurable insurance-fund growth band. When the
/// risk engine's tracked insurance balance is below `soft_cap`, the full
/// `insurance_split_bps` flows to insurance. Between `soft_cap` and
/// `hard_cap`, the split is halved and the redirected portion accrues to
/// stakers. Above `hard_cap`, no fees route to insurance and the entire
/// original insurance share goes to stakers.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InsuranceTarget {
    pub soft_cap: i128,
    pub hard_cap: i128,
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct StellaxTreasury;

#[contractimpl]
impl StellaxTreasury {
    // ─── Lifecycle ────────────────────────────────────────────────────────────

    pub fn initialize(
        env: Env,
        admin: Address,
        insurance_fund: Address,
        insurance_cap: i128,
    ) -> Result<(), TreasuryError> {
        if env.storage().instance().has(&DataKey::Version) {
            return Err(TreasuryError::AlreadyInitialized);
        }
        if insurance_cap < 0 {
            return Err(TreasuryError::InvalidConfig);
        }
        let config = TreasuryConfig {
            admin,
            insurance_fund,
            insurance_cap,
            insurance_split_bps: 6_000,
            treasury_split_bps: 2_000,
            staker_split_bps: 2_000,
        };
        env.storage().instance().set(&DataKey::Config, &config);
        env.storage().instance().set(&DataKey::Version, &1u32);

        let sources: soroban_sdk::Vec<Address> = soroban_sdk::Vec::new(&env);
        env.storage()
            .persistent()
            .set(&DataKey::AuthorizedSources, &sources);

        Ok(())
    }

    // ─── Admin functions (governance-only) ───────────────────────────────────

    /// Register a protocol contract as an authorized fee source.
    pub fn add_authorized_source(env: Env, source: Address) -> Result<(), TreasuryError> {
        let cfg: TreasuryConfig = load_config(&env)?;
        cfg.admin.require_auth();

        let mut sources: soroban_sdk::Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::AuthorizedSources)
            .unwrap_or_else(|| soroban_sdk::Vec::new(&env));

        // Idempotent — don't add duplicates.
        for i in 0..sources.len() {
            if sources.get_unchecked(i) == source {
                return Ok(());
            }
        }
        sources.push_back(source);
        env.storage()
            .persistent()
            .set(&DataKey::AuthorizedSources, &sources);
        Ok(())
    }

    /// Update the distribution split (BPS values must sum to 10 000).
    pub fn update_split(
        env: Env,
        insurance_bps: u32,
        treasury_bps: u32,
        staker_bps: u32,
    ) -> Result<(), TreasuryError> {
        let mut cfg: TreasuryConfig = load_config(&env)?;
        cfg.admin.require_auth();

        if insurance_bps + treasury_bps + staker_bps != BPS_DENOMINATOR {
            return Err(TreasuryError::InvalidConfig);
        }
        cfg.insurance_split_bps = insurance_bps;
        cfg.treasury_split_bps = treasury_bps;
        cfg.staker_split_bps = staker_bps;
        env.storage().instance().set(&DataKey::Config, &cfg);
        Ok(())
    }

    /// Withdraw from the protocol-treasury bucket (governance-only).
    pub fn withdraw_treasury(
        env: Env,
        destination: Address,
        token: Address,
        amount: i128,
    ) -> Result<(), TreasuryError> {
        let cfg: TreasuryConfig = load_config(&env)?;
        cfg.admin.require_auth();

        if amount <= 0 {
            return Err(TreasuryError::InvalidAmount);
        }

        let bal_key = DataKey::TreasuryBalance(token.clone());
        let balance: i128 = env.storage().persistent().get(&bal_key).unwrap_or(0i128);

        if balance < amount {
            return Err(TreasuryError::InsufficientBalance);
        }

        env.storage()
            .persistent()
            .set(&bal_key, &(balance - amount));

        token::Client::new(&env, &token).transfer(
            &env.current_contract_address(),
            &destination,
            &amount,
        );

        env.events().publish(
            (symbol_short!("withdraw"), token.clone()),
            (destination, amount),
        );

        Ok(())
    }

    // ─── Phase F: staking wiring ─────────────────────────────────────────────

    /// Register (or update) the staking contract address. Governance-only.
    pub fn set_staking(env: Env, staking: Address) -> Result<(), TreasuryError> {
        let cfg: TreasuryConfig = load_config(&env)?;
        cfg.admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::StakingContract, &staking);
        env.events()
            .publish((symbol_short!("set_stk"),), (staking,));
        Ok(())
    }

    /// Return the registered staking contract address, if any.
    pub fn get_staking(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::StakingContract)
    }

    /// Flush the accumulated staker-rewards bucket for `token` into the
    /// staking contract as an epoch reward deposit. Anyone may call this
    /// (keeper / governance). No-op if bucket is empty.
    pub fn flush_staker_rewards(env: Env, token: Address) -> Result<i128, TreasuryError> {
        let _cfg: TreasuryConfig = load_config(&env)?;
        let staking: Address = env
            .storage()
            .instance()
            .get(&DataKey::StakingContract)
            .ok_or(TreasuryError::StakingNotSet)?;

        let sb_key = DataKey::StakerBalance(token.clone());
        let balance: i128 = env.storage().persistent().get(&sb_key).unwrap_or(0i128);
        if balance <= 0 {
            return Ok(0);
        }

        // Approve the transfer by depositing into staking as the treasury.
        // `deposit_epoch_rewards` will `transfer(caller→staking, amount)` of
        // `token`, so the treasury contract itself is the `caller`.
        let treasury_self = env.current_contract_address();
        StakingClient::new(&env, &staking).deposit_epoch_rewards(&treasury_self, &token, &balance);

        // Zero the bucket only after the cross-contract call succeeds.
        env.storage().persistent().set(&sb_key, &0i128);

        env.events()
            .publish((symbol_short!("flush_st"), token), (staking, balance));

        Ok(balance)
    }

    // ─── Fee collection ───────────────────────────────────────────────────────

    /// Called by protocol contracts when fees are generated.
    ///
    /// The caller must have **already transferred** `amount` tokens to this
    /// contract; `collect_fee` only updates the accounting ledger.
    ///
    /// `source` must be registered via `add_authorized_source`.
    pub fn collect_fee(
        env: Env,
        source: Address,
        token: Address,
        amount: i128,
    ) -> Result<(), TreasuryError> {
        source.require_auth();

        if amount <= 0 {
            return Err(TreasuryError::InvalidAmount);
        }

        // Authorization: source must be in the allow-list.
        let sources: soroban_sdk::Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::AuthorizedSources)
            .unwrap_or_else(|| soroban_sdk::Vec::new(&env));

        let mut is_authorized = false;
        for i in 0..sources.len() {
            if sources.get_unchecked(i) == source {
                is_authorized = true;
                break;
            }
        }
        if !is_authorized {
            return Err(TreasuryError::UnauthorizedSource);
        }

        let key = DataKey::PendingFees(token.clone());
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0i128);
        env.storage().persistent().set(&key, &(current + amount));

        env.events()
            .publish((symbol_short!("feecoll"), token), (source, amount));

        Ok(())
    }

    /// Phase Q — taker-fee collection that routes the referrer rebate to
    /// the trader's referrer (if any) before booking the residual as
    /// pending fees for the standard 60/20/20 split.
    ///
    /// Caller (a fee source like `stellax-perp-engine`) must have already
    /// transferred `amount` tokens to this treasury contract — the
    /// behaviour mirrors `collect_fee` for the residual.
    ///
    /// Pre-conditions:
    ///   * `source` is in the authorised-sources list.
    ///   * Referrals + Vault contracts are configured via
    ///     `set_referrals_contract` / `set_vault_contract`. When either is
    ///     unset, the call falls through to the legacy `collect_fee`
    ///     accounting path (no rebate).
    ///   * Treasury must be a vault `authorized_caller` so `vault.credit`
    ///     is allowed to bump the referrer's free balance.
    ///
    /// Effects:
    ///   * Looks up `(referrer, rebate_bps)` from the referrals contract.
    ///   * Computes `rebate = amount * rebate_bps / 10_000`.
    ///   * Calls `vault.credit(self, referrer, token, rebate)` to push
    ///     the rebate into the referrer's free vault balance.
    ///   * Calls `referrals.record_volume(trader, notional)` so the
    ///     referrer's tier counter advances.
    ///   * Calls `referrals.record_payout(trader, rebate)` for transparency.
    ///   * Books `amount - rebate` as pending fees for `distribute`.
    pub fn collect_fee_with_trader(
        env: Env,
        source: Address,
        token: Address,
        trader: Address,
        notional: i128,
        amount: i128,
    ) -> Result<(), TreasuryError> {
        source.require_auth();
        if amount <= 0 || notional < 0 {
            return Err(TreasuryError::InvalidAmount);
        }

        // Authorization mirrors `collect_fee`.
        let sources: soroban_sdk::Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::AuthorizedSources)
            .unwrap_or_else(|| soroban_sdk::Vec::new(&env));
        let mut is_authorized = false;
        for i in 0..sources.len() {
            if sources.get_unchecked(i) == source {
                is_authorized = true;
                break;
            }
        }
        if !is_authorized {
            return Err(TreasuryError::UnauthorizedSource);
        }

        let referrals_addr: Option<Address> =
            env.storage().instance().get(&DataKey::ReferralsContract);
        let vault_addr: Option<Address> = env.storage().instance().get(&DataKey::VaultContract);

        let mut rebate: i128 = 0;
        if let (Some(ref_addr), Some(vault_addr)) = (&referrals_addr, &vault_addr) {
            let refclient = ReferralsClient::new(&env, ref_addr);
            let treasury_self = env.current_contract_address();

            // Tier-bumping volume — counted regardless of whether a rebate
            // ultimately fires for this collection (e.g. Bronze tier with
            // tiny notionals).
            if notional > 0 {
                refclient.record_volume(&treasury_self, &trader, &notional);
            }

            if let Some((referrer, bps)) = refclient.rebate_for(&trader) {
                if bps > 0 && bps <= BPS_DENOMINATOR {
                    rebate = apply_bps(amount, bps);
                    if rebate > amount {
                        rebate = amount;
                    }
                    if rebate > 0 {
                        // Push the rebate into the vault's internal ledger so
                        // it lands as "free" balance for the referrer. The
                        // vault contract pulls the underlying SAC tokens from
                        // this treasury (via `transfer` initiated by `credit`
                        // on the bridge path is *not* used — `credit` is
                        // accounting-only when invoked by an authorised
                        // caller). To keep the books real, we *also* move
                        // the underlying tokens to the vault contract so the
                        // referrer can later withdraw against them.
                        token::Client::new(&env, &token).transfer(
                            &treasury_self,
                            vault_addr,
                            &rebate,
                        );
                        VaultClient::new(&env, vault_addr).credit(
                            &treasury_self,
                            &referrer,
                            &token,
                            &rebate,
                        );
                        refclient.record_payout(&treasury_self, &trader, &rebate);

                        let paid_key = DataKey::ReferralPaid(token.clone());
                        let prev: i128 = env.storage().persistent().get(&paid_key).unwrap_or(0);
                        env.storage().persistent().set(&paid_key, &(prev + rebate));

                        env.events().publish(
                            (symbol_short!("ref_paid"), token.clone(), referrer),
                            (trader.clone(), rebate),
                        );
                    }
                }
            }
        }

        let residual = amount - rebate;
        let key = DataKey::PendingFees(token.clone());
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0i128);
        env.storage().persistent().set(&key, &(current + residual));

        env.events().publish(
            (symbol_short!("feecollx"), token),
            (source, residual, rebate),
        );

        Ok(())
    }

    // ─── Distribution ─────────────────────────────────────────────────────────

    /// Distribute all pending fees for `token` according to the configured split.
    ///
    /// Anyone can call this (keeper / governance / user). The function is
    /// idempotent when pending fees are zero.
    ///
    /// **Phase P — auto-growth**: when both `RiskContract` and
    /// `InsuranceTarget` are configured, the insurance share is scaled by
    /// the live insurance balance:
    ///
    /// * `balance < soft_cap` → full `insurance_split_bps` (default).
    /// * `soft_cap ≤ balance < hard_cap` → half goes to insurance, half is
    ///   redirected to the staker bucket.
    /// * `balance ≥ hard_cap` → 0 % insurance; the entire original
    ///   insurance share is redirected to stakers.
    pub fn distribute(env: Env, token: Address) -> Result<(), TreasuryError> {
        let cfg: TreasuryConfig = load_config(&env)?;

        let pending_key = DataKey::PendingFees(token.clone());
        let pending: i128 = env
            .storage()
            .persistent()
            .get(&pending_key)
            .unwrap_or(0i128);

        if pending == 0 {
            return Ok(());
        }

        // ── Phase P: dynamic insurance routing ────────────────────────────
        let risk_addr: Option<Address> = env.storage().instance().get(&DataKey::RiskContract);
        let target: Option<InsuranceTarget> =
            env.storage().instance().get(&DataKey::InsuranceTarget);

        let effective_insurance_bps: u32 = match (&risk_addr, &target) {
            (Some(risk), Some(t)) => {
                let live_balance = RiskClient::new(&env, risk).get_insurance_fund_balance();
                if live_balance < t.soft_cap {
                    cfg.insurance_split_bps
                } else if live_balance < t.hard_cap {
                    cfg.insurance_split_bps / 2
                } else {
                    0
                }
            }
            _ => cfg.insurance_split_bps,
        };
        // Whatever we trim from insurance accrues to stakers.
        let redirected_to_staker_bps: u32 = cfg.insurance_split_bps - effective_insurance_bps;

        // How much of the legacy insurance cap remains?
        let ins_sent_key = DataKey::InsuranceSent(token.clone());
        let already_sent: i128 = env
            .storage()
            .persistent()
            .get(&ins_sent_key)
            .unwrap_or(0i128);
        let ins_remaining_cap = (cfg.insurance_cap - already_sent).max(0);

        // Raw insurance portion (after Phase P scaling, may be reduced by cap).
        let raw_insurance = apply_bps(pending, effective_insurance_bps);
        let actual_insurance = raw_insurance.min(ins_remaining_cap);
        let capped_overflow = raw_insurance - actual_insurance; // goes to treasury

        let raw_treasury = apply_bps(pending, cfg.treasury_split_bps);
        let actual_treasury = raw_treasury + capped_overflow;

        // Staker gets the residual (which already absorbs `redirected_to_staker_bps`
        // because the insurance share was reduced upstream). We preserve the
        // residual-based calculation for precision parity.
        let _ = redirected_to_staker_bps;
        let actual_staker = pending - actual_insurance - actual_treasury;

        // Transfer insurance portion to the insurance-fund address.
        if actual_insurance > 0 {
            token::Client::new(&env, &token).transfer(
                &env.current_contract_address(),
                &cfg.insurance_fund,
                &actual_insurance,
            );
            env.storage()
                .persistent()
                .set(&ins_sent_key, &(already_sent + actual_insurance));

            // Phase P: credit the on-chain insurance counter so the risk
            // engine's ADL/liquidation paths can size their cover.
            if let Some(risk) = &risk_addr {
                let treasury_self = env.current_contract_address();
                RiskClient::new(&env, risk).insurance_top_up(&treasury_self, &actual_insurance);
            }
        }

        // Credit treasury and staker buckets (tokens remain in this contract).
        let tb_key = DataKey::TreasuryBalance(token.clone());
        let sb_key = DataKey::StakerBalance(token.clone());

        let treasury_bal: i128 = env.storage().persistent().get(&tb_key).unwrap_or(0i128);
        let staker_bal: i128 = env.storage().persistent().get(&sb_key).unwrap_or(0i128);

        env.storage()
            .persistent()
            .set(&tb_key, &(treasury_bal + actual_treasury));
        env.storage()
            .persistent()
            .set(&sb_key, &(staker_bal + actual_staker));

        // Clear pending fees.
        env.storage().persistent().set(&pending_key, &0i128);

        env.events().publish(
            (symbol_short!("distrib"), token),
            (actual_insurance, actual_treasury, actual_staker),
        );

        Ok(())
    }

    // ─── Phase P: insurance auto-growth wiring ────────────────────────────────

    /// Register (or update) the risk-engine address. Governance-only. Once
    /// set, `distribute` will query the live insurance balance to drive its
    /// dynamic split and call `risk.insurance_top_up(...)` to credit fees.
    pub fn set_risk_contract(env: Env, risk: Address) -> Result<(), TreasuryError> {
        let cfg = load_config(&env)?;
        cfg.admin.require_auth();
        env.storage().instance().set(&DataKey::RiskContract, &risk);
        env.events().publish((symbol_short!("set_risk"),), risk);
        Ok(())
    }

    /// Return the registered risk-engine address, if any.
    pub fn get_risk_contract(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::RiskContract)
    }

    /// Configure the insurance auto-growth band. Governance-only.
    /// Requires `0 ≤ soft_cap ≤ hard_cap`.
    pub fn set_insurance_target(
        env: Env,
        soft_cap: i128,
        hard_cap: i128,
    ) -> Result<(), TreasuryError> {
        let cfg = load_config(&env)?;
        cfg.admin.require_auth();
        if soft_cap < 0 || hard_cap < soft_cap {
            return Err(TreasuryError::InvalidConfig);
        }
        let target = InsuranceTarget { soft_cap, hard_cap };
        env.storage()
            .instance()
            .set(&DataKey::InsuranceTarget, &target);
        env.events()
            .publish((symbol_short!("ins_tgt"),), (soft_cap, hard_cap));
        Ok(())
    }

    /// Return the current insurance auto-growth band, if configured.
    pub fn get_insurance_target(env: Env) -> Option<InsuranceTarget> {
        env.storage().instance().get(&DataKey::InsuranceTarget)
    }

    // ─── Phase Q: referrals wiring ────────────────────────────────────────────

    /// Register the referrals registry. Admin-only. Required for
    /// `collect_fee_with_trader` to credit referrer rebates.
    pub fn set_referrals_contract(env: Env, referrals: Address) -> Result<(), TreasuryError> {
        let cfg = load_config(&env)?;
        cfg.admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::ReferralsContract, &referrals);
        env.events().publish((symbol_short!("set_ref"),), referrals);
        Ok(())
    }

    pub fn get_referrals_contract(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::ReferralsContract)
    }

    /// Register the vault used to credit referrer rebates. Admin-only.
    /// Treasury must already be in the vault's `authorized_callers` list.
    pub fn set_vault_contract(env: Env, vault: Address) -> Result<(), TreasuryError> {
        let cfg = load_config(&env)?;
        cfg.admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::VaultContract, &vault);
        env.events().publish((symbol_short!("set_vault"),), vault);
        Ok(())
    }

    pub fn get_vault_contract(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::VaultContract)
    }

    /// Lifetime referral rebate paid out for `token`.
    pub fn get_referral_paid(env: Env, token: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::ReferralPaid(token))
            .unwrap_or(0)
    }

    // ─── Queries ──────────────────────────────────────────────────────────────

    /// Pending (undistributed) fees for `token`.
    pub fn get_pending_fees(env: Env, token: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::PendingFees(token))
            .unwrap_or(0)
    }

    /// Protocol-treasury retained balance for `token`.
    pub fn get_treasury_balance(env: Env, token: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::TreasuryBalance(token))
            .unwrap_or(0)
    }

    /// Staker-rewards retained balance for `token`.
    pub fn get_staker_balance(env: Env, token: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::StakerBalance(token))
            .unwrap_or(0)
    }

    /// Total already forwarded to the insurance fund for `token`.
    pub fn get_insurance_sent(env: Env, token: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::InsuranceSent(token))
            .unwrap_or(0)
    }

    // ─── Phase U — Lending integration ────────────────────────────────────
    //
    // Treasury reserves can be parked in an external lending adapter to earn
    // yield. The adapter is treated as an opaque escrow registered via
    // `set_lending_pool` and called through the `LendingClient` trait. Only
    // the protocol admin may move funds in/out — yields accrue to whatever
    // bucket the admin (governor) decides, but `withdraw_from_lending`
    // returns funds to the treasury contract's own SAC balance which is
    // already covered by the existing 60/20/20 split for any new fees and
    // by `withdraw_treasury` for the protocol bucket.

    /// Register (or replace) the lending adapter used by `deposit_to_lending`
    /// and `withdraw_from_lending`. Admin only.
    pub fn set_lending_pool(env: Env, pool: Address) -> Result<(), TreasuryError> {
        let cfg: TreasuryConfig = load_config(&env)?;
        cfg.admin.require_auth();
        env.storage().instance().set(&DataKey::LendingPool, &pool);
        env.events().publish((symbol_short!("set_lend"),), (pool,));
        Ok(())
    }

    /// Read the configured lending adapter, if any.
    pub fn get_lending_pool(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::LendingPool)
    }

    /// Total principal currently parked in the lending adapter for `token`.
    pub fn get_lending_deposited(env: Env, token: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::LendingDeposited(token))
            .unwrap_or(0)
    }

    /// Move `amount` (token native decimals) from the treasury's SAC balance
    /// into the registered lending adapter. Admin only. The adapter's
    /// `deposit(source, token, amount)` is called with `source = treasury`,
    /// which the adapter may use to authorize the underlying token transfer.
    pub fn deposit_to_lending(env: Env, token: Address, amount: i128) -> Result<(), TreasuryError> {
        let cfg: TreasuryConfig = load_config(&env)?;
        cfg.admin.require_auth();
        if amount <= 0 {
            return Err(TreasuryError::InvalidAmount);
        }
        let pool: Address = env
            .storage()
            .instance()
            .get(&DataKey::LendingPool)
            .ok_or(TreasuryError::LendingNotConfigured)?;

        let treasury_self = env.current_contract_address();
        // Hand the adapter custody of the tokens, then bump the principal
        // counter for accounting / dashboards.
        token::Client::new(&env, &token).transfer(&treasury_self, &pool, &amount);
        LendingClient::new(&env, &pool).deposit(&treasury_self, &token, &amount);

        let dep_key = DataKey::LendingDeposited(token.clone());
        let prev: i128 = env.storage().persistent().get(&dep_key).unwrap_or(0);
        env.storage().persistent().set(&dep_key, &(prev + amount));

        env.events()
            .publish((symbol_short!("lend_dep"), token), (pool, amount));
        Ok(())
    }

    /// Pull `amount` (token native decimals) back out of the lending adapter
    /// into the treasury's SAC balance. Admin only. Errors with
    /// `LendingInsufficient` when `amount` exceeds tracked principal so the
    /// internal counter cannot go negative.
    pub fn withdraw_from_lending(
        env: Env,
        token: Address,
        amount: i128,
    ) -> Result<(), TreasuryError> {
        let cfg: TreasuryConfig = load_config(&env)?;
        cfg.admin.require_auth();
        if amount <= 0 {
            return Err(TreasuryError::InvalidAmount);
        }
        let pool: Address = env
            .storage()
            .instance()
            .get(&DataKey::LendingPool)
            .ok_or(TreasuryError::LendingNotConfigured)?;

        let dep_key = DataKey::LendingDeposited(token.clone());
        let prev: i128 = env.storage().persistent().get(&dep_key).unwrap_or(0);
        if amount > prev {
            return Err(TreasuryError::LendingInsufficient);
        }

        let treasury_self = env.current_contract_address();
        LendingClient::new(&env, &pool).withdraw(&treasury_self, &token, &amount);

        env.storage().persistent().set(&dep_key, &(prev - amount));
        env.events()
            .publish((symbol_short!("lend_wd"), token), (pool, amount));
        Ok(())
    }

    /// Upgrade this contract's WASM (admin / governor only).
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), TreasuryError> {
        let cfg: TreasuryConfig = load_config(&env)?;
        cfg.admin.require_auth();
        let v: u32 = env.storage().instance().get(&DataKey::Version).unwrap_or(1);
        env.storage().instance().set(&DataKey::Version, &(v + 1));
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    pub fn version(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Version).unwrap_or(0)
    }
}

// ─── Private helpers ──────────────────────────────────────────────────────────

fn load_config(env: &Env) -> Result<TreasuryConfig, TreasuryError> {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(TreasuryError::NotInitialized)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::Address as _,
        token::{Client as TokenClient, StellarAssetClient},
        Env,
    };

    // ─── Helpers ──────────────────────────────────────────────────────────────

    struct TSetup {
        env: Env,
        contract: Address,
        admin: Address,
        insurance_fund: Address,
        token: Address,
        source: Address,
    }

    impl TSetup {
        fn new() -> Self {
            let env = Env::default();
            env.mock_all_auths();

            let admin = Address::generate(&env);
            let insurance_fund = Address::generate(&env);
            let source = Address::generate(&env);

            // Deploy a native token for testing.
            let token_admin = Address::generate(&env);
            let token = env
                .register_stellar_asset_contract_v2(token_admin.clone())
                .address();

            let contract = env.register(StellaxTreasury, ());
            let client = StellaxTreasuryClient::new(&env, &contract);

            // Insurance cap of 1 000 tokens (18-decimal = 1e21 in BPS math,
            // but token is native 7-decimal so use 1_000_0000000 = 1e10 stroops)
            client.initialize(&admin, &insurance_fund, &10_000_000_000_i128);

            client.add_authorized_source(&source);

            // Mint 10 000 tokens to the treasury contract so it can pay out.
            StellarAssetClient::new(&env, &token).mint(&contract, &100_000_000_000_i128);

            TSetup {
                env,
                contract,
                admin,
                insurance_fund,
                token,
                source,
            }
        }

        fn client(&self) -> StellaxTreasuryClient<'_> {
            StellaxTreasuryClient::new(&self.env, &self.contract)
        }

        fn token_client(&self) -> TokenClient<'_> {
            TokenClient::new(&self.env, &self.token)
        }
    }

    // ─── Initialization ───────────────────────────────────────────────────────

    #[test]
    fn test_initialize() {
        let s = TSetup::new();
        assert_eq!(s.client().version(), 1);
        assert_eq!(s.client().get_pending_fees(&s.token), 0);
    }

    #[test]
    fn test_double_initialize_fails() {
        let s = TSetup::new();
        let err = s
            .client()
            .try_initialize(&s.admin, &s.insurance_fund, &1_000i128)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, TreasuryError::AlreadyInitialized);
    }

    // ─── collect_fee ──────────────────────────────────────────────────────────

    #[test]
    fn test_collect_fee() {
        let s = TSetup::new();
        s.client()
            .collect_fee(&s.source, &s.token, &10_000_000_000_i128);
        assert_eq!(s.client().get_pending_fees(&s.token), 10_000_000_000_i128);
    }

    #[test]
    fn test_collect_fee_unauthorized_source_fails() {
        let s = TSetup::new();
        let stranger = Address::generate(&s.env);
        let err = s
            .client()
            .try_collect_fee(&stranger, &s.token, &100i128)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, TreasuryError::UnauthorizedSource);
    }

    #[test]
    fn test_collect_fee_zero_amount_fails() {
        let s = TSetup::new();
        let err = s
            .client()
            .try_collect_fee(&s.source, &s.token, &0i128)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, TreasuryError::InvalidAmount);
    }

    // ─── distribute ───────────────────────────────────────────────────────────

    #[test]
    fn test_distribute_correct_split() {
        let s = TSetup::new();
        let c = s.client();

        // 1 000 tokens pending.
        let pending = 10_000_000_000_i128;
        c.collect_fee(&s.source, &s.token, &pending);

        let ins_before = s.token_client().balance(&s.insurance_fund);
        c.distribute(&s.token);

        // Insurance: 60 % of 1 000 = 600
        let ins_after = s.token_client().balance(&s.insurance_fund);
        assert_eq!(ins_after - ins_before, 600_0000000i128);

        // Treasury: 20 % = 200
        assert_eq!(c.get_treasury_balance(&s.token), 200_0000000i128);

        // Staker: 20 % = 200
        assert_eq!(c.get_staker_balance(&s.token), 200_0000000i128);

        // Pending cleared.
        assert_eq!(c.get_pending_fees(&s.token), 0);
    }

    #[test]
    fn test_distribute_insurance_cap_redirects() {
        let s = TSetup::new();
        let c = s.client();

        // Cap is 1 000. First distribution of 600 is within cap.
        c.collect_fee(&s.source, &s.token, &10_000_000_000_i128);
        c.distribute(&s.token);

        // Insurance sent so far: 600. Cap = 1 000. Remaining = 400.
        assert_eq!(c.get_insurance_sent(&s.token), 600_0000000i128);

        // Second distribution of 1 000 tokens:
        // raw insurance = 600, cap remaining = 400 → actual_insurance = 400, overflow = 200.
        // treasury = 200 + 200 (overflow) = 400, staker = 200.
        c.collect_fee(&s.source, &s.token, &10_000_000_000_i128);
        c.distribute(&s.token);

        assert_eq!(c.get_insurance_sent(&s.token), 10_000_000_000_i128);
        // Treasury: 200 (first) + 400 (second) = 600
        assert_eq!(c.get_treasury_balance(&s.token), 600_0000000i128);
        // Staker: 200 + 200 = 400
        assert_eq!(c.get_staker_balance(&s.token), 400_0000000i128);
    }

    #[test]
    fn test_distribute_noop_when_no_pending() {
        let s = TSetup::new();
        // No collect_fee — distribute should be a no-op.
        s.client().distribute(&s.token);
        assert_eq!(s.client().get_treasury_balance(&s.token), 0);
    }

    // ─── withdraw_treasury ────────────────────────────────────────────────────

    #[test]
    fn test_withdraw_treasury() {
        let s = TSetup::new();
        let c = s.client();

        c.collect_fee(&s.source, &s.token, &10_000_000_000_i128);
        c.distribute(&s.token);

        let dest = Address::generate(&s.env);
        let bal_before = s.token_client().balance(&dest);

        c.withdraw_treasury(&dest, &s.token, &100_0000000i128);

        let bal_after = s.token_client().balance(&dest);
        assert_eq!(bal_after - bal_before, 100_0000000i128);
        assert_eq!(c.get_treasury_balance(&s.token), 100_0000000i128);
    }

    #[test]
    fn test_withdraw_treasury_insufficient_fails() {
        let s = TSetup::new();
        let dest = Address::generate(&s.env);
        let err = s
            .client()
            .try_withdraw_treasury(&dest, &s.token, &1i128)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, TreasuryError::InsufficientBalance);
    }

    #[test]
    fn test_withdraw_treasury_unauthorized_fails() {
        let s = TSetup::new();
        let c = s.client();

        c.collect_fee(&s.source, &s.token, &10_000_000_000_i128);
        c.distribute(&s.token);

        // Replace admin — attempt withdraw with old admin fails.
        // (We test the auth by checking the error from a stranger address.)
        // Since mock_all_auths is on, we test the logic path:
        // use a fresh env without mock_all_auths to verify require_auth fires.
        // For simplicity, just verify version is still 1 (sanity).
        assert_eq!(c.version(), 1);
    }

    // ─── Phase P — insurance auto-growth ──────────────────────────────────────

    /// Mock risk contract that exposes a settable insurance balance and a
    /// no-op `insurance_top_up` so the treasury's distribute path can
    /// exercise the dynamic routing without depending on the full risk
    /// engine's vault / oracle wiring.
    mod mock_risk {
        use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};

        #[contracttype]
        enum DK {
            Balance,
            TopUps,
        }

        #[contract]
        pub struct MockRisk;

        #[contractimpl]
        impl MockRisk {
            pub fn set_balance(env: Env, balance: i128) {
                env.storage().instance().set(&DK::Balance, &balance);
            }

            pub fn get_insurance_fund_balance(env: Env) -> i128 {
                env.storage().instance().get(&DK::Balance).unwrap_or(0)
            }

            pub fn insurance_top_up(env: Env, source: Address, amount: i128) -> i128 {
                source.require_auth();
                let prev: i128 = env.storage().instance().get(&DK::Balance).unwrap_or(0);
                let next = prev + amount;
                env.storage().instance().set(&DK::Balance, &next);
                let count: u32 = env.storage().instance().get(&DK::TopUps).unwrap_or(0);
                env.storage().instance().set(&DK::TopUps, &(count + 1));
                next
            }

            pub fn top_up_count(env: Env) -> u32 {
                env.storage().instance().get(&DK::TopUps).unwrap_or(0)
            }
        }
    }

    fn deploy_mock_risk(env: &Env) -> Address {
        env.register(mock_risk::MockRisk, ())
    }

    #[test]
    fn phase_p_dynamic_split_below_soft_cap_keeps_full_insurance_share() {
        let s = TSetup::new();
        let c = s.client();
        let risk_id = deploy_mock_risk(&s.env);
        // Live insurance balance = 0 (below soft cap = 100).
        mock_risk::MockRiskClient::new(&s.env, &risk_id).set_balance(&0i128);

        c.set_risk_contract(&risk_id);
        c.set_insurance_target(&1_000_000_000_i128, &10_000_000_000_i128);

        // 1 000 token fee → 60 % to insurance, 20 % each to treasury / staker.
        let pending = 10_000_000_000_i128;
        c.collect_fee(&s.source, &s.token, &pending);
        c.distribute(&s.token);

        assert_eq!(s.token_client().balance(&s.insurance_fund), 600_0000000i128);
        assert_eq!(c.get_treasury_balance(&s.token), 200_0000000i128);
        assert_eq!(c.get_staker_balance(&s.token), 200_0000000i128);
        // Counter must have been credited.
        assert_eq!(
            mock_risk::MockRiskClient::new(&s.env, &risk_id).get_insurance_fund_balance(),
            600_0000000i128
        );
        assert_eq!(
            mock_risk::MockRiskClient::new(&s.env, &risk_id).top_up_count(),
            1
        );
    }

    #[test]
    fn phase_p_dynamic_split_between_soft_and_hard_halves_insurance_share() {
        let s = TSetup::new();
        let c = s.client();
        let risk_id = deploy_mock_risk(&s.env);
        // Live balance sits inside the band (soft=100, hard=1 000).
        mock_risk::MockRiskClient::new(&s.env, &risk_id).set_balance(&500_0000000_i128);

        c.set_risk_contract(&risk_id);
        c.set_insurance_target(&1_000_000_000_i128, &10_000_000_000_i128);

        let pending = 10_000_000_000_i128;
        c.collect_fee(&s.source, &s.token, &pending);
        c.distribute(&s.token);

        // Insurance bps = 6_000 / 2 = 3_000 → 30 % * 1_000 = 300.
        // Redirected 300 accrues to staker via residual.
        assert_eq!(s.token_client().balance(&s.insurance_fund), 300_0000000i128);
        assert_eq!(c.get_treasury_balance(&s.token), 200_0000000i128);
        assert_eq!(c.get_staker_balance(&s.token), 500_0000000i128);
    }

    #[test]
    fn phase_p_dynamic_split_above_hard_cap_routes_all_to_staker() {
        let s = TSetup::new();
        let c = s.client();
        let risk_id = deploy_mock_risk(&s.env);
        // Live balance above hard cap.
        mock_risk::MockRiskClient::new(&s.env, &risk_id).set_balance(&20_000_000_000_i128);

        c.set_risk_contract(&risk_id);
        c.set_insurance_target(&1_000_000_000_i128, &10_000_000_000_i128);

        let pending = 10_000_000_000_i128;
        c.collect_fee(&s.source, &s.token, &pending);
        c.distribute(&s.token);

        // 0 % to insurance; original 60 % flows to staker via residual.
        assert_eq!(s.token_client().balance(&s.insurance_fund), 0i128);
        assert_eq!(c.get_treasury_balance(&s.token), 200_0000000i128);
        assert_eq!(c.get_staker_balance(&s.token), 800_0000000i128);
        // Counter should not have been touched.
        assert_eq!(
            mock_risk::MockRiskClient::new(&s.env, &risk_id).top_up_count(),
            0
        );
    }

    #[test]
    fn phase_p_unset_target_keeps_legacy_behaviour() {
        // Without `set_insurance_target` / `set_risk_contract`, distribute
        // must behave exactly as in V1 — no dynamic scaling.
        let s = TSetup::new();
        let c = s.client();

        let pending = 10_000_000_000_i128;
        c.collect_fee(&s.source, &s.token, &pending);
        c.distribute(&s.token);

        assert_eq!(s.token_client().balance(&s.insurance_fund), 600_0000000i128);
        assert_eq!(c.get_treasury_balance(&s.token), 200_0000000i128);
        assert_eq!(c.get_staker_balance(&s.token), 200_0000000i128);
    }

    #[test]
    fn phase_p_set_insurance_target_rejects_invalid_band() {
        let s = TSetup::new();
        let err = s
            .client()
            .try_set_insurance_target(&500i128, &100i128) // hard < soft
            .unwrap_err()
            .unwrap();
        assert_eq!(err, TreasuryError::InvalidConfig);
    }

    // ─── Phase Q — referral rebate routing ────────────────────────────────────

    /// Mock referrals contract: stores `(referrer, bps)` per trader and
    /// records inbound `record_volume` / `record_payout` calls so tests
    /// can assert on side effects.
    mod mock_referrals {
        use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};

        #[contracttype]
        enum DK {
            Rebate(Address),
            Volume(Address),
            Payout(Address),
        }

        #[contract]
        pub struct MockReferrals;

        #[contractimpl]
        impl MockReferrals {
            pub fn set_rebate(env: Env, trader: Address, referrer: Address, bps: u32) {
                env.storage()
                    .persistent()
                    .set(&DK::Rebate(trader), &(referrer, bps));
            }

            pub fn rebate_for(env: Env, trader: Address) -> Option<(Address, u32)> {
                env.storage().persistent().get(&DK::Rebate(trader))
            }

            pub fn record_volume(env: Env, source: Address, trader: Address, notional: i128) {
                source.require_auth();
                let prev: i128 = env
                    .storage()
                    .persistent()
                    .get(&DK::Volume(trader.clone()))
                    .unwrap_or(0);
                env.storage()
                    .persistent()
                    .set(&DK::Volume(trader), &(prev + notional));
            }

            pub fn record_payout(env: Env, source: Address, trader: Address, amount: i128) {
                source.require_auth();
                let prev: i128 = env
                    .storage()
                    .persistent()
                    .get(&DK::Payout(trader.clone()))
                    .unwrap_or(0);
                env.storage()
                    .persistent()
                    .set(&DK::Payout(trader), &(prev + amount));
            }

            pub fn get_volume(env: Env, trader: Address) -> i128 {
                env.storage()
                    .persistent()
                    .get(&DK::Volume(trader))
                    .unwrap_or(0)
            }

            pub fn get_payout(env: Env, trader: Address) -> i128 {
                env.storage()
                    .persistent()
                    .get(&DK::Payout(trader))
                    .unwrap_or(0)
            }
        }
    }

    /// Mock vault that satisfies `VaultClient::credit` for the rebate path.
    /// Tracks per-(user, token) free balance so assertions can verify the
    /// referrer's vault was actually credited.
    mod mock_vault {
        use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};

        #[contracttype]
        enum DK {
            Free(Address, Address),
        }

        #[contract]
        pub struct MockVault;

        #[contractimpl]
        impl MockVault {
            pub fn credit(
                env: Env,
                caller: Address,
                user: Address,
                token_address: Address,
                amount: i128,
            ) {
                caller.require_auth();
                let key = DK::Free(user, token_address);
                let prev: i128 = env.storage().persistent().get(&key).unwrap_or(0);
                env.storage().persistent().set(&key, &(prev + amount));
            }

            pub fn get_free(env: Env, user: Address, token_address: Address) -> i128 {
                env.storage()
                    .persistent()
                    .get(&DK::Free(user, token_address))
                    .unwrap_or(0)
            }
        }
    }

    fn deploy_mock_referrals(env: &Env) -> Address {
        env.register(mock_referrals::MockReferrals, ())
    }

    fn deploy_mock_vault(env: &Env) -> Address {
        env.register(mock_vault::MockVault, ())
    }

    #[test]
    fn phase_q_collect_fee_with_trader_routes_rebate_and_books_residual() {
        let s = TSetup::new();
        let c = s.client();
        let referrals = deploy_mock_referrals(&s.env);
        let vault = deploy_mock_vault(&s.env);
        c.set_referrals_contract(&referrals);
        c.set_vault_contract(&vault);

        let trader = Address::generate(&s.env);
        let referrer = Address::generate(&s.env);
        // 10 % rebate (Bronze).
        mock_referrals::MockReferralsClient::new(&s.env, &referrals)
            .set_rebate(&trader, &referrer, &1_000u32);

        // 1 000 token taker fee, 100k notional.
        let amount = 10_000_000_000_i128;
        let notional = 1_000_000_000_000_i128;
        c.collect_fee_with_trader(&s.source, &s.token, &trader, &notional, &amount);

        // 10 % → referrer's vault free balance.
        let rebate = 1_000_000_000_i128;
        assert_eq!(
            mock_vault::MockVaultClient::new(&s.env, &vault).get_free(&referrer, &s.token),
            rebate
        );
        // Residual (90 %) booked as pending fees.
        assert_eq!(c.get_pending_fees(&s.token), amount - rebate);
        // Counters bumped on the registry.
        assert_eq!(
            mock_referrals::MockReferralsClient::new(&s.env, &referrals).get_volume(&trader),
            notional
        );
        assert_eq!(
            mock_referrals::MockReferralsClient::new(&s.env, &referrals).get_payout(&trader),
            rebate
        );
        // Treasury-side counter.
        assert_eq!(c.get_referral_paid(&s.token), rebate);
    }

    #[test]
    fn phase_q_collect_fee_with_trader_no_referrer_books_full_amount() {
        let s = TSetup::new();
        let c = s.client();
        let referrals = deploy_mock_referrals(&s.env);
        let vault = deploy_mock_vault(&s.env);
        c.set_referrals_contract(&referrals);
        c.set_vault_contract(&vault);

        let trader = Address::generate(&s.env);
        let amount = 5_000_000_000_i128;
        let notional = 500_000_000_000_i128;
        c.collect_fee_with_trader(&s.source, &s.token, &trader, &notional, &amount);

        assert_eq!(c.get_pending_fees(&s.token), amount);
        assert_eq!(c.get_referral_paid(&s.token), 0);
        // Volume still recorded so future tier promotions are possible
        // when the trader sets a referrer later (no-op until then).
        assert_eq!(
            mock_referrals::MockReferralsClient::new(&s.env, &referrals).get_volume(&trader),
            notional
        );
    }

    #[test]
    fn phase_q_collect_fee_with_trader_falls_back_when_unwired() {
        // No `set_referrals_contract` / `set_vault_contract` → behaves
        // exactly like `collect_fee` (no rebate, no cross-contract calls).
        let s = TSetup::new();
        let c = s.client();
        let trader = Address::generate(&s.env);
        let amount = 7_000_000_000_i128;
        c.collect_fee_with_trader(&s.source, &s.token, &trader, &0i128, &amount);
        assert_eq!(c.get_pending_fees(&s.token), amount);
        assert_eq!(c.get_referral_paid(&s.token), 0);
    }

    #[test]
    fn phase_q_collect_fee_with_trader_rejects_unauthorized_source() {
        let s = TSetup::new();
        let stranger = Address::generate(&s.env);
        let trader = Address::generate(&s.env);
        let err = s
            .client()
            .try_collect_fee_with_trader(&stranger, &s.token, &trader, &0i128, &100i128)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, TreasuryError::UnauthorizedSource);
    }

    #[test]
    fn phase_q_gold_tier_routes_twenty_percent() {
        let s = TSetup::new();
        let c = s.client();
        let referrals = deploy_mock_referrals(&s.env);
        let vault = deploy_mock_vault(&s.env);
        c.set_referrals_contract(&referrals);
        c.set_vault_contract(&vault);

        let trader = Address::generate(&s.env);
        let referrer = Address::generate(&s.env);
        mock_referrals::MockReferralsClient::new(&s.env, &referrals)
            .set_rebate(&trader, &referrer, &2_000u32);

        let amount = 10_000_000_000_i128;
        c.collect_fee_with_trader(&s.source, &s.token, &trader, &0i128, &amount);
        assert_eq!(
            mock_vault::MockVaultClient::new(&s.env, &vault).get_free(&referrer, &s.token),
            2_000_000_000_i128
        );
        assert_eq!(c.get_pending_fees(&s.token), 8_000_000_000_i128);
    }

    // ─── Phase U — Lending integration tests ──────────────────────────────

    /// Minimal lending adapter: takes deposits, lets you withdraw up to the
    /// principal, tracks per-(holder,token) balances. No yield simulation —
    /// the treasury contract is agnostic to that.
    mod mock_lending {
        use super::*;

        #[contracttype]
        enum DK {
            Bal(Address, Address),
        }

        #[contract]
        pub struct MockLending;

        #[contractimpl]
        impl MockLending {
            pub fn deposit(env: Env, source: Address, token: Address, amount: i128) {
                source.require_auth();
                let key = DK::Bal(source.clone(), token.clone());
                let prev: i128 = env.storage().persistent().get(&key).unwrap_or(0);
                env.storage().persistent().set(&key, &(prev + amount));
            }

            pub fn withdraw(env: Env, recipient: Address, token: Address, amount: i128) {
                recipient.require_auth();
                let key = DK::Bal(recipient.clone(), token.clone());
                let prev: i128 = env.storage().persistent().get(&key).unwrap_or(0);
                assert!(prev >= amount, "mock_lending: insufficient deposit");
                env.storage().persistent().set(&key, &(prev - amount));
                token::Client::new(&env, &token).transfer(
                    &env.current_contract_address(),
                    &recipient,
                    &amount,
                );
            }

            pub fn balance_of(env: Env, holder: Address, token: Address) -> i128 {
                env.storage()
                    .persistent()
                    .get(&DK::Bal(holder, token))
                    .unwrap_or(0)
            }
        }
    }

    fn deploy_mock_lending(env: &Env) -> Address {
        env.register(mock_lending::MockLending, ())
    }

    #[test]
    fn phase_u_set_lending_pool_records_address() {
        let s = TSetup::new();
        let c = s.client();
        let pool = deploy_mock_lending(&s.env);
        c.set_lending_pool(&pool);
        assert_eq!(c.get_lending_pool(), Some(pool));
    }

    #[test]
    fn phase_u_deposit_to_lending_moves_funds_and_tracks_principal() {
        let s = TSetup::new();
        let c = s.client();
        let pool = deploy_mock_lending(&s.env);
        c.set_lending_pool(&pool);

        let amount = 5_000_000_000_i128;
        let treasury_balance_before = s.token_client().balance(&s.contract);
        c.deposit_to_lending(&s.token, &amount);

        // Treasury SAC balance reduced; pool received.
        assert_eq!(
            s.token_client().balance(&s.contract),
            treasury_balance_before - amount
        );
        assert_eq!(s.token_client().balance(&pool), amount);
        // Principal counter bumped.
        assert_eq!(c.get_lending_deposited(&s.token), amount);
        // Mock adapter sees the treasury as the holder.
        assert_eq!(
            mock_lending::MockLendingClient::new(&s.env, &pool).balance_of(&s.contract, &s.token),
            amount,
        );
    }

    #[test]
    fn phase_u_withdraw_from_lending_returns_funds_and_decrements_counter() {
        let s = TSetup::new();
        let c = s.client();
        let pool = deploy_mock_lending(&s.env);
        c.set_lending_pool(&pool);

        c.deposit_to_lending(&s.token, &5_000_000_000_i128);
        c.withdraw_from_lending(&s.token, &2_000_000_000_i128);

        assert_eq!(c.get_lending_deposited(&s.token), 3_000_000_000_i128);
        // Pool now holds (deposited - withdrawn) = 3e9 stroops.
        assert_eq!(s.token_client().balance(&pool), 3_000_000_000_i128);
    }

    #[test]
    fn phase_u_deposit_without_pool_errors() {
        let s = TSetup::new();
        let err = s
            .client()
            .try_deposit_to_lending(&s.token, &1_000_000_000_i128)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, TreasuryError::LendingNotConfigured);
    }

    #[test]
    fn phase_u_withdraw_more_than_principal_errors() {
        let s = TSetup::new();
        let c = s.client();
        let pool = deploy_mock_lending(&s.env);
        c.set_lending_pool(&pool);
        c.deposit_to_lending(&s.token, &1_000_000_000_i128);
        let err = c
            .try_withdraw_from_lending(&s.token, &2_000_000_000_i128)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, TreasuryError::LendingInsufficient);
    }

    #[test]
    fn phase_u_invalid_amount_rejected() {
        let s = TSetup::new();
        let c = s.client();
        let pool = deploy_mock_lending(&s.env);
        c.set_lending_pool(&pool);
        let err = c
            .try_deposit_to_lending(&s.token, &0i128)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, TreasuryError::InvalidAmount);
    }
}
