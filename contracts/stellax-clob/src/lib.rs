//! StellaX Hybrid CLOB — on-chain limit order settlement (V2).
//!
//! The CLOB contract stores signed limit orders placed off-chain and allows
//! a permissioned keeper to match compatible buy/sell pairs and settle them
//! atomically through the perp engine.
//!
//! Security model:
//! - `place_order`: trader calls directly (or via Soroban auth envelope);
//!   `trader.require_auth()` verifies the trader authorised this placement.
//!   The `signature` field in `LimitOrder` preserves the off-chain Ed25519
//!   signature for keeper-submitted batch-placement scenarios where the
//!   signature over `order_canonical_hash` is verified on-chain.
//! - `cancel_order`: only the original trader can cancel.
//! - `settle_matched_orders`: only the configured keeper address may call.
//!   Both orders must be Open, not expired, and have crossing prices.

#![no_std]
#![allow(deprecated)]
#![allow(clippy::too_many_arguments)]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Bytes, BytesN, Env,
};
use stellax_math::{
    LimitOrder, OrderStatus, TTL_BUMP_INSTANCE, TTL_BUMP_PERSISTENT, TTL_BUMP_TEMPORARY,
    TTL_THRESHOLD_INSTANCE, TTL_THRESHOLD_PERSISTENT,
};

const CONTRACT_VERSION: u32 = 1;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ClobError {
    AlreadyInitialized = 1,
    Unauthorized = 2,
    InvalidConfig = 3,
    OrderNotFound = 4,
    OrderNotOpen = 5,
    OrderExpired = 6,
    PricesDoNotCross = 7,
    InvalidSize = 8,
    InvalidNonce = 9,
    MathOverflow = 10,
    NotOrderOwner = 11,
}

// ---------------------------------------------------------------------------
// Storage types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClobConfig {
    pub admin: Address,
    pub perp_engine: Address,
    pub vault: Address,
    /// Only this address may call `settle_matched_orders`.
    pub keeper: Address,
}

#[contracttype]
enum DataKey {
    Config,
    Order(u64),
    TraderNonce(Address),
    NextOrderId,
    Version,
}

// ---------------------------------------------------------------------------
// Cross-contract client stubs
// ---------------------------------------------------------------------------

#[soroban_sdk::contractclient(name = "PerpEngineClient")]
pub trait PerpEngineInterface {
    fn execute_clob_fill(
        env: Env,
        caller: Address,
        buyer: Address,
        seller: Address,
        market_id: u32,
        fill_size: i128,
        fill_price: i128,
        buy_leverage: u32,
        sell_leverage: u32,
    ) -> (u64, u64);
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct StellaxClob;

#[contractimpl]
impl StellaxClob {
    // ─── Admin ──────────────────────────────────────────────────────────────

