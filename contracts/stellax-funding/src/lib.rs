//! StellaX funding rate engine.
//!
//! Phase 5 maintains per-market accumulated funding indices and exposes O(1)
//! settlement helpers that the perp engine can use on every interaction.

#![no_std]
#![allow(deprecated)]

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, Address,
    BytesN, Env, Symbol,
};
use stellax_math::{
    clamp, div_precision_checked, mul_precision_checked, Market, Position, PriceData,
    MAX_FUNDING_RATE_PER_HOUR, MAX_FUNDING_VELOCITY, SECS_PER_HOUR,
    TTL_BUMP_PERSISTENT, TTL_THRESHOLD_PERSISTENT,
};

const CONTRACT_VERSION: u32 = 2;

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum FundingError {
    AlreadyInitialized = 1,
    Unauthorized = 2,
    InvalidConfig = 3,
    MarketNotFound = 4,
    MathOverflow = 5,
    PositionNotFound = 6,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FundingConfig {
    pub admin: Address,
    pub oracle: Address,
    pub perp_engine: Address,
    pub funding_factor: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FundingState {
    pub accumulated_funding_long: i128,
    pub accumulated_funding_short: i128,
    pub last_update_timestamp: u64,
    pub last_funding_rate: i128,
}

/// Phase D — velocity state for one market.
///
/// Stored in a separate `DataKey::FundingVelocity(market_id)` entry so that
/// existing `FundingState` records keep deserialising post-upgrade. Markets
/// that have no velocity record yet default to `{ velocity: 0, current_rate: 0 }`,
/// which makes the velocity path equivalent to a fresh market and the legacy
/// linear-premium path a special case with velocity permanently 0.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FundingVelocityState {
    /// Current rate velocity (rate-units per second).
    pub funding_velocity: i128,
    /// Instantaneous funding rate (per hour) that drifts via velocity integration.
    pub current_rate: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum DataKey {
    Config,
    FundingState(u32),
    /// Phase D: per-market velocity state. Written on every `update_funding`
    /// tick once the contract has been upgraded to v2.
    FundingVelocity(u32),
    Version,
}

#[contractclient(name = "OracleClient")]
pub trait OracleInterface {
    fn get_price(env: Env, asset: Symbol) -> PriceData;
}

#[contractclient(name = "PerpEngineClient")]
pub trait PerpEngineInterface {
    fn get_mark_price(env: Env, market_id: u32) -> i128;
    fn get_market(env: Env, market_id: u32) -> Market;
    fn get_position_by_id(env: Env, position_id: u64) -> Position;
}

#[contract]
pub struct StellaxFunding;

#[contractimpl]
impl StellaxFunding {
    pub fn __constructor(
        env: Env,
        admin: Address,
        oracle: Address,
        perp_engine: Address,
        funding_factor: i128,
    ) -> Result<(), FundingError> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(FundingError::AlreadyInitialized);
        }
        if funding_factor <= 0 {
            return Err(FundingError::InvalidConfig);
        }

        env.storage().instance().set(
            &DataKey::Config,
            &FundingConfig {
                admin,
                oracle,
                perp_engine,
                funding_factor,
            },
        );
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

    pub fn update_funding(env: Env, market_id: u32) -> Result<(), FundingError> {
        bump_instance_ttl(&env);
        let cfg = read_config(&env)?;
        let market = read_market(&env, market_id)?;
        let now = env.ledger().timestamp();
        let mut state = read_or_default_state(&env, market_id, now);
        let mut velocity_state = read_or_default_velocity(&env, market_id);

        if now <= state.last_update_timestamp {
            write_state(&env, market_id, &state);
            write_velocity(&env, market_id, &velocity_state);
            return Ok(());
        }

        let elapsed = now - state.last_update_timestamp;

        // Phase D — velocity funding integration.
        //
        // premium = (mark - index) / index  (PRECISION-scaled)
        // velocity += funding_factor * premium        (per elapsed tick)
        // rate     += velocity * elapsed_secs          (drifts, not jumps)
        // accumulated_delta = rate * elapsed / SECS_PER_HOUR
        //
        // Both `velocity` and `rate` are double-clamped to protocol bounds so
        // pathological premia cannot blow up the integrator.
        let premium = premium_ratio(&env, &cfg, &market)?;
        let velocity_delta =
            mul_precision_checked(premium, cfg.funding_factor).ok_or(FundingError::MathOverflow)?;
        let new_velocity = clamp(
            velocity_state
                .funding_velocity
                .checked_add(velocity_delta)
                .ok_or(FundingError::MathOverflow)?,
            -MAX_FUNDING_VELOCITY,
            MAX_FUNDING_VELOCITY,
        );
        let rate_delta = new_velocity
            .checked_mul(elapsed as i128)
            .ok_or(FundingError::MathOverflow)?;
        let new_rate = clamp(
            velocity_state
                .current_rate
                .checked_add(rate_delta)
                .ok_or(FundingError::MathOverflow)?,
            -MAX_FUNDING_RATE_PER_HOUR,
            MAX_FUNDING_RATE_PER_HOUR,
        );
        let accumulated_delta = prorated_funding_delta(new_rate, elapsed)?;

        state.accumulated_funding_long = state
            .accumulated_funding_long
            .checked_add(accumulated_delta)
            .ok_or(FundingError::MathOverflow)?;
        state.accumulated_funding_short = state
            .accumulated_funding_short
            .checked_sub(accumulated_delta)
            .ok_or(FundingError::MathOverflow)?;
        state.last_update_timestamp = now;
        state.last_funding_rate = new_rate;
        velocity_state.funding_velocity = new_velocity;
        velocity_state.current_rate = new_rate;

        write_state(&env, market_id, &state);
        write_velocity(&env, market_id, &velocity_state);

        env.events().publish(
            (symbol_short!("fundupd"), market_id),
            (new_rate, elapsed, state.accumulated_funding_long),
        );
        Ok(())
    }

    pub fn settle_funding(env: Env, position: Position) -> Result<i128, FundingError> {
        bump_instance_ttl(&env);
        Self::update_funding(env.clone(), position.market_id)?;
        let state = read_or_default_state(&env, position.market_id, env.ledger().timestamp());
        let current_idx = if position.is_long {
            state.accumulated_funding_long
        } else {
            state.accumulated_funding_short
        };
        settle_position_funding(&position, current_idx)
    }

    pub fn get_current_funding_rate(env: Env, market_id: u32) -> Result<i128, FundingError> {
        bump_instance_ttl(&env);
        // Phase D: return the *drifting* current rate (velocity-integrated),
        // not an instantaneous premium snapshot. For markets that have never
        // been ticked since the v2 upgrade, velocity state is all-zero and
        // this returns 0 — callers should invoke `update_funding` to prime it.
        Ok(read_or_default_velocity(&env, market_id).current_rate)
    }

    /// Phase D — expose the current velocity integrator state.
    pub fn get_funding_velocity(env: Env, market_id: u32) -> Result<i128, FundingError> {
        bump_instance_ttl(&env);
        Ok(read_or_default_velocity(&env, market_id).funding_velocity)
    }

    pub fn get_accumulated_funding(env: Env, market_id: u32) -> Result<(i128, i128), FundingError> {
        bump_instance_ttl(&env);
        let now = env.ledger().timestamp();
        let state = read_or_default_state(&env, market_id, now);
        Ok((
            state.accumulated_funding_long,
            state.accumulated_funding_short,
        ))
    }

    pub fn estimate_funding_payment(env: Env, position_id: u64) -> Result<i128, FundingError> {
        bump_instance_ttl(&env);
        let cfg = read_config(&env)?;
        let perp = PerpEngineClient::new(&env, &cfg.perp_engine);
        let position = perp.get_position_by_id(&position_id);
        Self::update_funding(env.clone(), position.market_id)?;
        let state = read_or_default_state(&env, position.market_id, env.ledger().timestamp());
        let current_idx = if position.is_long {
            state.accumulated_funding_long
        } else {
            state.accumulated_funding_short
        };
        settle_position_funding(&position, current_idx)
    }

    pub fn update_config(
        env: Env,
        oracle: Address,
        perp_engine: Address,
        funding_factor: i128,
    ) -> Result<(), FundingError> {
        bump_instance_ttl(&env);
        if funding_factor <= 0 {
            return Err(FundingError::InvalidConfig);
        }

        let mut cfg = read_config(&env)?;
        cfg.admin.require_auth();
        cfg.oracle = oracle;
        cfg.perp_engine = perp_engine;
        cfg.funding_factor = funding_factor;
        env.storage().instance().set(&DataKey::Config, &cfg);
        Ok(())
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), FundingError> {
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

fn bump_instance_ttl(_env: &Env) {
    // No-op: see perp-engine for rationale. TTL extended out-of-band.
}

fn read_config(env: &Env) -> Result<FundingConfig, FundingError> {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(FundingError::InvalidConfig)
}

fn read_market(env: &Env, market_id: u32) -> Result<Market, FundingError> {
    let cfg = read_config(env)?;
    let perp = PerpEngineClient::new(env, &cfg.perp_engine);
    Ok(perp.get_market(&market_id))
}

fn read_or_default_state(env: &Env, market_id: u32, timestamp: u64) -> FundingState {
    let key = DataKey::FundingState(market_id);
    let state = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or(FundingState {
            accumulated_funding_long: 0,
            accumulated_funding_short: 0,
            last_update_timestamp: timestamp,
            last_funding_rate: 0,
        });

    if env.storage().persistent().has(&key) {
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD_PERSISTENT, TTL_BUMP_PERSISTENT);
    }
    state
}

fn write_state(env: &Env, market_id: u32, state: &FundingState) {
    let key = DataKey::FundingState(market_id);
    env.storage().persistent().set(&key, state);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_PERSISTENT, TTL_BUMP_PERSISTENT);
}

/// Legacy V1 helper — instantaneous premium-based rate snapshot. Retained
/// for back-compat with tooling that wants a "what would the rate be right
/// now" view without ticking the velocity integrator. Not called from any
/// on-chain path under Phase D.
#[allow(dead_code)]
fn current_funding_rate(
    env: &Env,
    cfg: &FundingConfig,
    market: &Market,
) -> Result<i128, FundingError> {
    let premium = premium_ratio(env, cfg, market)?;
    let weighted =
        mul_precision_checked(premium, cfg.funding_factor).ok_or(FundingError::MathOverflow)?;
    Ok(clamp(
        weighted,
        -MAX_FUNDING_RATE_PER_HOUR,
        MAX_FUNDING_RATE_PER_HOUR,
    ))
}

/// Phase D helper — unsigned premium ratio `(mark - index) / index`.
fn premium_ratio(env: &Env, cfg: &FundingConfig, market: &Market) -> Result<i128, FundingError> {
    let perp = PerpEngineClient::new(env, &cfg.perp_engine);
    let oracle = OracleClient::new(env, &cfg.oracle);
    let mark_price = perp.get_mark_price(&market.market_id);
    let index_price = oracle.get_price(&market.base_asset).price;
    mark_price
        .checked_sub(index_price)
        .and_then(|delta| div_precision_checked(delta, index_price))
        .ok_or(FundingError::MathOverflow)
}

fn read_or_default_velocity(env: &Env, market_id: u32) -> FundingVelocityState {
    let key = DataKey::FundingVelocity(market_id);
    let state = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or(FundingVelocityState {
            funding_velocity: 0,
            current_rate: 0,
        });
    if env.storage().persistent().has(&key) {
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD_PERSISTENT, TTL_BUMP_PERSISTENT);
    }
    state
}

