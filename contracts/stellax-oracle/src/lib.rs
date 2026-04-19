//! StellaX RedStone-backed price oracle.
//!
//! Phase 2 implements two data access modes:
//! - **Push**: a keeper submits signed RedStone payloads and verified prices
//!   are written to persistent storage.
//! - **Pull**: a trading transaction can carry a fresh RedStone payload and the
//!   oracle verifies it inline without writing to storage.
//!
//! If a stored RedStone price is stale and a Reflector Pulse oracle is
//! configured for the asset, the oracle falls back to Reflector for that read.

#![no_std]

extern crate alloc;

use alloc::vec;
use alloc::vec::Vec as RustVec;

use redstone::{
    core::{config::Config as RedstoneConfig, process_payload},
    network::StdEnv,
    Crypto, CryptoError, FeedId, RedStoneConfigImpl, SignerAddress, TimestampMillis, Value,
};
use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, Address,
    Bytes, BytesN, Env, Symbol, SymbolStr, TryFromVal, Vec,
};
use stellax_math::{
    to_precision_checked, PriceData, TTL_BUMP_INSTANCE, TTL_BUMP_PERSISTENT,
    TTL_THRESHOLD_INSTANCE, TTL_THRESHOLD_PERSISTENT,
};

const CONTRACT_VERSION: u32 = 1;
const REDSTONE_VALUE_DECIMALS: u32 = 8;

struct Soroban22Crypto<'a> {
    env: &'a Env,
}

impl<'a> Soroban22Crypto<'a> {
    fn new(env: &'a Env) -> Self {
        Self { env }
    }
}

struct Keccak256Output {
    hash: soroban_sdk::crypto::Hash<32>,
    data: [u8; 32],
}

impl Keccak256Output {
    fn new(hash: soroban_sdk::crypto::Hash<32>) -> Self {
        let data = hash.to_array();
        Self { hash, data }
    }
}

impl AsRef<[u8]> for Keccak256Output {
    fn as_ref(&self) -> &[u8] {
        &self.data
    }
}