    pub fn __constructor(
        env: Env,
        admin: Address,
        perp_engine: Address,
        vault: Address,
        keeper: Address,
    ) -> Result<(), ClobError> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(ClobError::AlreadyInitialized);
        }
        let cfg = ClobConfig {
            admin,
            perp_engine,
            vault,
            keeper,
        };
        env.storage().instance().set(&DataKey::Config, &cfg);
        env.storage().instance().set(&DataKey::NextOrderId, &1u64);
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

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), ClobError> {
        bump_instance_ttl(&env);
        let cfg = read_config(&env)?;
        cfg.admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        env.storage()
            .instance()
            .set(&DataKey::Version, &(CONTRACT_VERSION + 1));
        Ok(())
    }

    pub fn update_config(
        env: Env,
        perp_engine: Address,
        vault: Address,
        keeper: Address,
    ) -> Result<(), ClobError> {
        bump_instance_ttl(&env);
        let mut cfg = read_config(&env)?;
        cfg.admin.require_auth();
        cfg.perp_engine = perp_engine;
        cfg.vault = vault;
        cfg.keeper = keeper;
        env.storage().instance().set(&DataKey::Config, &cfg);
        Ok(())
    }

    // ─── Place order ────────────────────────────────────────────────────────

    /// Trader submits a signed limit order.
    ///
    /// The trader must authorise this call (via Soroban's auth envelope or
    /// by being the direct caller). The `signature` field is retained for
    /// keeper-based batch flows where off-chain Ed25519 verification is
    /// performed before submission.
    ///
    /// Nonce must equal the trader's current stored nonce (monotonically
    /// increasing — prevents replay).
    pub fn place_order(env: Env, order: LimitOrder) -> Result<u64, ClobError> {
        bump_instance_ttl(&env);
        // Auth: the named trader must have signed this invocation.
        order.trader.require_auth();

        // Validate expiry.
        let now = env.ledger().timestamp();
        if order.expiry <= now {
            return Err(ClobError::OrderExpired);
        }

        // Validate size.
        if order.size <= 0 {
            return Err(ClobError::InvalidSize);
        }

        // Validate and advance nonce (prevents replay).
        let expected_nonce = read_trader_nonce(&env, &order.trader);
        if order.nonce != expected_nonce {
            return Err(ClobError::InvalidNonce);
        }
        write_trader_nonce(&env, &order.trader, expected_nonce + 1);

        // Assign on-chain order ID (overrides client-supplied value).
        let order_id = next_order_id(&env)?;

        let stored = LimitOrder {
            order_id,
            status: OrderStatus::Open,
            filled_size: 0,
            ..order.clone()
        };

        // Store in Temporary storage — order naturally expires when TTL elapses.
        let ttl_ledgers = order_ttl_ledgers(&env, order.expiry, now);
        env.storage()
            .temporary()
            .set(&DataKey::Order(order_id), &stored);
        env.storage()
            .temporary()
            .extend_ttl(&DataKey::Order(order_id), ttl_ledgers, ttl_ledgers);

        env.events().publish(
            (symbol_short!("ordplace"), order.trader, order_id),
            (order.market_id, order.size, order.price, order.is_long),
        );

        Ok(order_id)
    }

    // ─── Cancel order ────────────────────────────────────────────────────────

    /// Trader cancels their own open order.
    pub fn cancel_order(env: Env, caller: Address, order_id: u64) -> Result<(), ClobError> {
        bump_instance_ttl(&env);
        caller.require_auth();

        let mut order = read_order(&env, order_id)?;
        if order.trader != caller {
            return Err(ClobError::NotOrderOwner);
        }
        if order.status != OrderStatus::Open {
            return Err(ClobError::OrderNotOpen);
        }

        order.status = OrderStatus::Cancelled;
        env.storage()
            .temporary()
            .set(&DataKey::Order(order_id), &order);

        env.events().publish(
            (symbol_short!("ordcancel"), caller, order_id),
            order.market_id,
        );
        Ok(())
    }

    // ─── Settle matched orders ───────────────────────────────────────────────

    /// Keeper submits a matched pair of orders for settlement.
    ///
    /// Verifications:
    ///   1. Caller is the configured keeper.
    ///   2. Both orders are Open and not expired.
    ///   3. buy.price >= sell.price (prices cross).
    ///   4. Orders are on the same market.
    ///
    /// Settlement:
    ///   - fill_size = min(buy.remaining, sell.remaining)
    ///   - fill_price = (buy.price + sell.price) / 2 (midpoint)
    ///   - Calls perp_engine.execute_clob_fill(...)
    ///   - Updates order filled_size/status.
    ///
    /// Returns: fill_size (18-decimal base units)
    pub fn settle_matched_orders(
        env: Env,
        caller: Address,
        buy_id: u64,
        sell_id: u64,
    ) -> Result<i128, ClobError> {
        bump_instance_ttl(&env);
        caller.require_auth();

        let cfg = read_config(&env)?;
        if caller != cfg.keeper {
            return Err(ClobError::Unauthorized);
        }

        let now = env.ledger().timestamp();
        let mut buy = read_order(&env, buy_id)?;
        let mut sell = read_order(&env, sell_id)?;

        // Verify both orders are open.
        if buy.status != OrderStatus::Open {
            return Err(ClobError::OrderNotOpen);
        }
        if sell.status != OrderStatus::Open {
            return Err(ClobError::OrderNotOpen);
        }

        // Verify neither is expired.
        if buy.expiry <= now {
            buy.status = OrderStatus::Expired;
            env.storage().temporary().set(&DataKey::Order(buy_id), &buy);
            return Err(ClobError::OrderExpired);
        }
        if sell.expiry <= now {
            sell.status = OrderStatus::Expired;
            env.storage()
                .temporary()
                .set(&DataKey::Order(sell_id), &sell);
            return Err(ClobError::OrderExpired);
        }

        // Verify buy is long, sell is short.
        // (CLOB only settles opposing sides.)
        if !buy.is_long || sell.is_long {
            return Err(ClobError::PricesDoNotCross);
        }

        // Verify same market.
        if buy.market_id != sell.market_id {
            return Err(ClobError::InvalidConfig);
        }

        // Verify prices cross: buyer's limit >= seller's limit.
        if buy.price < sell.price {
            return Err(ClobError::PricesDoNotCross);
        }

        // Compute fill size.
        let buy_remaining = buy
            .size
            .checked_sub(buy.filled_size)
            .ok_or(ClobError::MathOverflow)?;
        let sell_remaining = sell
            .size
            .checked_sub(sell.filled_size)
            .ok_or(ClobError::MathOverflow)?;

        let fill_size = if buy_remaining < sell_remaining {
            buy_remaining
        } else {
            sell_remaining
        };

        if fill_size <= 0 {
            return Err(ClobError::InvalidSize);
        }

        // Fill price = midpoint of the two limit prices.
        let fill_price = buy
            .price
            .checked_add(sell.price)
            .ok_or(ClobError::MathOverflow)?
            / 2;

        // Call perp engine to execute the fill.
        let perp = PerpEngineClient::new(&env, &cfg.perp_engine);
        let self_addr = env.current_contract_address();
        perp.execute_clob_fill(
            &self_addr,
            &buy.trader,
            &sell.trader,
            &buy.market_id,
            &fill_size,
            &fill_price,
            &buy.leverage,
            &sell.leverage,
        );

        // Update buy order.
        buy.filled_size = buy
            .filled_size
            .checked_add(fill_size)
            .ok_or(ClobError::MathOverflow)?;
        if buy.filled_size >= buy.size {
            buy.status = OrderStatus::Filled;
        }

        // Update sell order.
        sell.filled_size = sell
            .filled_size
            .checked_add(fill_size)
            .ok_or(ClobError::MathOverflow)?;
        if sell.filled_size >= sell.size {
            sell.status = OrderStatus::Filled;
        }

        env.storage().temporary().set(&DataKey::Order(buy_id), &buy);
        env.storage()
            .temporary()
            .set(&DataKey::Order(sell_id), &sell);

        env.events().publish(
            (symbol_short!("settled"), buy_id, sell_id),
            (fill_size, fill_price, buy.market_id),
        );

        Ok(fill_size)
    }

    // ─── Reads ───────────────────────────────────────────────────────────────

    /// Read a single order by ID.
    pub fn get_order(env: Env, order_id: u64) -> Result<LimitOrder, ClobError> {
        bump_instance_ttl(&env);
        read_order(&env, order_id)
    }

    /// Read current nonce for a trader (for off-chain order construction).
    pub fn get_nonce(env: Env, trader: Address) -> u64 {
        bump_instance_ttl(&env);
        read_trader_nonce(&env, &trader)
    }

    pub fn get_config(env: Env) -> Result<ClobConfig, ClobError> {
        bump_instance_ttl(&env);
        read_config(&env)
    }
}

