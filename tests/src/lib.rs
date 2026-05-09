//! StellaX cross-contract integration test harness.
//!
//! This crate wires up the full StellaX protocol stack (oracle/vault/funding/
//! perp/risk) in-memory so integration tests under `tests/tests/*.rs` can
//! exercise realistic end-to-end flows against the real contract
//! implementations (no mocks for the core four modules).
//!
//! The only module that is mocked is the price oracle, because the real
//! `stellax-oracle` contract requires RedStone-signed price payloads that
//! cannot be produced offline. The mock exposes the same `get_price` /
//! `verify_price_payload` surface consumed by the perp engine.

use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Ledger},
    token, vec, Address, Bytes, BytesN, Env, Symbol, Vec,
};

use stellax_math::types::{LimitOrder, Market, OrderStatus, PriceData};
use stellax_vault::CollateralConfig;

// ---------------------------------------------------------------------------
// Mock oracle used in place of the real RedStone-signed oracle contract.
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
enum MockOracleKey {
    Price(Symbol),
}

#[contract]
pub struct MockOracle;

#[contractimpl]
impl MockOracle {
    pub fn set_price(env: Env, asset: Symbol, price: i128) {
        env.storage()
            .persistent()
            .set(&MockOracleKey::Price(asset), &price);
    }

    pub fn get_price(env: Env, asset: Symbol) -> PriceData {
        let price: i128 = env
            .storage()
            .persistent()
            .get(&MockOracleKey::Price(asset))
            .unwrap_or(0);
        PriceData {
            price,
            package_timestamp: env.ledger().timestamp(),
            write_timestamp: env.ledger().timestamp(),
        }
    }

    pub fn verify_price_payload(env: Env, _payload: Bytes, asset: Symbol) -> PriceData {
        Self::get_price(env, asset)
    }
}

// ---------------------------------------------------------------------------
// Test protocol harness.
// ---------------------------------------------------------------------------

/// Internal precision used by StellaX for balances and collateral (18 dp).
pub const PRECISION: i128 = 1_000_000_000_000_000_000;
/// USDC has 6 decimals.
pub const USDC_DECIMALS: u32 = 6;
/// BTC market id used throughout the tests.
pub const BTC_MARKET_ID: u32 = 1;
/// BTC symbol used by the oracle / market.
pub fn btc_symbol(env: &Env) -> Symbol {
    Symbol::new(env, "BTC")
}

/// Fully wired StellaX protocol instance ready for tests.
pub struct Protocol<'a> {
    pub env: Env,

    pub admin: Address,
    pub treasury: Address,
    pub insurance_fund: Address,
    pub user_one: Address,
    pub user_two: Address,
    pub liquidator: Address,

    pub usdc: Address,
    pub usdc_admin: token::StellarAssetClient<'a>,
    pub usdc_token: token::TokenClient<'a>,

    pub oracle_id: Address,
    pub vault_id: Address,
    pub funding_id: Address,
    pub risk_id: Address,
    pub perp_id: Address,
    pub clob_id: Address,
    pub staking_id: Address,
    pub stlx: Address,
    pub stlx_admin: token::StellarAssetClient<'a>,
    pub stlx_token: token::TokenClient<'a>,
    pub keeper: Address,

    pub oracle: MockOracleClient<'a>,
    pub vault: stellax_vault::StellaxVaultClient<'a>,
    pub funding: stellax_funding::StellaxFundingClient<'a>,
    pub risk: stellax_risk::StellaxRiskClient<'a>,
    pub perp: stellax_perp_engine::StellaxPerpEngineClient<'a>,
    pub clob: stellax_clob::StellaxClobClient<'a>,
    pub staking: stellax_staking::StellaxStakingClient<'a>,
}