impl Crypto for Soroban22Crypto<'_> {
    type KeccakOutput = Keccak256Output;

    fn keccak256(&mut self, input: impl AsRef<[u8]>) -> Self::KeccakOutput {
        let soroban_bytes = Bytes::from_slice(self.env, input.as_ref());
        Keccak256Output::new(self.env.crypto().keccak256(&soroban_bytes))
    }

    fn recover_public_key(
        &mut self,
        recovery_byte: u8,
        signature_bytes: impl AsRef<[u8]>,
        message_hash: Self::KeccakOutput,
    ) -> Result<redstone::Bytes, CryptoError> {
        let sig_bytes = signature_bytes.as_ref();
        let Ok(sig_array): Result<[u8; 64], _> = sig_bytes.try_into() else {
            return Err(CryptoError::InvalidSignatureLen(sig_bytes.len()));
        };

        let signature = BytesN::<64>::from_array(self.env, &sig_array);
        let public_key = self.env.crypto().secp256k1_recover(
            &message_hash.hash,
            &signature,
            recovery_byte.into(),
        );

        let mut bytes = [0u8; 65];
        public_key.copy_into_slice(&mut bytes);
        Ok(redstone::Bytes::from(bytes.to_vec()))
    }
}

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum OracleError {
    AlreadyInitialized = 1,
    Unauthorized = 2,
    Paused = 3,
    InvalidConfig = 4,
    AssetNotConfigured = 5,
    InvalidPayload = 6,
    NoVerifiedValues = 7,
    MissingPrice = 8,
    StalePrice = 9,
    PriceOverflow = 10,
    NonMonotonicTimestamp = 11,
    FallbackMissing = 12,
    ReflectorPriceMissing = 13,
    ReflectorPriceStale = 14,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleConfig {
    pub admin: Address,
    /// RedStone signer addresses recovered from payload signatures.
    ///
    /// The implementation stores them as raw bytes instead of `BytesN<33>`
    /// because the actual RedStone Soroban SDK validates recovered signer
    /// addresses (typically 20-byte EVM-style addresses), not compressed
    /// secp256k1 public keys.
    pub signers: Vec<Bytes>,
    pub signer_count_threshold: u32,
    pub max_timestamp_staleness_ms: u64,
    pub feed_ids: Vec<Symbol>,
    pub paused: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FallbackConfig {
    pub reflector_contract: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum DataKey {
    Config,
    LastUpdate,
    Price(Symbol),
    Fallback(Symbol),
    Version,
}

#[contracttype(export = false)]
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum ReflectorAsset {
    Stellar(Address),
    Other(Symbol),
}

#[contracttype(export = false)]
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub struct ReflectorPriceData {
    pub price: i128,
    pub timestamp: u64,
}

#[contractclient(name = "ReflectorPulseClient")]
pub trait ReflectorPulseInterface {
    fn decimals(env: Env) -> u32;
    fn lastprice(env: Env, asset: ReflectorAsset) -> Option<ReflectorPriceData>;
}

#[contract]
pub struct StellaxOracle;

#[contractimpl]
impl StellaxOracle {
    pub fn __constructor(
        env: Env,
        admin: Address,
        signers: Vec<Bytes>,
        signer_count_threshold: u32,
        max_timestamp_staleness_ms: u64,
        feed_ids: Vec<Symbol>,
    ) -> Result<(), OracleError> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(OracleError::AlreadyInitialized);
        }

        validate_config_inputs(
            &env,
            &signers,
            signer_count_threshold,
            &feed_ids,
            max_timestamp_staleness_ms,
        )?;

        let cfg = OracleConfig {
            admin,
            signers,
            signer_count_threshold,
            max_timestamp_staleness_ms,
            feed_ids,
            paused: false,
        };

        env.storage().instance().set(&DataKey::Config, &cfg);
        env.storage().instance().set(&DataKey::LastUpdate, &0u32);
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

    pub fn config(env: Env) -> Result<OracleConfig, OracleError> {
        bump_instance_ttl(&env);
        read_config(&env)
    }

    pub fn last_update(env: Env) -> Result<u32, OracleError> {
        bump_instance_ttl(&env);
        ensure_initialized(&env)?;
        Ok(env
            .storage()
            .instance()
            .get(&DataKey::LastUpdate)
            .unwrap_or(0u32))
    }

    pub fn write_prices(env: Env, payload: Bytes) -> Result<(), OracleError> {
        bump_instance_ttl(&env);

        let cfg = read_config(&env)?;
        ensure_not_paused(&cfg)?;

        let verified = verify_payload_for_feeds(&env, &cfg, &cfg.feed_ids, payload)?;
        if verified.prices.is_empty() {
            return Err(OracleError::NoVerifiedValues);
        }

        let write_timestamp = env.ledger().timestamp();
        for (asset, price) in verified.prices.iter() {
            let key = DataKey::Price(asset.clone());
            if let Some(previous) = env.storage().persistent().get::<_, PriceData>(&key) {
                if previous.package_timestamp >= verified.package_timestamp {
                    return Err(OracleError::NonMonotonicTimestamp);
                }
            }

            let data = PriceData {
                price: *price,
                package_timestamp: verified.package_timestamp,
                write_timestamp,
            };
            env.storage().persistent().set(&key, &data);
            bump_price_ttl(&env, asset);
            env.events().publish(
                (symbol_short!("price_upd"), asset.clone()),
                (data.price, data.package_timestamp),
            );
        }

        env.storage()
            .instance()
            .set(&DataKey::LastUpdate, &env.ledger().sequence());
        Ok(())
    }

    pub fn get_price(env: Env, asset: Symbol) -> Result<PriceData, OracleError> {
        bump_instance_ttl(&env);

        let cfg = read_config(&env)?;
        ensure_not_paused(&cfg)?;

        match read_fresh_stored_price(&env, &cfg, &asset) {
            Ok(price) => Ok(price),
            Err(OracleError::MissingPrice | OracleError::StalePrice) => {
                let fallback = read_reflector_fallback_price(&env, &cfg, &asset)?;
                let fallback_cfg = read_fallback_config(&env, &asset)?;
                env.events().publish(
                    (symbol_short!("fallback"), asset),
                    fallback_cfg.reflector_contract,
                );
                Ok(fallback)
            }
            Err(err) => Err(err),
        }
    }

    pub fn get_prices(env: Env, assets: Vec<Symbol>) -> Result<Vec<PriceData>, OracleError> {
        bump_instance_ttl(&env);

        let mut out = Vec::new(&env);
        for asset in assets.iter() {
            out.push_back(Self::get_price(env.clone(), asset)?);
        }
        Ok(out)
    }

    pub fn verify_price_payload(
        env: Env,
        payload: Bytes,
        feed_id: Symbol,
    ) -> Result<PriceData, OracleError> {
        bump_instance_ttl(&env);

        let cfg = read_config(&env)?;
        ensure_not_paused(&cfg)?;
        ensure_feed_supported(&cfg, &feed_id)?;

        let single_feed = Vec::from_array(&env, [feed_id]);
        let verified = verify_payload_for_feeds(&env, &cfg, &single_feed, payload)?;
        let Some((_, price)) = verified.prices.into_iter().next() else {
            return Err(OracleError::NoVerifiedValues);
        };

        Ok(PriceData {
            price,
            package_timestamp: verified.package_timestamp,
            write_timestamp: env.ledger().timestamp(),
        })
    }

    pub fn update_config(
        env: Env,
        signers: Vec<Bytes>,
        signer_count_threshold: u32,
        max_timestamp_staleness_ms: u64,
        feed_ids: Vec<Symbol>,
    ) -> Result<(), OracleError> {
        bump_instance_ttl(&env);

        let mut cfg = read_config(&env)?;
        cfg.admin.require_auth();

        validate_config_inputs(
            &env,
            &signers,
            signer_count_threshold,
            &feed_ids,
            max_timestamp_staleness_ms,
        )?;

        cfg.signers = signers;
        cfg.signer_count_threshold = signer_count_threshold;
        cfg.max_timestamp_staleness_ms = max_timestamp_staleness_ms;
        cfg.feed_ids = feed_ids;

        write_config(&env, &cfg);
        env.events()
            .publish((symbol_short!("cfg_upd"),), cfg.signer_count_threshold);
        Ok(())
    }

    pub fn update_admin(env: Env, new_admin: Address) -> Result<(), OracleError> {
        bump_instance_ttl(&env);

        let mut cfg = read_config(&env)?;
        cfg.admin.require_auth();
        cfg.admin = new_admin.clone();
        write_config(&env, &cfg);
        env.events().publish((symbol_short!("admin"),), new_admin);
        Ok(())
    }

    pub fn set_fallback(
        env: Env,
        asset: Symbol,
        reflector_contract: Address,
    ) -> Result<(), OracleError> {
        bump_instance_ttl(&env);

        let cfg = read_config(&env)?;
        cfg.admin.require_auth();

        let key = DataKey::Fallback(asset.clone());
        env.storage()
            .persistent()
            .set(&key, &FallbackConfig { reflector_contract });
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD_PERSISTENT, TTL_BUMP_PERSISTENT);
        Ok(())
    }

    pub fn remove_fallback(env: Env, asset: Symbol) -> Result<(), OracleError> {
        bump_instance_ttl(&env);

        let cfg = read_config(&env)?;
        cfg.admin.require_auth();
        env.storage().persistent().remove(&DataKey::Fallback(asset));
        Ok(())
    }

    pub fn pause(env: Env) -> Result<(), OracleError> {
        bump_instance_ttl(&env);

        let mut cfg = read_config(&env)?;
        cfg.admin.require_auth();
        cfg.paused = true;
        write_config(&env, &cfg);
        env.events().publish((symbol_short!("paused"),), true);
        Ok(())
    }

    pub fn unpause(env: Env) -> Result<(), OracleError> {
        bump_instance_ttl(&env);

        let mut cfg = read_config(&env)?;
        cfg.admin.require_auth();
        cfg.paused = false;
        write_config(&env, &cfg);
        env.events().publish((symbol_short!("paused"),), false);
        Ok(())
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), OracleError> {
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

struct VerifiedPayload {
    package_timestamp: u64,
    prices: RustVec<(Symbol, i128)>,
}

fn ensure_initialized(env: &Env) -> Result<(), OracleError> {
    if env.storage().instance().has(&DataKey::Config) {
        Ok(())
    } else {
        Err(OracleError::InvalidConfig)
    }
}

fn read_config(env: &Env) -> Result<OracleConfig, OracleError> {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(OracleError::InvalidConfig)
}

fn write_config(env: &Env, cfg: &OracleConfig) {
    env.storage().instance().set(&DataKey::Config, cfg);
}

fn bump_instance_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_INSTANCE, TTL_BUMP_INSTANCE);
}

fn bump_price_ttl(env: &Env, asset: &Symbol) {
    env.storage().persistent().extend_ttl(
        &DataKey::Price(asset.clone()),
        TTL_THRESHOLD_PERSISTENT,
        TTL_BUMP_PERSISTENT,
    );
}

fn ensure_not_paused(cfg: &OracleConfig) -> Result<(), OracleError> {
    if cfg.paused {
        Err(OracleError::Paused)
    } else {
        Ok(())
    }
}

fn current_time_ms(env: &Env) -> u64 {
    env.ledger().timestamp().saturating_mul(1000)
}

fn validate_config_inputs(
    env: &Env,
    signers: &Vec<Bytes>,
    signer_count_threshold: u32,
    feed_ids: &Vec<Symbol>,
    max_timestamp_staleness_ms: u64,
) -> Result<(), OracleError> {
    if signers.is_empty()
        || feed_ids.is_empty()
        || signer_count_threshold == 0
        || max_timestamp_staleness_ms == 0
    {
        return Err(OracleError::InvalidConfig);
    }

    let signers = signer_addresses(signers);
    let feed_ids = redstone_feed_ids(env, feed_ids)?;

    RedstoneConfig::try_new(
        signer_count_threshold
            .try_into()
            .map_err(|_| OracleError::InvalidConfig)?,
        signers,
        feed_ids,
        TimestampMillis::from(current_time_ms(env)),
        Some(TimestampMillis::from(max_timestamp_staleness_ms)),
        None,
    )
    .map_err(|_| OracleError::InvalidConfig)?;

    Ok(())
}

fn signer_addresses(signers: &Vec<Bytes>) -> RustVec<SignerAddress> {
    let mut out = RustVec::new();
    for signer in signers.iter() {
        let mut bytes = vec![0u8; signer.len() as usize];
        signer.copy_into_slice(&mut bytes);
        out.push(SignerAddress::from(bytes));
    }
    out
}

fn symbol_bytes(env: &Env, symbol: &Symbol) -> Result<RustVec<u8>, OracleError> {
    let symbol_val = symbol.to_symbol_val();
    let symbol_str =
        SymbolStr::try_from_val(env, &symbol_val).map_err(|_| OracleError::InvalidConfig)?;
    let bytes: &[u8] = <SymbolStr as AsRef<[u8]>>::as_ref(&symbol_str);
    Ok(bytes.to_vec())
}

fn symbol_to_feed_id(env: &Env, symbol: &Symbol) -> Result<FeedId, OracleError> {
    Ok(FeedId::from(symbol_bytes(env, symbol)?))
}

fn redstone_feed_ids(env: &Env, feed_ids: &Vec<Symbol>) -> Result<RustVec<FeedId>, OracleError> {
    let mut out = RustVec::new();
    for feed in feed_ids.iter() {
        out.push(symbol_to_feed_id(env, &feed)?);
    }
    Ok(out)
}

fn build_redstone_config<'a>(
    env: &'a Env,
    cfg: &OracleConfig,
    feed_ids: &Vec<Symbol>,
) -> Result<RedStoneConfigImpl<Soroban22Crypto<'a>, StdEnv>, OracleError> {
    let config = RedstoneConfig::try_new(
        cfg.signer_count_threshold
            .try_into()
            .map_err(|_| OracleError::InvalidConfig)?,
        signer_addresses(&cfg.signers),
        redstone_feed_ids(env, feed_ids)?,
        TimestampMillis::from(current_time_ms(env)),
        Some(TimestampMillis::from(cfg.max_timestamp_staleness_ms)),
        None,
    )
    .map_err(|_| OracleError::InvalidPayload)?;

    Ok((config, Soroban22Crypto::new(env)).into())
}