fn write_velocity(env: &Env, market_id: u32, state: &FundingVelocityState) {
    let key = DataKey::FundingVelocity(market_id);
    env.storage().persistent().set(&key, state);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_PERSISTENT, TTL_BUMP_PERSISTENT);
}

fn prorated_funding_delta(hourly_rate: i128, elapsed_seconds: u64) -> Result<i128, FundingError> {
    hourly_rate
        .checked_mul(elapsed_seconds as i128)
        .and_then(|value| value.checked_div(SECS_PER_HOUR as i128))
        .ok_or(FundingError::MathOverflow)
}

fn settle_position_funding(position: &Position, current_idx: i128) -> Result<i128, FundingError> {
    let funding_delta = current_idx
        .checked_sub(position.last_funding_idx)
        .ok_or(FundingError::MathOverflow)?;
    let payment =
        mul_precision_checked(funding_delta, position.size).ok_or(FundingError::MathOverflow)?;
    Ok(-payment)
}

#[cfg(test)]
mod tests {
    use soroban_sdk::{
        contract, contractimpl, contracttype,
        testutils::{Address as _, Ledger},
        Address,
    };
    use stellax_math::PRECISION;

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
    struct MockPerp;

    #[contracttype]
    #[derive(Clone, Debug, Eq, PartialEq)]
    enum MockPerpKey {
        Market(u32),
        MarkPrice(u32),
        Position(u64),
    }