/// Build a fully wired protocol instance with:
/// - a freshly-registered Stellar Asset Contract USDC (6 dp)
/// - a mock oracle pre-seeded with a BTC price of \$100,000
/// - real vault, funding, risk, and perp engine contracts
/// - one BTC perp market registered and ready to trade
/// - two traders and a liquidator funded with USDC in their wallets (not yet
///   deposited to the vault)
pub fn setup<'a>() -> Protocol<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_700_000_000);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let insurance_fund = Address::generate(&env);
    let user_one = Address::generate(&env);
    let user_two = Address::generate(&env);
    let liquidator = Address::generate(&env);
    let keeper = Address::generate(&env);

    // ---- USDC settlement asset (Stellar Asset Contract, 6 dp) -----------
    let usdc_sac = env.register_stellar_asset_contract_v2(admin.clone());
    let usdc = usdc_sac.address();
    let usdc_admin = token::StellarAssetClient::new(&env, &usdc);
    let usdc_token = token::TokenClient::new(&env, &usdc);
    // Fund traders with 1,000,000 USDC each (raw 6dp units).
    let trader_balance: i128 = 1_000_000_000_000; // 1,000,000 * 10^6
    usdc_admin.mint(&user_one, &trader_balance);
    usdc_admin.mint(&user_two, &trader_balance);
    usdc_admin.mint(&liquidator, &trader_balance);
    // Fund the treasury with 1,000,000 USDC so positive-PnL payouts on
    // `close_position` (move_balance from treasury → user) can settle. In
    // production the treasury accrues USDC from fees; in tests we prefund.
    usdc_admin.mint(&treasury, &trader_balance);

    // ---- Oracle (mock) --------------------------------------------------
    let oracle_id = env.register(MockOracle, ());
    let oracle = MockOracleClient::new(&env, &oracle_id);
    // BTC oracle price: $100 in 18-dp precision. This matches the vAMM
    // reserves we register below (1e21 base / 1e23 quote -> $100 implied),
    // which keeps per-trade slippage small.
    oracle.set_price(&btc_symbol(&env), &(100 * PRECISION));

    // ---- Vault ----------------------------------------------------------
    // The vault constructor needs a `risk` address but risk construction
    // needs the vault address back. Bootstrap the vault with a placeholder
    // risk address and re-wire once the real risk contract is registered.
    let placeholder_risk = Address::generate(&env);
    let placeholder_perp = Address::generate(&env);
    let placeholder_funding = Address::generate(&env);

    let mut callers: Vec<Address> = vec![&env];
    callers.push_back(placeholder_perp.clone()); // replaced after perp is registered.
    let mut collateral: Vec<CollateralConfig> = vec![&env];
    collateral.push_back(CollateralConfig {
        token_address: usdc.clone(),
        asset_symbol: Symbol::new(&env, "USDC"),
        decimals: USDC_DECIMALS,
        haircut_bps: 0,
        max_deposit_cap: 1_000_000_000_000_000_000_000_000_000i128,
        is_active: true,
    });
    // Price USDC at $1.00.
    oracle.set_price(&Symbol::new(&env, "USDC"), &PRECISION);

    let vault_id = env.register(
        stellax_vault::StellaxVault,
        (
            admin.clone(),
            oracle_id.clone(),
            placeholder_risk.clone(),
            treasury.clone(),
            insurance_fund.clone(),
            callers,
            collateral,
        ),
    );
    let vault = stellax_vault::StellaxVaultClient::new(&env, &vault_id);

    // ---- Funding --------------------------------------------------------
    // Funding needs the perp address; bootstrap with a placeholder.
    // funding_factor = 1e14 -> small but non-zero funding factor.
    let funding_id = env.register(
        stellax_funding::StellaxFunding,
        (
            admin.clone(),
            oracle_id.clone(),
            placeholder_perp.clone(),
            100_000_000_000_000i128,
        ),
    );
    let funding = stellax_funding::StellaxFundingClient::new(&env, &funding_id);

    // ---- Risk -----------------------------------------------------------
    let risk_id = env.register(
        stellax_risk::StellaxRisk,
        (
            admin.clone(),
            vault_id.clone(),
            placeholder_perp.clone(),
            funding_id.clone(),
            oracle_id.clone(),
            insurance_fund.clone(),
            treasury.clone(),
            usdc.clone(),
        ),
    );
    let risk = stellax_risk::StellaxRiskClient::new(&env, &risk_id);

    // ---- Perp engine ----------------------------------------------------
    let perp_id = env.register(
        stellax_perp_engine::StellaxPerpEngine,
        (
            admin.clone(),
            oracle_id.clone(),
            vault_id.clone(),
            funding_id.clone(),
            risk_id.clone(),
            treasury.clone(),
            usdc.clone(),
        ),
    );
    let perp = stellax_perp_engine::StellaxPerpEngineClient::new(&env, &perp_id);

    // ---- Re-wire sibling addresses --------------------------------------
    // Swap placeholder perp address in the vault's authorized caller list
    // and in funding/risk configs.
    vault.add_authorized_caller(&perp_id);
    vault.add_authorized_caller(&risk_id);
    vault.update_dependencies(&oracle_id, &risk_id, &treasury, &insurance_fund);

    funding.update_config(&oracle_id, &perp_id, &100_000_000_000_000i128);

    risk.update_dependencies(
        &vault_id,
        &perp_id,
        &funding_id,
        &oracle_id,
        &insurance_fund,
        &treasury,
        &usdc,
    );

    // Perp already has the correct addresses.
    let _ = placeholder_funding; // reserved for future use.

    // ---- Register BTC perp market ---------------------------------------
    let market = Market {
        market_id: BTC_MARKET_ID,
        base_asset: btc_symbol(&env),
        quote_asset: Symbol::new(&env, "USD"),
        max_leverage: 50,
        maker_fee_bps: 2,
        taker_fee_bps: 5,
        max_oi_long: 10_000_000 * PRECISION,
        max_oi_short: 10_000_000 * PRECISION,
        is_active: true,
    };
    perp.register_market(
        &market,
        // min_position_size: 0.00001 BTC at 1e18 precision.
        &(PRECISION / 100_000),
        // skew_scale: 1e22 (same as perp-engine inline tests).
        &10_000_000_000_000_000_000_000i128,
        // maker_rebate_bps: 10 (0.1%).
        &10u32,
    );

    // Seed the treasury's internal vault balance so positive-PnL payouts
    // on `close_position` can move USDC from treasury → user. The perp
    // engine calls `vault.move_balance(treasury, user, ...)` which requires
    // a non-zero internal treasury balance. We fund 1,000,000 USDC worth.
    vault.deposit(&treasury, &usdc, &trader_balance);
    // Re-top the treasury wallet so staking's `deposit_epoch_rewards`
    // (which moves raw USDC tokens, not vault balances) has funds to move.
    usdc_admin.mint(&treasury, &trader_balance);

    // ---- STLX SAC (7 dp) for staking tests ------------------------------
    let stlx_sac = env.register_stellar_asset_contract_v2(admin.clone());
    let stlx = stlx_sac.address();
    let stlx_admin = token::StellarAssetClient::new(&env, &stlx);
    let stlx_token = token::TokenClient::new(&env, &stlx);
    // Mint 1,000,000 STLX (7 dp) to traders and treasury.
    let stlx_balance: i128 = 10_000_000_000_000; // 1,000,000 * 10^7
    stlx_admin.mint(&user_one, &stlx_balance);
    stlx_admin.mint(&user_two, &stlx_balance);
    stlx_admin.mint(&treasury, &stlx_balance);

    // ---- CLOB -----------------------------------------------------------
    let clob_id = env.register(
        stellax_clob::StellaxClob,
        (
            admin.clone(),
            perp_id.clone(),
            vault_id.clone(),
            keeper.clone(),
        ),
    );
    let clob = stellax_clob::StellaxClobClient::new(&env, &clob_id);
    // Register clob with perp engine and authorise it against the vault.
    perp.set_clob(&clob_id);
    vault.add_authorized_caller(&clob_id);

    // ---- Staking --------------------------------------------------------
    let staking_id = env.register(stellax_staking::StellaxStaking, ());
    let staking = stellax_staking::StellaxStakingClient::new(&env, &staking_id);
    // 7-day epochs.
    staking.initialize(&admin, &stlx, &treasury, &604_800u64);

    Protocol {
        env,
        admin,
        treasury,
        insurance_fund,
        user_one,
        user_two,
        liquidator,
        keeper,
        usdc,
        usdc_admin,
        usdc_token,
        oracle_id,
        vault_id,
        funding_id,
        risk_id,
        perp_id,
        clob_id,
        staking_id,
        stlx,
        stlx_admin,
        stlx_token,
        oracle,
        vault,
        funding,
        risk,
        perp,
        clob,
        staking,
    }
}