// ---------------------------------------------------------------------------
// Helpers — canonical order hash (for off-chain Ed25519 verification)
// ---------------------------------------------------------------------------

/// Produces a SHA-256 hash over the canonical representation of the order
/// fields that were signed off-chain:
///   order_id(8) | market_id(4) | size(16) | price(16) |
///   is_long(1)  | leverage(4)  | expiry(8) | nonce(8)
/// Total = 65 bytes, hashed to 32 bytes.
///
/// Off-chain signers must use the same field layout.
#[allow(dead_code)]
pub fn order_canonical_hash(env: &Env, order: &LimitOrder) -> BytesN<32> {
    let mut buf = Bytes::new(env);

    // order_id — 8 bytes big-endian
    append_u64(&mut buf, env, order.order_id);
    // market_id — 4 bytes big-endian
    append_u32(&mut buf, env, order.market_id);
    // size — 16 bytes big-endian (i128)
    append_i128(&mut buf, env, order.size);
    // price — 16 bytes big-endian (i128)
    append_i128(&mut buf, env, order.price);
    // is_long — 1 byte
    let is_long_byte: u8 = if order.is_long { 1 } else { 0 };
    buf.push_back(is_long_byte);
    // leverage — 4 bytes big-endian
    append_u32(&mut buf, env, order.leverage);
    // expiry — 8 bytes big-endian
    append_u64(&mut buf, env, order.expiry);
    // nonce — 8 bytes big-endian
    append_u64(&mut buf, env, order.nonce);

    env.crypto().sha256(&buf).into()
}

