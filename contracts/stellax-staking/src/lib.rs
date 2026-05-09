//! StellaX Staking — Phase F.
//!
//! Epoch-based STLX staking. Users stake STLX (Stellar Asset Contract) and
//! earn proportional USDC rewards deposited each epoch by the treasury.
//!
//! ## Lifecycle
//! 1. Admin initialises with STLX token address, treasury, epoch duration.
//! 2. User stakes STLX via `stake(user, amount)`. STLX is transferred into
//!    the contract and the user's `StakeEntry` is updated.
//! 3. Treasury periodically deposits USDC via `deposit_epoch_rewards` to
//!    fund the *current* epoch's pool, snapshotting `total_staked`.
//! 4. User calls `claim_rewards(user)` to claim proportional shares from
//!    every fully-closed epoch since their last claim.
//! 5. User calls `unstake(user, amount)` — only succeeds once the current
//!    epoch has closed (epoch boundary cooldown).
//!
//! Epochs advance monotonically based on `env.ledger().timestamp()`:
//! `epoch_id = (timestamp - epoch_zero_ts) / epoch_duration_secs`.
//! `deposit_epoch_rewards` finalises the *previous* epoch's `total_staked`
//! snapshot — new stakes after the deposit land in the *next* epoch's pool.

#![no_std]
#![allow(deprecated)]
#![allow(clippy::too_many_arguments)]

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, Address,
    BytesN, Env,
};
use stellax_math::{
    mul_div, TTL_BUMP_INSTANCE, TTL_BUMP_PERSISTENT, TTL_THRESHOLD_INSTANCE,
    TTL_THRESHOLD_PERSISTENT,
};