fn verify_payload_for_feeds(
    env: &Env,
    cfg: &OracleConfig,
    feed_ids: &Vec<Symbol>,
    payload: Bytes,
) -> Result<VerifiedPayload, OracleError> {
    let mut redstone_cfg = build_redstone_config(env, cfg, feed_ids)?;
    let mut payload_bytes = vec![0u8; payload.len() as usize];
    payload.copy_into_slice(&mut payload_bytes);

    let validated = process_payload(&mut redstone_cfg, payload_bytes)
        .map_err(|_| OracleError::InvalidPayload)?;

    let package_timestamp = validated.timestamp.as_millis();
    let mut prices = RustVec::new();

    for feed_value in validated.values {
        let Some(asset) = resolve_symbol_for_feed(env, feed_ids, feed_value.feed) else {
            continue;
        };
        prices.push((asset, normalize_redstone_value(feed_value.value)?));
    }

    Ok(VerifiedPayload {
        package_timestamp,
        prices,
    })
}

fn resolve_symbol_for_feed(env: &Env, feed_ids: &Vec<Symbol>, feed: FeedId) -> Option<Symbol> {
    feed_ids
        .iter()
        .find(|configured| symbol_to_feed_id(env, configured).ok() == Some(feed))
}

fn redstone_value_to_u128(value: Value) -> Result<u128, OracleError> {
    let bytes = value.as_be_bytes();
    if bytes[..16].iter().any(|byte| *byte != 0) {
        return Err(OracleError::PriceOverflow);
    }
    let mut low = [0u8; 16];
    low.copy_from_slice(&bytes[16..]);
    Ok(u128::from_be_bytes(low))
}

