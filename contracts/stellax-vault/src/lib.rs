//! StellaX collateral vault.
//!
//! Phase 3 implements the protocol's custody and accounting layer for margin
//! collateral. Users deposit supported assets into this contract, which stores
//! balances in 18-decimal internal precision and exposes lock/unlock primitives
//! to the perp/options engines.

#![no_std]
#![allow(clippy::too_many_arguments)]

use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, token,
    Address, BytesN, Env, IntoVal, Symbol, Vec,
};
use stellax_math::{
    apply_haircut, to_precision, to_precision_checked, MarginMode, PriceData, BPS_DENOMINATOR,
    TTL_BUMP_INSTANCE, TTL_BUMP_PERSISTENT, TTL_THRESHOLD_INSTANCE, TTL_THRESHOLD_PERSISTENT,
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
        token_client.transfer(&user, &env.current_contract_address(), &amount);

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

        let total_value = compute_total_collateral_value(&env, &user)?;
        let withdraw_value = collateral_value_for_amount(&env, &collateral, amount_internal)?;
        let margin_requirement = risk_margin_requirement(&env, &user, total_value)?;
        let remaining_value = total_value
            .checked_sub(withdraw_value)
            .ok_or(VaultError::MathOverflow)?;
        if remaining_value < margin_requirement {
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
        let free = total_collateral
            .checked_sub(already_locked)
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
        let cfg = read_config(&env)?;
        cfg.admin.require_auth();
        validate_collateral_config(&collateral)?;

        let key = DataKey::Token(collateral.token_address.clone());
        env.storage().persistent().set(&key, &collateral);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD_PERSISTENT, TTL_BUMP_PERSISTENT);
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

    /// Admin-gated replacement of the vault's sibling module addresses.
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

fn bump_instance_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_INSTANCE, TTL_BUMP_INSTANCE);
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
    let gross = balance_internal
        .checked_mul(price)
        .ok_or(VaultError::MathOverflow)?
        / 1_000_000_000_000_000_000i128;
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
    total
        .checked_sub(required)
        .and_then(|value| value.checked_sub(locked))
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
    }

    struct Setup {
        env: Env,
        user: Address,
        engine: Address,
        usdc: Address,
        xlm: Address,
        vault: StellaxVaultClient<'static>,
        risk: MockRiskClient<'static>,
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
}