const CONTRACT_VERSION: u32 = 1;

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum StakingError {
    AlreadyInitialized = 1,
    Unauthorized = 2,
    InvalidConfig = 3,
    InvalidAmount = 4,
    InsufficientStake = 5,
    UnstakeLocked = 6,
    NothingToClaim = 7,
    EpochNotFound = 8,
    MathOverflow = 9,
    TransferFailed = 10,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum DataKey {
    Config,
    Version,
    /// Current epoch counter cached for fast lookup.
    CurrentEpoch,
    /// Per-user stake record.
    Stake(Address),
    /// Per-epoch reward pool (keyed by epoch id).
    EpochPool(u32),
    /// Aggregate amount currently staked across all users.
    TotalStaked,
    /// Ledger timestamp at which epoch 0 began.
    EpochZero,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StakingConfig {
    pub admin: Address,
    pub stlx_token: Address,
    pub treasury: Address,
    pub epoch_duration_secs: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StakeEntry {
    pub staker: Address,
    /// Amount of STLX staked, token-native precision (7 decimals for Stellar
    /// classic assets). Never negative.
    pub amount: i128,
    /// Epoch in which this entry was last modified (stake/unstake).
    pub stake_epoch: u32,
    /// Next epoch id from which rewards are claimable. On first stake this
    /// equals the current epoch — i.e. the staker is eligible for pools
    /// deposited in the epoch they staked (once that epoch closes). After a
    /// successful claim it advances to `last_closed + 1`.
    pub last_claim_epoch: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EpochRewardPool {
    pub epoch_id: u32,
    /// Snapshot of `total_staked` at `deposit_epoch_rewards` time.
    pub total_staked: i128,
    pub reward_token: Address,
    pub reward_amount: i128,
    pub claimed_amount: i128,
}

#[contractclient(name = "TokenClient")]
pub trait TokenInterface {
    fn transfer(env: Env, from: Address, to: Address, amount: i128);
}

#[contract]
pub struct StellaxStaking;

#[contractimpl]
impl StellaxStaking {
    pub fn version(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Version)
            .unwrap_or(CONTRACT_VERSION)
    }

    pub fn initialize(
        env: Env,
        admin: Address,
        stlx_token: Address,
        treasury: Address,
        epoch_duration_secs: u64,
    ) -> Result<(), StakingError> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(StakingError::AlreadyInitialized);
        }
        admin.require_auth();
        if epoch_duration_secs == 0 {
            return Err(StakingError::InvalidConfig);
        }
        let cfg = StakingConfig {
            admin,
            stlx_token,
            treasury,
            epoch_duration_secs,
        };
        env.storage().instance().set(&DataKey::Config, &cfg);
        env.storage()
            .instance()
            .set(&DataKey::Version, &CONTRACT_VERSION);
        env.storage()
            .instance()
            .set(&DataKey::EpochZero, &env.ledger().timestamp());
        env.storage().instance().set(&DataKey::CurrentEpoch, &0u32);
        env.storage().instance().set(&DataKey::TotalStaked, &0i128);
        bump_instance(&env);
        Ok(())
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), StakingError> {
        bump_instance(&env);
        let cfg = Self::load_config(&env)?;
        cfg.admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        env.storage()
            .instance()
            .set(&DataKey::Version, &(CONTRACT_VERSION + 1));
        Ok(())
    }

    pub fn get_config(env: Env) -> Result<StakingConfig, StakingError> {
        bump_instance(&env);
        Self::load_config(&env)
    }

    /// Current epoch id based on ledger timestamp.
    pub fn current_epoch(env: Env) -> u32 {
        bump_instance(&env);
        Self::compute_current_epoch(&env).unwrap_or(0)
    }

    /// Stake `amount` STLX. Transfers tokens from `user` into this contract.
    /// Reward accounting snapshots via `last_claim_epoch = current_epoch` so
    /// new stakers don't retroactively claim already-distributed pools.
    pub fn stake(env: Env, user: Address, amount: i128) -> Result<(), StakingError> {
        user.require_auth();
        if amount <= 0 {
            return Err(StakingError::InvalidAmount);
        }
        let cfg = Self::load_config(&env)?;
        let epoch = Self::compute_current_epoch(&env)?;

        // Pull STLX into the contract.
        let token = TokenClient::new(&env, &cfg.stlx_token);
        token.transfer(&user, &env.current_contract_address(), &amount);

        // Update stake entry.
        let key = DataKey::Stake(user.clone());
        // First-time stakers are eligible for reward pools deposited from
        // their stake epoch onward. `last_claim_epoch` stores the *next*
        // epoch to claim, so initialising it to `epoch` means the claim loop
        // will start at `epoch` once that epoch closes.
        let mut entry: StakeEntry = env.storage().persistent().get(&key).unwrap_or(StakeEntry {
            staker: user.clone(),
            amount: 0,
            stake_epoch: epoch,
            last_claim_epoch: epoch,
        });
        entry.amount = entry
            .amount
            .checked_add(amount)
            .ok_or(StakingError::MathOverflow)?;
        entry.stake_epoch = epoch;
        env.storage().persistent().set(&key, &entry);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD_PERSISTENT, TTL_BUMP_PERSISTENT);

        // Update total.
        let total: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalStaked)
            .unwrap_or(0);
        let new_total = total
            .checked_add(amount)
            .ok_or(StakingError::MathOverflow)?;
        env.storage()
            .instance()
            .set(&DataKey::TotalStaked, &new_total);

        bump_instance(&env);
        env.events()
            .publish((symbol_short!("stake"), user), (amount, epoch, new_total));
        Ok(())
    }

    /// Unstake `amount` STLX. Requires the stake entry to have been in place
    /// for at least one closed epoch (cooldown): `stake_epoch < current_epoch`.
    pub fn unstake(env: Env, user: Address, amount: i128) -> Result<(), StakingError> {
        user.require_auth();
        if amount <= 0 {
            return Err(StakingError::InvalidAmount);
        }
        let cfg = Self::load_config(&env)?;
        let epoch = Self::compute_current_epoch(&env)?;
        let key = DataKey::Stake(user.clone());
        let mut entry: StakeEntry = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(StakingError::InsufficientStake)?;
        if entry.amount < amount {
            return Err(StakingError::InsufficientStake);
        }
        if entry.stake_epoch >= epoch {
            return Err(StakingError::UnstakeLocked);
        }

        entry.amount -= amount;
        env.storage().persistent().set(&key, &entry);

        let total: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalStaked)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalStaked, &(total - amount));

        let token = TokenClient::new(&env, &cfg.stlx_token);
        token.transfer(&env.current_contract_address(), &user, &amount);

        bump_instance(&env);
        env.events().publish(
            (symbol_short!("unstake"), user),
            (amount, epoch, entry.amount),
        );
        Ok(())
    }

    /// Called by the treasury to deposit a reward pool for the *current*
    /// epoch. The treasury transfers `amount` of `token` into this contract
    /// and we snapshot `total_staked` as the denominator for pro-rata claims.
    /// Subsequent calls in the same epoch add to the same pool.
    pub fn deposit_epoch_rewards(
        env: Env,
        caller: Address,
        reward_token: Address,
        amount: i128,
    ) -> Result<(), StakingError> {
        caller.require_auth();
        let cfg = Self::load_config(&env)?;
        if caller != cfg.treasury {
            return Err(StakingError::Unauthorized);
        }
        if amount <= 0 {
            return Err(StakingError::InvalidAmount);
        }
        let epoch = Self::compute_current_epoch(&env)?;

        // Pull reward tokens in.
        let token = TokenClient::new(&env, &reward_token);
        token.transfer(&caller, &env.current_contract_address(), &amount);

        let total_staked: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalStaked)
            .unwrap_or(0);

        let key = DataKey::EpochPool(epoch);
        let pool = env
            .storage()
            .persistent()
            .get::<DataKey, EpochRewardPool>(&key)
            .map(|mut existing| {
                existing.reward_amount += amount;
                // Keep the original total_staked snapshot if it was non-zero;
                // otherwise refresh so an empty-epoch deposit still records a
                // usable denominator.
                if existing.total_staked == 0 {
                    existing.total_staked = total_staked;
                }
                existing
            })
            .unwrap_or(EpochRewardPool {
                epoch_id: epoch,
                total_staked,
                reward_token: reward_token.clone(),
                reward_amount: amount,
                claimed_amount: 0,
            });
        env.storage().persistent().set(&key, &pool);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD_PERSISTENT, TTL_BUMP_PERSISTENT);

        env.storage().instance().set(&DataKey::CurrentEpoch, &epoch);
        bump_instance(&env);
        env.events().publish(
            (symbol_short!("rwd_dep"), epoch),
            (reward_token, amount, total_staked),
        );
        Ok(())
    }

    /// Claim accrued rewards from every fully-closed epoch in the window
    /// `(last_claim_epoch, current_epoch - 1]`. The *current* epoch remains
    /// unclaimed until it closes so late stakers can't front-run payouts.
    pub fn claim_rewards(env: Env, user: Address) -> Result<i128, StakingError> {
        user.require_auth();
        let key = DataKey::Stake(user.clone());
        let mut entry: StakeEntry = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(StakingError::NothingToClaim)?;
        let current = Self::compute_current_epoch(&env)?;
        if current == 0 {
            // No epoch has closed yet.
            return Err(StakingError::NothingToClaim);
        }
        let last_closed = current - 1;
        if entry.last_claim_epoch > last_closed {
            return Err(StakingError::NothingToClaim);
        }

        // Track per-token totals so a single claim can span multiple pools
        // even if their `reward_token` differs. In practice the treasury
        // deposits USDC each epoch so there is only ever one token, but the
        // design allows future multi-token payouts without another migration.
        let mut total_claim: i128 = 0;
        let mut token_addr: Option<Address> = None;

        let mut ep = entry.last_claim_epoch;
        while ep <= last_closed {
            let pkey = DataKey::EpochPool(ep);
            if let Some(mut pool) = env
                .storage()
                .persistent()
                .get::<DataKey, EpochRewardPool>(&pkey)
            {
                if pool.total_staked > 0 {
                    let share = mul_div(entry.amount, pool.reward_amount, pool.total_staked);
                    if share > 0 {
                        pool.claimed_amount += share;
                        env.storage().persistent().set(&pkey, &pool);
                        total_claim += share;
                        token_addr = Some(pool.reward_token.clone());
                    }
                }
            }
            ep += 1;
        }

        if total_claim == 0 || token_addr.is_none() {
            entry.last_claim_epoch = last_closed + 1;
            env.storage().persistent().set(&key, &entry);
            return Err(StakingError::NothingToClaim);
        }

        entry.last_claim_epoch = last_closed + 1;
        env.storage().persistent().set(&key, &entry);

        let token = TokenClient::new(&env, token_addr.as_ref().unwrap());
        token.transfer(&env.current_contract_address(), &user, &total_claim);

        bump_instance(&env);
        env.events()
            .publish((symbol_short!("claim"), user), (total_claim, last_closed));
        Ok(total_claim)
    }

    pub fn get_stake(env: Env, user: Address) -> Result<StakeEntry, StakingError> {
        bump_instance(&env);
        env.storage()
            .persistent()
            .get(&DataKey::Stake(user))
            .ok_or(StakingError::InsufficientStake)
    }

    /// Phase O: read just the staked STLX amount for `user`. Returns `0` when
    /// no stake entry exists. Cheap accessor for cross-contract governance
    /// vote-weight calculations.
    pub fn get_stake_amount(env: Env, user: Address) -> i128 {
        bump_instance(&env);
        env.storage()
            .persistent()
            .get::<_, StakeEntry>(&DataKey::Stake(user))
            .map(|e| e.amount)
            .unwrap_or(0)
    }

    /// Phase O: epoch in which `user`'s current stake was last increased.
    /// Returns `u32::MAX` when no stake exists, so callers can compare with
    /// `<` against a snapshot epoch and treat absent stakers as ineligible.
    pub fn get_stake_epoch(env: Env, user: Address) -> u32 {
        bump_instance(&env);
        env.storage()
            .persistent()
            .get::<_, StakeEntry>(&DataKey::Stake(user))
            .map(|e| e.stake_epoch)
            .unwrap_or(u32::MAX)
    }

    pub fn get_epoch_reward(env: Env, epoch_id: u32) -> Result<EpochRewardPool, StakingError> {
        bump_instance(&env);
        env.storage()
            .persistent()
            .get(&DataKey::EpochPool(epoch_id))
            .ok_or(StakingError::EpochNotFound)
    }

    pub fn total_staked(env: Env) -> i128 {
        bump_instance(&env);
        env.storage()
            .instance()
            .get(&DataKey::TotalStaked)
            .unwrap_or(0)
    }

    // ── Internal helpers ─────────────────────────────────────────────────

    fn load_config(env: &Env) -> Result<StakingConfig, StakingError> {
        env.storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(StakingError::InvalidConfig)
    }

    fn compute_current_epoch(env: &Env) -> Result<u32, StakingError> {
        let cfg = Self::load_config(env)?;
        let zero: u64 = env
            .storage()
            .instance()
            .get(&DataKey::EpochZero)
            .unwrap_or(0);
        let now = env.ledger().timestamp();
        let elapsed = now.saturating_sub(zero);
        let epoch = elapsed / cfg.epoch_duration_secs;
        Ok(epoch as u32)
    }
}

fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_INSTANCE, TTL_BUMP_INSTANCE);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token::{StellarAssetClient, TokenClient as SdkTokenClient},
        Address, Env,
    };

    const EPOCH_SECS: u64 = 3_600;
    const USDC_DECIMALS: i128 = 1;

    struct Harness {
        env: Env,
        admin: Address,
        treasury: Address,
        stlx_admin: Address,
        stlx: Address,
        usdc_admin: Address,
        usdc: Address,
        staking: Address,
    }

    fn setup() -> Harness {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        // STLX SAC mock.
        let stlx_admin = Address::generate(&env);
        let stlx_contract = env.register_stellar_asset_contract_v2(stlx_admin.clone());
        let stlx = stlx_contract.address();

        let usdc_admin = Address::generate(&env);
        let usdc_contract = env.register_stellar_asset_contract_v2(usdc_admin.clone());
        let usdc = usdc_contract.address();

        let staking = env.register(StellaxStaking, ());
        let client = StellaxStakingClient::new(&env, &staking);
        client.initialize(&admin, &stlx, &treasury, &EPOCH_SECS);

        Harness {
            env,
            admin,
            treasury,
            stlx_admin,
            stlx,
            usdc_admin,
            usdc,
            staking,
        }
    }

    fn mint_stlx(h: &Harness, to: &Address, amount: i128) {
        let sac = StellarAssetClient::new(&h.env, &h.stlx);
        sac.mint(to, &amount);
        // Silence the unused-field warning for stlx_admin.
        let _ = &h.stlx_admin;
    }

    fn mint_usdc(h: &Harness, to: &Address, amount: i128) {
        let sac = StellarAssetClient::new(&h.env, &h.usdc);
        sac.mint(to, &amount);
        let _ = &h.usdc_admin;
    }

    fn advance_epoch(h: &Harness, epochs: u64) {
        h.env
            .ledger()
            .set_timestamp(h.env.ledger().timestamp() + EPOCH_SECS * epochs);
    }

    #[test]
    fn initialize_ok() {
        let h = setup();
        let c = StellaxStakingClient::new(&h.env, &h.staking);
        assert_eq!(c.version(), CONTRACT_VERSION);
        let cfg = c.get_config();
        assert_eq!(cfg.admin, h.admin);
        assert_eq!(cfg.epoch_duration_secs, EPOCH_SECS);
    }

    #[test]
    fn double_init_fails() {
        let h = setup();
        let c = StellaxStakingClient::new(&h.env, &h.staking);
        let res = c.try_initialize(&h.admin, &h.stlx, &h.treasury, &EPOCH_SECS);
        assert!(res.is_err());
    }

    #[test]
    fn stake_pulls_tokens_and_updates_total() {
        let h = setup();
        let user = Address::generate(&h.env);
        mint_stlx(&h, &user, 1_000 * USDC_DECIMALS);

        let c = StellaxStakingClient::new(&h.env, &h.staking);
        c.stake(&user, &500);

        let stake = c.get_stake(&user);
        assert_eq!(stake.amount, 500);
        assert_eq!(c.total_staked(), 500);

        let sac = SdkTokenClient::new(&h.env, &h.stlx);
        assert_eq!(sac.balance(&h.staking), 500);
        assert_eq!(sac.balance(&user), 500);
    }

    #[test]
    fn unstake_locked_within_same_epoch() {
        let h = setup();
        let user = Address::generate(&h.env);
        mint_stlx(&h, &user, 1_000);

        let c = StellaxStakingClient::new(&h.env, &h.staking);
        c.stake(&user, &500);

        // Same epoch → locked.
        let res = c.try_unstake(&user, &100);
        assert!(res.is_err());
    }

    #[test]
    fn unstake_succeeds_after_epoch_boundary() {
        let h = setup();
        let user = Address::generate(&h.env);
        mint_stlx(&h, &user, 1_000);

        let c = StellaxStakingClient::new(&h.env, &h.staking);
        c.stake(&user, &500);
        advance_epoch(&h, 1);
        c.unstake(&user, &200);

        let stake = c.get_stake(&user);
        assert_eq!(stake.amount, 300);
        assert_eq!(c.total_staked(), 300);
    }

    #[test]
    fn claim_single_staker_full_pool() {
        let h = setup();
        let user = Address::generate(&h.env);
        mint_stlx(&h, &user, 1_000);
        mint_usdc(&h, &h.treasury, 10_000);

        let c = StellaxStakingClient::new(&h.env, &h.staking);
        c.stake(&user, &500);
        // Treasury deposits in the same epoch — snapshots total_staked = 500.
        c.deposit_epoch_rewards(&h.treasury, &h.usdc, &1_000);

        // Advance so the reward epoch closes.
        advance_epoch(&h, 1);
        let claimed = c.claim_rewards(&user);
        assert_eq!(claimed, 1_000, "sole staker claims full pool");
    }

    #[test]
    fn claim_before_epoch_closes_fails() {
        let h = setup();
        let user = Address::generate(&h.env);
        mint_stlx(&h, &user, 1_000);
        mint_usdc(&h, &h.treasury, 10_000);

        let c = StellaxStakingClient::new(&h.env, &h.staking);
        c.stake(&user, &500);
        c.deposit_epoch_rewards(&h.treasury, &h.usdc, &1_000);

        // No epoch advance yet — claim should error.
        let res = c.try_claim_rewards(&user);
        assert!(res.is_err(), "claim before epoch close must fail");
    }

    #[test]
    fn claim_proportional_three_stakers() {
        let h = setup();
        let a = Address::generate(&h.env);
        let b = Address::generate(&h.env);
        let d = Address::generate(&h.env);
        mint_stlx(&h, &a, 10_000);
        mint_stlx(&h, &b, 10_000);
        mint_stlx(&h, &d, 10_000);
        mint_usdc(&h, &h.treasury, 1_000_000);

        let c = StellaxStakingClient::new(&h.env, &h.staking);
        c.stake(&a, &100); // 50%
        c.stake(&b, &50); //  25%
        c.stake(&d, &50); //  25%
        c.deposit_epoch_rewards(&h.treasury, &h.usdc, &400);

        advance_epoch(&h, 1);
        let claim_a = c.claim_rewards(&a);
        let claim_b = c.claim_rewards(&b);
        let claim_d = c.claim_rewards(&d);

        assert_eq!(claim_a, 200);
        assert_eq!(claim_b, 100);
        assert_eq!(claim_d, 100);
        assert_eq!(claim_a + claim_b + claim_d, 400);
    }

    #[test]
    fn unauthorized_treasury_deposit_fails() {
        let h = setup();
        let stranger = Address::generate(&h.env);
        mint_usdc(&h, &stranger, 10_000);

        let c = StellaxStakingClient::new(&h.env, &h.staking);
        let res = c.try_deposit_epoch_rewards(&stranger, &h.usdc, &1_000);
        assert!(res.is_err(), "only treasury may deposit epoch rewards");
    }
}