fn normalize_redstone_value(value: Value) -> Result<i128, OracleError> {
    let raw = redstone_value_to_u128(value)?;
    let raw_i128 = i128::try_from(raw).map_err(|_| OracleError::PriceOverflow)?;
    to_precision_checked(raw_i128, REDSTONE_VALUE_DECIMALS, 18).ok_or(OracleError::PriceOverflow)
}

fn ensure_feed_supported(cfg: &OracleConfig, feed_id: &Symbol) -> Result<(), OracleError> {
    for configured in cfg.feed_ids.iter() {
        if configured == *feed_id {
            return Ok(());
        }
    }
    Err(OracleError::AssetNotConfigured)
}

fn read_fresh_stored_price(
    env: &Env,
    cfg: &OracleConfig,
    asset: &Symbol,
) -> Result<PriceData, OracleError> {
    ensure_feed_supported(cfg, asset)?;

    let key = DataKey::Price(asset.clone());
    let Some(price) = env.storage().persistent().get::<_, PriceData>(&key) else {
        return Err(OracleError::MissingPrice);
    };

    bump_price_ttl(env, asset);

    let age_ms = current_time_ms(env).saturating_sub(price.write_timestamp.saturating_mul(1000));
    if age_ms >= cfg.max_timestamp_staleness_ms {
        return Err(OracleError::StalePrice);
    }

    Ok(price)
}