// ---------------------------------------------------------------------------
// Protocol helpers for new-test ergonomics (J.1).
// ---------------------------------------------------------------------------

impl<'a> Protocol<'a> {
    /// Place a limit order on the CLOB. Returns the assigned order id.
    ///
    /// `size` is in 18-dec base units, `price` in 18-dec USD, `leverage`
    /// follows the perp-engine conventions (max 50). Expiry is 1 hour
    /// into the future; nonce is pulled from the contract.
    pub fn place_limit_order(
        &self,
        trader: &Address,
        market_id: u32,
        size: i128,
        price: i128,
        is_long: bool,
        leverage: u32,
    ) -> u64 {
        let nonce = self.clob.get_nonce(trader);
        let now = self.env.ledger().timestamp();
        let order = LimitOrder {
            order_id: 0,
            trader: trader.clone(),
            market_id,
            size,
            price,
            is_long,
            leverage,
            expiry: now + 3600,
            nonce,
            // 64-byte zero signature: CLOB relies on Soroban auth, not Ed25519.
            signature: BytesN::from_array(&self.env, &[0u8; 64]),
            status: OrderStatus::Open,
            filled_size: 0,
        };
        self.clob.place_order(&order)
    }

    /// Advance the ledger clock by `secs` seconds. Useful for epoch rollovers
    /// (staking) and funding-velocity integration steps.
    pub fn advance_time(&self, secs: u64) {
        let now = self.env.ledger().timestamp();
        self.env.ledger().set_timestamp(now + secs);
    }

    /// Advance one full staking epoch (7 days by default).
    pub fn advance_epoch(&self) {
        let cfg = self.staking.get_config();
        self.advance_time(cfg.epoch_duration_secs + 1);
    }
}