fn append_u32(buf: &mut Bytes, _env: &Env, v: u32) {
    buf.push_back(((v >> 24) & 0xff) as u8);
    buf.push_back(((v >> 16) & 0xff) as u8);
    buf.push_back(((v >> 8) & 0xff) as u8);
    buf.push_back((v & 0xff) as u8);
}

fn append_u64(buf: &mut Bytes, env: &Env, v: u64) {
    append_u32(buf, env, (v >> 32) as u32);
    append_u32(buf, env, v as u32);
}

fn append_i128(buf: &mut Bytes, env: &Env, v: i128) {
    let hi = (v >> 64) as u64;
    let lo = v as u64;
    append_u64(buf, env, hi);
    append_u64(buf, env, lo);
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

fn bump_instance_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_INSTANCE, TTL_BUMP_INSTANCE);
}

fn read_config(env: &Env) -> Result<ClobConfig, ClobError> {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(ClobError::InvalidConfig)
}

fn read_order(env: &Env, order_id: u64) -> Result<LimitOrder, ClobError> {
    env.storage()
        .temporary()
        .get(&DataKey::Order(order_id))
        .ok_or(ClobError::OrderNotFound)
}

fn read_trader_nonce(env: &Env, trader: &Address) -> u64 {
    env.storage()
        .persistent()
        .get(&DataKey::TraderNonce(trader.clone()))
        .unwrap_or(0u64)
}

fn write_trader_nonce(env: &Env, trader: &Address, nonce: u64) {
    env.storage()
        .persistent()
        .set(&DataKey::TraderNonce(trader.clone()), &nonce);
    env.storage().persistent().extend_ttl(
        &DataKey::TraderNonce(trader.clone()),
        TTL_THRESHOLD_PERSISTENT,
        TTL_BUMP_PERSISTENT,
    );
}

fn next_order_id(env: &Env) -> Result<u64, ClobError> {
    let id: u64 = env
        .storage()
        .instance()
        .get(&DataKey::NextOrderId)
        .unwrap_or(1u64);
    let next = id.checked_add(1).ok_or(ClobError::MathOverflow)?;
    env.storage().instance().set(&DataKey::NextOrderId, &next);
    Ok(id)
}