fn read_fallback_config(env: &Env, asset: &Symbol) -> Result<FallbackConfig, OracleError> {
    let key = DataKey::Fallback(asset.clone());
    let cfg = env
        .storage()
        .persistent()
        .get::<_, FallbackConfig>(&key)
        .ok_or(OracleError::FallbackMissing)?;

    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_PERSISTENT, TTL_BUMP_PERSISTENT);
    Ok(cfg)
}

fn read_reflector_fallback_price(
    env: &Env,
    cfg: &OracleConfig,
    asset: &Symbol,
) -> Result<PriceData, OracleError> {
    ensure_feed_supported(cfg, asset)?;

    let fallback = read_fallback_config(env, asset)?;
    let client = ReflectorPulseClient::new(env, &fallback.reflector_contract);
    let decimals = client.decimals();
    let recent = client
        .lastprice(&ReflectorAsset::Other(asset.clone()))
        .ok_or(OracleError::ReflectorPriceMissing)?;

    let age_ms = current_time_ms(env).saturating_sub(recent.timestamp.saturating_mul(1000));
    if age_ms >= cfg.max_timestamp_staleness_ms {
        return Err(OracleError::ReflectorPriceStale);
    }

    let normalized_price =
        to_precision_checked(recent.price, decimals, 18).ok_or(OracleError::PriceOverflow)?;

    Ok(PriceData {
        price: normalized_price,
        package_timestamp: recent.timestamp.saturating_mul(1000),
        write_timestamp: env.ledger().timestamp(),
    })
}