    #[contractimpl]
    impl MockPerp {
        pub fn set_market(env: Env, market: Market) {
            env.storage()
                .persistent()
                .set(&MockPerpKey::Market(market.market_id), &market);
        }

        pub fn set_mark_price(env: Env, market_id: u32, price: i128) {
            env.storage()
                .persistent()
                .set(&MockPerpKey::MarkPrice(market_id), &price);
        }

        pub fn set_position(env: Env, position_id: u64, position: Position) {
            env.storage()
                .persistent()
                .set(&MockPerpKey::Position(position_id), &position);
        }

        pub fn get_mark_price(env: Env, market_id: u32) -> i128 {
            env.storage()
                .persistent()
                .get(&MockPerpKey::MarkPrice(market_id))
                .unwrap()
        }

        pub fn get_market(env: Env, market_id: u32) -> Market {
            env.storage()
                .persistent()
                .get(&MockPerpKey::Market(market_id))
                .unwrap()
        }

        pub fn get_position_by_id(env: Env, position_id: u64) -> Position {
            env.storage()
                .persistent()
                .get(&MockPerpKey::Position(position_id))
                .unwrap()
        }
    }

    struct Setup {
        env: Env,
        funding: StellaxFundingClient<'static>,
        perp: MockPerpClient<'static>,
    }