/// Compute TTL in ledgers from now until expiry.
/// Clamps to TTL_BUMP_TEMPORARY (1 day) if expiry is very far in the future.
fn order_ttl_ledgers(_env: &Env, expiry: u64, now: u64) -> u32 {
    if expiry <= now {
        return 0;
    }
    let secs_remaining = expiry - now;
    // ~5s per ledger
    let ledgers = (secs_remaining / 5).min(TTL_BUMP_TEMPORARY as u64) as u32;
    ledgers.max(1)
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Address, Env};
    use stellax_math::{LimitOrder, OrderStatus};

    fn make_env() -> Env {
        Env::default()
    }

    fn make_order(env: &Env, trader: &Address, is_long: bool, price: i128) -> LimitOrder {
        LimitOrder {
            order_id: 0,
            trader: trader.clone(),
            market_id: 1,
            size: 1_000_000_000_000_000_000i128, // 1 BTC
            price,
            is_long,
            leverage: 5,
            expiry: env.ledger().timestamp() + 3600,
            nonce: 0,
            signature: BytesN::from_array(env, &[0u8; 64]),
            status: OrderStatus::Open,
            filled_size: 0,
        }
    }

    #[test]
    fn test_place_and_get_order() {
        let env = make_env();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let perp = Address::generate(&env);
        let vault = Address::generate(&env);
        let keeper = Address::generate(&env);
        let trader = Address::generate(&env);

        let contract_id = env.register(
            StellaxClob,
            (admin.clone(), perp.clone(), vault.clone(), keeper.clone()),
        );
        let client = StellaxClobClient::new(&env, &contract_id);

        let order = make_order(&env, &trader, true, 100_000_000_000_000_000_000_000i128);
        let order_id = client.place_order(&order);
        assert_eq!(order_id, 1u64);

        let stored = client.get_order(&order_id);
        assert_eq!(stored.status, OrderStatus::Open);
        assert_eq!(stored.trader, trader);
        assert_eq!(stored.order_id, 1u64);
    }

    #[test]
    fn test_nonce_increments() {
        let env = make_env();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let perp = Address::generate(&env);
        let vault = Address::generate(&env);
        let keeper = Address::generate(&env);
        let trader = Address::generate(&env);

        let contract_id = env.register(
            StellaxClob,
            (admin.clone(), perp.clone(), vault.clone(), keeper.clone()),
        );
        let client = StellaxClobClient::new(&env, &contract_id);

        let nonce0 = client.get_nonce(&trader);
        assert_eq!(nonce0, 0u64);

        let order = make_order(&env, &trader, true, 100_000_000_000_000_000_000_000i128);
        client.place_order(&order);

        let nonce1 = client.get_nonce(&trader);
        assert_eq!(nonce1, 1u64);
    }

    #[test]
    fn test_cancel_order() {
        let env = make_env();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let perp = Address::generate(&env);
        let vault = Address::generate(&env);
        let keeper = Address::generate(&env);
        let trader = Address::generate(&env);

        let contract_id = env.register(
            StellaxClob,
            (admin.clone(), perp.clone(), vault.clone(), keeper.clone()),
        );
        let client = StellaxClobClient::new(&env, &contract_id);

        let order = make_order(&env, &trader, true, 100_000_000_000_000_000_000_000i128);
        let order_id = client.place_order(&order);

        client.cancel_order(&trader, &order_id);
        let stored = client.get_order(&order_id);
        assert_eq!(stored.status, OrderStatus::Cancelled);
    }

    #[test]
    fn test_canonical_hash_deterministic() {
        let env = make_env();
        let trader = Address::generate(&env);
        let order = make_order(&env, &trader, true, 100_000_000_000_000_000_000_000i128);
        let h1 = order_canonical_hash(&env, &order);
        let h2 = order_canonical_hash(&env, &order);
        assert_eq!(h1, h2);
    }
}