#[cfg(test)]
mod tests {
    extern crate std;

    use std::string::String as StdString;

    use hex::decode;
    use redstone_testing::{
        package_signers::Signers,
        sample::{sample_btc_eth_3sig, sample_eth_2sig, sample_eth_3sig, sample_eth_3sig_newer},
    };
    use soroban_sdk::{
        contract, contractimpl, contracttype,
        testutils::{Address as _, Ledger},
        Address,
    };
    use stellax_math::to_precision;

    use super::*;

    #[contracttype]
    #[derive(Clone, Debug, Eq, PartialEq)]
    enum MockReflectorKey {
        Decimals,
        Price(ReflectorAsset),
    }

    #[contract]
    struct MockReflector;

    #[contractimpl]
    impl MockReflector {
        pub fn __constructor(env: Env, decimals: u32) {
            env.storage()
                .instance()
                .set(&MockReflectorKey::Decimals, &decimals);
        }

        pub fn decimals(env: Env) -> u32 {
            env.storage()
                .instance()
                .get(&MockReflectorKey::Decimals)
                .unwrap_or(7u32)
        }

        pub fn lastprice(env: Env, asset: ReflectorAsset) -> Option<ReflectorPriceData> {
            env.storage()
                .persistent()
                .get(&MockReflectorKey::Price(asset))
        }

        pub fn set_price(env: Env, asset: ReflectorAsset, price: i128, timestamp: u64) {
            env.storage().persistent().set(
                &MockReflectorKey::Price(asset),
                &ReflectorPriceData { price, timestamp },
            );
        }
    }

    fn decode_payload(hex_payload: &str) -> RustVec<u8> {
        let compact: StdString = hex_payload.split_whitespace().collect();
        decode(compact).unwrap()
    }

    fn signer_bytes(env: &Env, signers: Signers) -> Vec<Bytes> {
        let mut out = Vec::new(env);
        for signer in signers.get_signers() {
            out.push_back(Bytes::from_slice(env, &decode(signer).unwrap()));
        }
        out
    }

    fn sample_value_to_u128(value: redstone::Value) -> u128 {
        redstone_value_to_u128(value).unwrap()
    }