    fn setup(mark_price: i128, index_price: i128) -> Setup {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1_000);

        let admin = Address::generate(&env);
        let oracle_id = env.register(MockOracle, ());
        let perp_id = env.register(MockPerp, ());
        let funding_id = env.register(
            StellaxFunding,
            (admin, oracle_id.clone(), perp_id.clone(), PRECISION),
        );

        let oracle = MockOracleClient::new(&env, &oracle_id);
        let perp = MockPerpClient::new(&env, &perp_id);
        let funding = StellaxFundingClient::new(&env, &funding_id);

        let market = Market {
            market_id: 1,
            base_asset: Symbol::new(&env, "BTC"),
            quote_asset: Symbol::new(&env, "USD"),
            max_leverage: 50,
            maker_fee_bps: 2,
            taker_fee_bps: 5,
            max_oi_long: 100 * PRECISION,
            max_oi_short: 100 * PRECISION,
            is_active: true,
        };
        perp.set_market(&market);
        perp.set_mark_price(&1u32, &mark_price);
        oracle.set_price(&Symbol::new(&env, "BTC"), &index_price);

        Setup { env, funding, perp }
    }

    fn sample_position(env: &Env, is_long: bool, last_funding_idx: i128) -> Position {
        Position {
            owner: Address::generate(env),
            market_id: 1,
            size: PRECISION,
            entry_price: 100 * PRECISION,
            margin: 10 * PRECISION,
            leverage: 10,
            is_long,
            last_funding_idx,
            open_timestamp: env.ledger().timestamp(),
        }
    }

    #[test]
    fn rate_is_positive_when_mark_above_index() {
        // Phase D: rate drifts via velocity rather than snapping to premium.
        // One 3600s tick with mark 1% above index and funding_factor=PRECISION:
        //   premium        = 0.01e18 = 1e16
        //   velocity_delta = premium * factor / PRECISION = 1e16
        //   new_velocity   = clamp(0 + 1e16, ±MAX_FUNDING_VELOCITY=1e15) = 1e15
        //   rate_delta     = 1e15 * 3600 = 3.6e18
        //   new_rate       = clamp(0 + 3.6e18, ±MAX_FUNDING_RATE_PER_HOUR=1e15) = 1e15
        let s = setup(101 * PRECISION, 100 * PRECISION);
        s.funding.update_funding(&1u32);
        s.env.ledger().set_timestamp(4_600);
        s.funding.update_funding(&1u32);
        assert_eq!(
            s.funding.get_current_funding_rate(&1u32),
            MAX_FUNDING_RATE_PER_HOUR
        );
    }

    #[test]
    fn rate_is_negative_when_mark_below_index() {
        // Symmetric to `rate_is_positive_*`: clamps to -MAX_FUNDING_RATE_PER_HOUR.
        let s = setup(99 * PRECISION, 100 * PRECISION);
        s.funding.update_funding(&1u32);
        s.env.ledger().set_timestamp(4_600);
        s.funding.update_funding(&1u32);
        assert_eq!(
            s.funding.get_current_funding_rate(&1u32),
            -MAX_FUNDING_RATE_PER_HOUR
        );
    }

    #[test]
    fn funding_rate_is_clamped_to_protocol_max() {
        let s = setup(150 * PRECISION, 100 * PRECISION);
        s.funding.update_funding(&1u32);
        s.env.ledger().set_timestamp(4_600);
        s.funding.update_funding(&1u32);
        assert_eq!(
            s.funding.get_current_funding_rate(&1u32),
            MAX_FUNDING_RATE_PER_HOUR
        );
    }

    /// Phase D — velocity ramps toward the premium instead of jumping. With
    /// small premium (under the velocity clamp), successive ticks should
    /// grow the stored current_rate monotonically.
    #[test]
    fn velocity_ramps_rate_over_successive_ticks() {
        // mark = 100.001 * PRECISION, index = 100 * PRECISION:
        //   premium = 1e16/100 = 1e14
        //   velocity_delta = 1e14 (under MAX_FUNDING_VELOCITY=1e15)
        // First tick (elapsed=1): new_velocity=1e14, rate_delta=1e14, rate=1e14.
        // Second tick (elapsed=1): velocity grows to 2e14, rate_delta=2e14,
        //   rate=3e14. Rate must be strictly increasing across ticks.
        let s = setup(
            100 * PRECISION + 1_000_000_000_000_000, // 100 + 1e15 = 100.001
            100 * PRECISION,
        );
        s.funding.update_funding(&1u32);
        s.env.ledger().set_timestamp(1_001);
        s.funding.update_funding(&1u32);
        let rate_after_first = s.funding.get_current_funding_rate(&1u32);
        s.env.ledger().set_timestamp(1_002);
        s.funding.update_funding(&1u32);
        let rate_after_second = s.funding.get_current_funding_rate(&1u32);
        assert!(rate_after_first > 0);
        assert!(rate_after_second > rate_after_first);
    }

    /// Phase D — reversing the premium sign decelerates the rate. After many
    /// ticks at positive premium we flip to negative and expect the rate to
    /// start decreasing even though it may still be positive for a while.
    #[test]
    fn velocity_decelerates_and_reverses_on_sign_flip() {
        let s = setup(101 * PRECISION, 100 * PRECISION);
        s.funding.update_funding(&1u32);
        s.env.ledger().set_timestamp(4_600);
        s.funding.update_funding(&1u32);
        let peak_rate = s.funding.get_current_funding_rate(&1u32);
        let peak_velocity = s.funding.get_funding_velocity(&1u32);
        assert!(peak_rate > 0);
        assert!(peak_velocity > 0);

        // Flip premium sign — mark now below index.
        s.perp.set_mark_price(&1u32, &(99 * PRECISION));
        s.env.ledger().set_timestamp(4_601);
        s.funding.update_funding(&1u32);
        let next_velocity = s.funding.get_funding_velocity(&1u32);
        // Velocity must *decrease* (it was +1e15 clamped, now moving toward zero).
        assert!(next_velocity < peak_velocity);
    }

    #[test]
    fn update_accumulates_linearly_over_time() {
        let s = setup(101 * PRECISION, 100 * PRECISION);
        s.funding.update_funding(&1u32);
        s.env.ledger().set_timestamp(4_600);
        s.funding.update_funding(&1u32);
        let state_one = s.funding.get_accumulated_funding(&1u32);
        assert_eq!(state_one.0, 1_000_000_000_000_000i128);
        assert_eq!(state_one.1, -1_000_000_000_000_000i128);

        s.env.ledger().set_timestamp(8_200);
        s.funding.update_funding(&1u32);
        let state_two = s.funding.get_accumulated_funding(&1u32);
        assert_eq!(state_two.0, 2_000_000_000_000_000i128);
        assert_eq!(state_two.1, -2_000_000_000_000_000i128);
    }

    #[test]
    fn settle_funding_returns_negative_payment_for_longs_when_mark_above_index() {
        let s = setup(101 * PRECISION, 100 * PRECISION);
        s.funding.update_funding(&1u32);
        s.env.ledger().set_timestamp(4_600);
        let pnl = s.funding.settle_funding(&sample_position(&s.env, true, 0));
        assert_eq!(pnl, -1_000_000_000_000_000i128);
    }

    #[test]
    fn estimate_funding_payment_uses_position_snapshot() {
        let s = setup(101 * PRECISION, 100 * PRECISION);
        let position = sample_position(&s.env, true, 0);
        s.perp.set_position(&7u64, &position);
        s.funding.update_funding(&1u32);
        s.env.ledger().set_timestamp(4_600);

        assert_eq!(
            s.funding.estimate_funding_payment(&7u64),
            -1_000_000_000_000_000i128
        );
    }

    #[test]
    fn zero_rate_when_mark_equals_index() {
        let s = setup(100 * PRECISION, 100 * PRECISION);
        assert_eq!(s.funding.get_current_funding_rate(&1u32), 0);
        s.env.ledger().set_timestamp(4_600);
        s.funding.update_funding(&1u32);
        let state = s.funding.get_accumulated_funding(&1u32);
        assert_eq!(state.0, 0);
        assert_eq!(state.1, 0);
    }
}