    fn setup_oracle<'a>(
        env: &'a Env,
        admin: &Address,
        signers: Signers,
        threshold: u32,
        max_staleness_ms: u64,
        feed_ids: &[&str],
    ) -> StellaxOracleClient<'a> {
        let mut soroban_feeds = Vec::new(env);
        for feed in feed_ids {
            soroban_feeds.push_back(Symbol::new(env, feed));
        }
        let contract_id = env.register(
            StellaxOracle,
            (
                admin.clone(),
                signer_bytes(env, signers),
                threshold,
                max_staleness_ms,
                soroban_feeds,
            ),
        );
        StellaxOracleClient::new(env, &contract_id)
    }

    #[test]
    fn write_prices_and_get_price() {
        let env = Env::default();
        env.mock_all_auths();

        let sample = sample_eth_3sig();
        env.ledger().set_timestamp(sample.system_timestamp / 1000);

        let admin = Address::generate(&env);
        let client = setup_oracle(&env, &admin, sample.signers, 3, 60_000, &["ETH"]);

        let payload = Bytes::from_slice(&env, &decode_payload(sample.content));
        client.write_prices(&payload);

        let price = client.get_price(&Symbol::new(&env, "ETH"));
        let expected_raw = sample_value_to_u128(sample.values["ETH"]);
        let expected = to_precision(expected_raw as i128, REDSTONE_VALUE_DECIMALS, 18);

        assert_eq!(price.price, expected);
        assert_eq!(price.package_timestamp, sample.timestamp);
        assert_eq!(price.write_timestamp, sample.system_timestamp / 1000);
        assert_eq!(client.last_update(), env.ledger().sequence());
    }

    #[test]
    fn get_prices_batches_multiple_assets() {
        let env = Env::default();
        env.mock_all_auths();

        let sample = sample_btc_eth_3sig();
        env.ledger().set_timestamp(sample.system_timestamp / 1000);

        let admin = Address::generate(&env);
        let client = setup_oracle(&env, &admin, sample.signers, 3, 60_000, &["ETH", "BTC"]);

        let payload = Bytes::from_slice(&env, &decode_payload(sample.content));
        client.write_prices(&payload);

        let prices = client.get_prices(&Vec::from_array(
            &env,
            [Symbol::new(&env, "ETH"), Symbol::new(&env, "BTC")],
        ));

        assert_eq!(prices.len(), 2);
        assert_eq!(
            prices.get(0).unwrap().price,
            to_precision(
                sample_value_to_u128(sample.values["ETH"]) as i128,
                REDSTONE_VALUE_DECIMALS,
                18
            )
        );
        assert_eq!(
            prices.get(1).unwrap().price,
            to_precision(
                sample_value_to_u128(sample.values["BTC"]) as i128,
                REDSTONE_VALUE_DECIMALS,
                18
            )
        );
    }

    #[test]
    fn verify_price_payload_does_not_write_storage() {
        let env = Env::default();
        env.mock_all_auths();

        let sample = sample_eth_3sig();
        env.ledger().set_timestamp(sample.system_timestamp / 1000);

        let admin = Address::generate(&env);
        let client = setup_oracle(&env, &admin, sample.signers, 3, 60_000, &["ETH"]);
        let payload = Bytes::from_slice(&env, &decode_payload(sample.content));

        let verified = client.verify_price_payload(&payload, &Symbol::new(&env, "ETH"));
        assert_eq!(verified.package_timestamp, sample.timestamp);
        assert_eq!(client.last_update(), 0);
        assert_eq!(
            client.try_get_price(&Symbol::new(&env, "ETH")),
            Err(Ok(OracleError::FallbackMissing))
        );
    }

    #[test]
    fn stale_redstone_price_uses_reflector_fallback() {
        let env = Env::default();
        env.mock_all_auths();

        let sample = sample_eth_3sig();
        env.ledger().set_timestamp(sample.system_timestamp / 1000);

        let admin = Address::generate(&env);
        let client = setup_oracle(&env, &admin, sample.signers, 3, 60_000, &["ETH"]);

        let payload = Bytes::from_slice(&env, &decode_payload(sample.content));
        client.write_prices(&payload);

        let reflector_id = env.register(MockReflector, (7u32,));
        let reflector = MockReflectorClient::new(&env, &reflector_id);
        reflector.set_price(
            &ReflectorAsset::Other(Symbol::new(&env, "ETH")),
            &16_000_000_000i128,
            &(sample.system_timestamp / 1000 + 120),
        );

        client.set_fallback(&Symbol::new(&env, "ETH"), &reflector_id);

        env.ledger()
            .set_timestamp(sample.system_timestamp / 1000 + 121);

        let fallback = client.get_price(&Symbol::new(&env, "ETH"));
        assert_eq!(fallback.price, to_precision(16_000_000_000i128, 7, 18));
        assert_eq!(
            fallback.package_timestamp,
            (sample.system_timestamp / 1000 + 120) * 1000
        );
    }

    #[test]
    fn write_prices_rejects_payload_below_threshold() {
        let env = Env::default();
        env.mock_all_auths();

        let sample = sample_eth_2sig();
        env.ledger().set_timestamp(sample.system_timestamp / 1000);

        let admin = Address::generate(&env);
        let client = setup_oracle(&env, &admin, Signers::Avax, 3, 60_000, &["ETH"]);

        let payload = Bytes::from_slice(&env, &decode_payload(sample.content));
        assert_eq!(
            client.try_write_prices(&payload),
            Err(Ok(OracleError::NoVerifiedValues))
        );
    }

    #[test]
    fn get_price_rejects_stale_without_fallback() {
        let env = Env::default();
        env.mock_all_auths();

        let sample = sample_eth_3sig();
        env.ledger().set_timestamp(sample.system_timestamp / 1000);

        let admin = Address::generate(&env);
        let client = setup_oracle(&env, &admin, sample.signers, 3, 60_000, &["ETH"]);

        let payload = Bytes::from_slice(&env, &decode_payload(sample.content));
        client.write_prices(&payload);

        env.ledger()
            .set_timestamp(sample.system_timestamp / 1000 + 61);
        assert_eq!(
            client.try_get_price(&Symbol::new(&env, "ETH")),
            Err(Ok(OracleError::FallbackMissing))
        );
    }

    #[test]
    fn pause_and_unpause_gate_reads() {
        let env = Env::default();
        env.mock_all_auths();

        let sample = sample_eth_3sig();
        env.ledger().set_timestamp(sample.system_timestamp / 1000);

        let admin = Address::generate(&env);
        let client = setup_oracle(&env, &admin, sample.signers, 3, 60_000, &["ETH"]);

        client.pause();
        assert_eq!(
            client.try_get_price(&Symbol::new(&env, "ETH")),
            Err(Ok(OracleError::Paused))
        );
        client.unpause();

        let payload = Bytes::from_slice(&env, &decode_payload(sample.content));
        client.write_prices(&payload);
        let _ = client.get_price(&Symbol::new(&env, "ETH"));
    }

    #[test]
    fn rejects_non_increasing_package_timestamps() {
        let env = Env::default();
        env.mock_all_auths();

        let sample = sample_eth_3sig();
        let newer = sample_eth_3sig_newer();
        env.ledger().set_timestamp(sample.system_timestamp / 1000);

        let admin = Address::generate(&env);
        let client = setup_oracle(&env, &admin, sample.signers, 3, 60_000, &["ETH"]);

        let first = Bytes::from_slice(&env, &decode_payload(sample.content));
        client.write_prices(&first);

        let second = Bytes::from_slice(&env, &decode_payload(sample.content));
        assert_eq!(
            client.try_write_prices(&second),
            Err(Ok(OracleError::NonMonotonicTimestamp))
        );

        env.ledger().set_timestamp(newer.system_timestamp / 1000);
        let third = Bytes::from_slice(&env, &decode_payload(newer.content));
        client.write_prices(&third);
    }
}
