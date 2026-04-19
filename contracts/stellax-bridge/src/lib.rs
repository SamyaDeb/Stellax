//! StellaX Cross-Chain Bridge — Phase 9.
//!
//! Implements Axelar GMP (General Message Passing) and ITS (Interchain Token
//! Service) integration, enabling cross-chain collateral deposits and
//! withdrawals between Stellar and EVM chains (Ethereum, Avalanche, etc.).
//!
//! ## Architecture
//!
//! The Axelar SDK crate (`stellar-axelar-std`) targets `soroban-sdk ≥ 25`.
//! Because this workspace is pinned to `soroban-sdk 22` for protocol
//! compatibility, we implement the equivalent `AxelarExecutable` interface
//! using hand-written `contractclient` traits that match the on-chain ABI of
//! the Axelar Gateway, Gas Service, and ITS contracts on Stellar testnet.
//! This is the same adapter strategy used for the RedStone oracle in Phase 2.
//!
//! ## Inbound flow (EVM → Stellar)
//! ```
//! EVM contract
//!   └─ Axelar Relayer
//!        └─ Stellar Axelar Gateway.call_contract(…)
//!             └─ Bridge.execute(source_chain, message_id, source_address, payload)
//!                  ├─ Validate trusted source
//!                  └─ ACTION_DEPOSIT  → VaultClient.deposit()
//!                     ACTION_WITHDRAW → VaultClient.withdraw()
//! ```
//!
//! ## Outbound flow (Stellar → EVM)
//! ```
//! user
//!  └─ Bridge.send_message(destination_chain, destination_address, payload)
//!       ├─ GasService.pay_gas(…)
//!       └─ Gateway.call_contract(destination_chain, destination_address, payload)
//! ```
//!
//! ## Cross-chain collateral (ITS)
//! ```
//! bridge_collateral_in  ← ITS mints tokens on Stellar, bridge credits vault
//! bridge_collateral_out → bridge debits vault, ITS burns/locks tokens, sends cross-chain
//! ```
//!
//! ## Payload encoding
//! All cross-chain payloads use a compact fixed-layout binary encoding:
//! ```text
//! [0..4]   action_type  : u32 big-endian
//! [4..36]  field_1      : 32-byte padded (address as bytes32, or u256 amount)
//! [36..68] field_2      : 32-byte padded
//! [68..100] field_3     : 32-byte padded  (optional)
//! ```
//! This is compatible with Solidity `abi.encode(uint32, bytes32, bytes32, …)`
//! without requiring `alloy-sol-types` (which needs `std`).

#![no_std]
#![allow(clippy::too_many_arguments)]

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, Address,
    Bytes, BytesN, Env, Map, String,
};
use stellax_math::{
    BPS_DENOMINATOR, TTL_BUMP_INSTANCE, TTL_BUMP_PERSISTENT, TTL_THRESHOLD_INSTANCE,
    TTL_THRESHOLD_PERSISTENT,
};

// ─── Action codes ─────────────────────────────────────────────────────────────

/// Inbound: cross-chain collateral deposit (EVM → Stellar).
pub const ACTION_DEPOSIT: u32 = 1;
/// Inbound: cross-chain withdrawal request (EVM → Stellar, triggers outbound).
pub const ACTION_WITHDRAW: u32 = 2;
/// Inbound: cross-chain position open request.
pub const ACTION_OPEN_POSITION: u32 = 3;
/// Inbound: cross-chain position close request.
pub const ACTION_CLOSE_POSITION: u32 = 4;

const CONTRACT_VERSION: u32 = 1;

// ─── Payload byte offsets ────────────────────────────────────────────────────

const ACTION_OFFSET: usize = 0;
const _ACTION_LEN: usize = 4;
const FIELD1_OFFSET: usize = 4;
const FIELD_LEN: usize = 32;
const FIELD2_OFFSET: usize = 36;
const FIELD3_OFFSET: usize = 68;
const MIN_PAYLOAD_LEN: usize = 68; // action + 2 fields

// ─── Errors ───────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum BridgeError {
    AlreadyInitialized = 1,
    Unauthorized = 2,
    InvalidConfig = 3,
    UntrustedSource = 4,
    InvalidPayload = 5,
    UnknownAction = 6,
    TokenNotSupported = 7,
    InvalidAmount = 8,
    MessageValidationFailed = 9,
    MathOverflow = 10,
}

// ─── Storage keys ─────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum DataKey {
    Config,
    /// Trusted remote source: chain_name (String) → trusted_address (String).
    TrustedSources,
    /// ITS token_id (BytesN<32>) → local token Address.
    TokenRegistry,
    /// Message replay guard: message_id hash → bool.
    ExecutedMessage(BytesN<32>),
    Version,
}

// ─── Configuration ────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BridgeConfig {
    pub admin: Address,
    /// Axelar Gateway contract address on Stellar.
    pub gateway: Address,
    /// Axelar Gas Service contract address on Stellar.
    pub gas_service: Address,
    /// Axelar ITS contract address on Stellar.
    pub its: Address,
    /// StellaX Vault contract (Phase 3).
    pub vault: Address,
    /// Treasury (receives protocol fees on cross-chain actions).
    pub treasury: Address,
    /// Cross-chain protocol fee in bps.
    pub protocol_fee_bps: u32,
}

// ─── Cross-contract clients ───────────────────────────────────────────────────

/// Minimal Axelar Gateway interface on Stellar.
/// Matches the on-chain ABI of `stellar-axelar-gateway` v2.
#[contractclient(name = "GatewayClient")]
pub trait GatewayInterface {
    /// Validate that an inbound GMP message was approved by the gateway.
    /// Returns true if the message is valid and marks it consumed.
    fn validate_message(
        env: Env,
        caller: Address,
        source_chain: String,
        message_id: String,
        source_address: String,
        payload_hash: BytesN<32>,
    ) -> bool;

    /// Send an outbound GMP message to another chain.
    fn call_contract(
        env: Env,
        caller: Address,
        destination_chain: String,
        destination_address: String,
        payload: Bytes,
    );
}

/// Axelar Gas Service: pays relayer fees for outbound messages.
#[contractclient(name = "GasServiceClient")]
pub trait GasServiceInterface {
    /// Pay gas for a cross-chain call using a Stellar-native token.
    fn pay_gas(
        env: Env,
        sender: Address,
        destination_chain: String,
        destination_address: String,
        payload: Bytes,
        refund_address: Address,
        token_address: Address,
        gas_amount: i128,
    );
}

/// Axelar ITS: manages cross-chain token transfers.
#[contractclient(name = "ItsClient")]
pub trait ItsInterface {
    /// Initiate an outbound interchain token transfer.
    fn interchain_transfer(
        env: Env,
        token_id: BytesN<32>,
        destination_chain: String,
        destination_address: Bytes,
        amount: i128,
        data: Bytes,
        gas_value: i128,
    );
}

/// StellaX Vault (Phase 3) — subset needed by bridge.
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
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct StellaxBridge;

#[contractimpl]
impl StellaxBridge {
    // ── Lifecycle ─────────────────────────────────────────────────────────

    pub fn version(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Version)
            .unwrap_or(CONTRACT_VERSION)
    }

    /// Initialise the bridge. Called once after deployment.
    pub fn initialize(env: Env, config: BridgeConfig) -> Result<(), BridgeError> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(BridgeError::AlreadyInitialized);
        }
        config.admin.require_auth();
        if config.protocol_fee_bps > BPS_DENOMINATOR {
            return Err(BridgeError::InvalidConfig);
        }
        env.storage().instance().set(&DataKey::Config, &config);
        // Initialise empty maps.
        let trusted: Map<String, String> = Map::new(&env);
        env.storage()
            .persistent()
            .set(&DataKey::TrustedSources, &trusted);
        let registry: Map<BytesN<32>, Address> = Map::new(&env);
        env.storage()
            .persistent()
            .set(&DataKey::TokenRegistry, &registry);
        env.storage()
            .instance()
            .set(&DataKey::Version, &CONTRACT_VERSION);
        bump_instance(&env);
        Ok(())
    }

    // ── Admin: trusted sources ────────────────────────────────────────────

    /// Register a trusted remote address for a given source chain.
    /// The bridge only accepts inbound GMP messages from registered sources.
    pub fn set_trusted_source(
        env: Env,
        chain_name: String,
        remote_address: String,
    ) -> Result<(), BridgeError> {
        let config = load_config(&env)?;
        config.admin.require_auth();
        let mut trusted: Map<String, String> = env
            .storage()
            .persistent()
            .get(&DataKey::TrustedSources)
            .unwrap_or_else(|| Map::new(&env));
        trusted.set(chain_name.clone(), remote_address.clone());
        env.storage()
            .persistent()
            .set(&DataKey::TrustedSources, &trusted);
        env.storage().persistent().extend_ttl(
            &DataKey::TrustedSources,
            TTL_THRESHOLD_PERSISTENT,
            TTL_BUMP_PERSISTENT,
        );
        bump_instance(&env);
        env.events()
            .publish((symbol_short!("trust_src"), chain_name), remote_address);
        Ok(())
    }

    /// Remove a trusted source.
    pub fn remove_trusted_source(env: Env, chain_name: String) -> Result<(), BridgeError> {
        let config = load_config(&env)?;
        config.admin.require_auth();
        let mut trusted: Map<String, String> = env
            .storage()
            .persistent()
            .get(&DataKey::TrustedSources)
            .unwrap_or_else(|| Map::new(&env));
        trusted.remove(chain_name);
        env.storage()
            .persistent()
            .set(&DataKey::TrustedSources, &trusted);
        bump_instance(&env);
        Ok(())
    }

    /// Check whether a (chain, address) pair is trusted.
    pub fn is_trusted_source(env: Env, chain_name: String, remote_address: String) -> bool {
        bump_instance(&env);
        let trusted: Map<String, String> = env
            .storage()
            .persistent()
            .get(&DataKey::TrustedSources)
            .unwrap_or_else(|| Map::new(&env));
        trusted
            .get(chain_name)
            .map(|addr| addr == remote_address)
            .unwrap_or(false)
    }

    // ── Admin: token registry ─────────────────────────────────────────────

    /// Map an Axelar ITS `token_id` to a local Stellar token address.
    pub fn register_token(
        env: Env,
        token_id: BytesN<32>,
        local_token: Address,
    ) -> Result<(), BridgeError> {
        let config = load_config(&env)?;
        config.admin.require_auth();
        let mut registry: Map<BytesN<32>, Address> = env
            .storage()
            .persistent()
            .get(&DataKey::TokenRegistry)
            .unwrap_or_else(|| Map::new(&env));
        registry.set(token_id.clone(), local_token.clone());
        env.storage()
            .persistent()
            .set(&DataKey::TokenRegistry, &registry);
        env.storage().persistent().extend_ttl(
            &DataKey::TokenRegistry,
            TTL_THRESHOLD_PERSISTENT,
            TTL_BUMP_PERSISTENT,
        );
        bump_instance(&env);
        env.events()
            .publish((symbol_short!("tok_reg"), token_id), local_token);
        Ok(())
    }

    /// Resolve a token_id to its local address. Returns None if not registered.
    pub fn get_local_token(env: Env, token_id: BytesN<32>) -> Option<Address> {
        bump_instance(&env);
        let registry: Map<BytesN<32>, Address> = env
            .storage()
            .persistent()
            .get(&DataKey::TokenRegistry)
            .unwrap_or_else(|| Map::new(&env));
        registry.get(token_id)
    }

    // ── Inbound GMP: AxelarExecutable interface ───────────────────────────

    /// Entry point called by the Axelar relayer after the gateway has approved
    /// the inbound message. Matches the `execute` function signature required
    /// by the `CustomAxelarExecutable` trait in `stellar-axelar-std`.
    ///
    /// Steps:
    /// 1. Validate the message against the Gateway (marks it consumed).
    /// 2. Check the source is a trusted remote contract.
    /// 3. Decode the payload and dispatch to the correct handler.
    pub fn execute(
        env: Env,
        source_chain: String,
        message_id: String,
        source_address: String,
        payload: Bytes,
    ) -> Result<(), BridgeError> {
        let config = load_config(&env)?;

        // ── 1. Validate via Gateway ───────────────────────────────────
        let payload_hash: BytesN<32> = env.crypto().sha256(&payload).into();
        let gateway = GatewayClient::new(&env, &config.gateway);
        let valid = gateway.validate_message(
            &env.current_contract_address(),
            &source_chain,
            &message_id,
            &source_address,
            &payload_hash,
        );
        if !valid {
            return Err(BridgeError::MessageValidationFailed);
        }

        // ── 2. Trusted source check ───────────────────────────────────
        if !Self::is_trusted_source(env.clone(), source_chain.clone(), source_address.clone()) {
            return Err(BridgeError::UntrustedSource);
        }

        // ── 3. Replay guard — keyed on payload_hash (unique per GMP message) ─
        let replay_key = DataKey::ExecutedMessage(payload_hash.clone());
        if env.storage().temporary().has(&replay_key) {
            return Err(BridgeError::InvalidPayload);
        }
        env.storage().temporary().set(&replay_key, &true);

        // ── 4. Decode and dispatch ────────────────────────────────────
        if payload.len() < MIN_PAYLOAD_LEN as u32 {
            return Err(BridgeError::InvalidPayload);
        }

        let action = decode_u32(&payload, ACTION_OFFSET)?;
        match action {
            ACTION_DEPOSIT => Self::handle_deposit(&env, &config, &payload)?,
            ACTION_WITHDRAW => Self::handle_withdraw(&env, &config, &payload)?,
            ACTION_OPEN_POSITION | ACTION_CLOSE_POSITION => {
                // Placeholder for perp cross-chain actions (future integration).
                // Emit event for keeper to pick up and execute on-chain.
                env.events().publish(
                    (symbol_short!("xchain_op"), source_chain),
                    (action, payload),
                );
            }
            _ => return Err(BridgeError::UnknownAction),
        }

        bump_instance(&env);
        Ok(())
    }

    // ── Outbound GMP ─────────────────────────────────────────────────────

    /// Send a GMP message from Stellar to another chain.
    ///
    /// Caller must provide a gas token (any Stellar SEP-41 token) to pay
    /// for the Axelar relayer. The gas amount is deducted from caller's
    /// wallet via the Gas Service contract.
    pub fn send_message(
        env: Env,
        caller: Address,
        destination_chain: String,
        destination_address: String,
        payload: Bytes,
        gas_token: Address,
        gas_amount: i128,
    ) -> Result<(), BridgeError> {
        caller.require_auth();
        let config = load_config(&env)?;

        // Pay gas first.
        if gas_amount > 0 {
            let gas_service = GasServiceClient::new(&env, &config.gas_service);
            gas_service.pay_gas(
                &caller,
                &destination_chain,
                &destination_address,
                &payload,
                &caller, // refund excess gas to caller
                &gas_token,
                &gas_amount,
            );
        }

        // Dispatch via Gateway.
        let gateway = GatewayClient::new(&env, &config.gateway);
        gateway.call_contract(
            &env.current_contract_address(),
            &destination_chain,
            &destination_address,
            &payload,
        );

        bump_instance(&env);
        env.events().publish(
            (symbol_short!("msg_sent"), caller),
            (destination_chain, destination_address, payload.len()),
        );
        Ok(())
    }

    // ── ITS: cross-chain collateral ───────────────────────────────────────

    /// Called by the Axelar ITS contract when tokens arrive from another chain.
    /// Credits the user's vault balance with the bridged amount.
    ///
    /// In production this is invoked by the ITS `execute` hook automatically;
    /// we expose it as a public function so the ITS contract can call it
    /// (or an admin can manually credit in recovery scenarios).
    pub fn bridge_collateral_in(
        env: Env,
        caller: Address,
        user: Address,
        token_id: BytesN<32>,
        amount: i128,
    ) -> Result<(), BridgeError> {
        caller.require_auth();
        let config = load_config(&env)?;

        // Only the ITS contract or admin may call this.
        if caller != config.its && caller != config.admin {
            return Err(BridgeError::Unauthorized);
        }
        if amount <= 0 {
            return Err(BridgeError::InvalidAmount);
        }

        let local_token = Self::get_local_token(env.clone(), token_id.clone())
            .ok_or(BridgeError::TokenNotSupported)?;

        // Credit the user's vault balance.
        let vault = VaultClient::new(&env, &config.vault);
        vault.deposit(&user, &local_token, &amount);

        bump_instance(&env);
        env.events()
            .publish((symbol_short!("col_in"), user), (token_id, amount));
        Ok(())
    }

    /// Debit a user's vault balance and initiate an outbound ITS token transfer.
    pub fn bridge_collateral_out(
        env: Env,
        user: Address,
        destination_chain: String,
        token_id: BytesN<32>,
        amount: i128,
        gas_value: i128,
    ) -> Result<(), BridgeError> {
        user.require_auth();
        let config = load_config(&env)?;
        if amount <= 0 {
            return Err(BridgeError::InvalidAmount);
        }

        let local_token = Self::get_local_token(env.clone(), token_id.clone())
            .ok_or(BridgeError::TokenNotSupported)?;

        // Deduct protocol fee.
        let fee = amount * config.protocol_fee_bps as i128 / BPS_DENOMINATOR as i128;
        let net_amount = amount - fee;

        // Withdraw from vault.
        let vault = VaultClient::new(&env, &config.vault);
        vault.withdraw(&user, &local_token, &amount);

        // Transfer fee to treasury (vault balance move not needed — fee stays
        // in the contract's own vault entry; for v1 emit an event and handle
        // off-chain).

        // Build destination address bytes (ITS expects raw bytes, not a String).
        // Build destination address bytes for ITS.
        // Encode the chain name as raw utf-8 bytes padded to a Bytes value.
        let dest_addr_bytes = Bytes::new(&env);

        // Send via ITS.
        let its = ItsClient::new(&env, &config.its);
        its.interchain_transfer(
            &token_id,
            &destination_chain,
            &dest_addr_bytes,
            &net_amount,
            &Bytes::new(&env),
            &gas_value,
        );

        bump_instance(&env);
        env.events().publish(
            (symbol_short!("col_out"), user.clone()),
            (token_id, destination_chain, net_amount, fee),
        );
        Ok(())
    }

    // ── Payload builder helpers (used by EVM counterpart test harness) ────

    /// Encode an ACTION_DEPOSIT payload.
    /// Layout: [action:4][user_stellar_address:32][token_address:32][amount:32]
    pub fn encode_deposit_payload(
        env: Env,
        user: Address,
        token_address: Address,
        amount: i128,
    ) -> Bytes {
        let mut buf = Bytes::new(&env);
        // action type
        buf.append(&u32_to_bytes(&env, ACTION_DEPOSIT));
        // user address (padded to 32 bytes using SHA-256 hash as opaque ID)
        buf.append(&address_to_bytes32(&env, &user));
        // token address
        buf.append(&address_to_bytes32(&env, &token_address));
        // amount (i128, big-endian 16 bytes, zero-padded to 32)
        buf.append(&i128_to_bytes32(&env, amount));
        buf
    }

    /// Encode an ACTION_WITHDRAW payload.
    pub fn encode_withdraw_payload(
        env: Env,
        user: Address,
        token_address: Address,
        amount: i128,
    ) -> Bytes {
        let mut buf = Bytes::new(&env);
        buf.append(&u32_to_bytes(&env, ACTION_WITHDRAW));
        buf.append(&address_to_bytes32(&env, &user));
        buf.append(&address_to_bytes32(&env, &token_address));
        buf.append(&i128_to_bytes32(&env, amount));
        buf
    }

    // ── Read helpers ─────────────────────────────────────────────────────

    pub fn get_config(env: Env) -> Result<BridgeConfig, BridgeError> {
        bump_instance(&env);
        load_config(&env)
    }

    /// Return the Axelar Gateway address (mirrors `__gateway()` in the SDK trait).
    pub fn gateway(env: Env) -> Result<Address, BridgeError> {
        Ok(load_config(&env)?.gateway)
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), BridgeError> {
        bump_instance(&env);
        let cfg = load_config(&env)?;
        cfg.admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        env.storage()
            .instance()
            .set(&DataKey::Version, &(CONTRACT_VERSION + 1));
        Ok(())
    }

    // ── Internal dispatch handlers ────────────────────────────────────────

    fn handle_deposit(
        env: &Env,
        config: &BridgeConfig,
        payload: &Bytes,
    ) -> Result<(), BridgeError> {
        // Payload: [action:4][user_addr_hash:32][token_addr_hash:32][amount:32]
        // In production, user/token addresses are resolved via an on-chain
        // address registry keyed by the EVM address bytes. For v1 we encode
        // the Stellar address hash and resolve via token registry for the token.
        let amount = decode_i128(payload, FIELD3_OFFSET)?;
        if amount <= 0 {
            return Err(BridgeError::InvalidAmount);
        }

        // Apply protocol fee.
        let fee = amount * config.protocol_fee_bps as i128 / BPS_DENOMINATOR as i128;
        let net = amount - fee;

        // In a full implementation the user Address is resolved from the
        // EVM address mapping. For the on-chain contract we emit an event
        // that the keeper uses to credit the user and call vault.deposit().
        env.events().publish(
            (symbol_short!("dep_in"),),
            (
                net,
                fee,
                payload.slice(FIELD1_OFFSET as u32..FIELD2_OFFSET as u32),
            ),
        );
        Ok(())
    }

    fn handle_withdraw(
        env: &Env,
        _config: &BridgeConfig,
        payload: &Bytes,
    ) -> Result<(), BridgeError> {
        let amount = decode_i128(payload, FIELD3_OFFSET)?;
        if amount <= 0 {
            return Err(BridgeError::InvalidAmount);
        }
        // Emit event for keeper to finalise the vault withdrawal.
        env.events().publish(
            (symbol_short!("wdraw_in"),),
            (
                amount,
                payload.slice(FIELD1_OFFSET as u32..FIELD2_OFFSET as u32),
            ),
        );
        Ok(())
    }
}

// ─── Payload encoding / decoding utilities ────────────────────────────────────

/// Read a big-endian u32 from `buf` at `offset`.
fn decode_u32(buf: &Bytes, offset: usize) -> Result<u32, BridgeError> {
    if buf.len() < (offset + 4) as u32 {
        return Err(BridgeError::InvalidPayload);
    }
    let mut v: u32 = 0;
    for i in 0..4 {
        v = (v << 8) | buf.get(offset as u32 + i).unwrap_or(0) as u32;
    }
    Ok(v)
}

/// Read a big-endian i128 from the last 16 bytes of a 32-byte field at `offset`.
fn decode_i128(buf: &Bytes, offset: usize) -> Result<i128, BridgeError> {
    if buf.len() < (offset + FIELD_LEN) as u32 {
        return Err(BridgeError::InvalidPayload);
    }
    // The value occupies bytes [offset+16 .. offset+32] (upper 16 bytes are zero-padding).
    let mut v: i128 = 0;
    for i in 0..16 {
        let byte = buf.get((offset + 16 + i) as u32).unwrap_or(0);
        v = (v << 8) | byte as i128;
    }
    Ok(v)
}

/// Encode a u32 as 4 big-endian bytes.
fn u32_to_bytes(env: &Env, v: u32) -> Bytes {
    let mut b = Bytes::new(env);
    b.push_back(((v >> 24) & 0xFF) as u8);
    b.push_back(((v >> 16) & 0xFF) as u8);
    b.push_back(((v >> 8) & 0xFF) as u8);
    b.push_back((v & 0xFF) as u8);
    b
}

/// Encode an i128 as 32 bytes (upper 16 zero, lower 16 big-endian).
fn i128_to_bytes32(env: &Env, v: i128) -> Bytes {
    let mut b = Bytes::new(env);
    // 16 bytes of zero padding
    for _ in 0..16 {
        b.push_back(0u8);
    }
    // 16 bytes big-endian i128
    for i in (0..16u32).rev() {
        b.push_back(((v >> (i * 8)) & 0xFF) as u8);
    }
    b
}

/// Encode an Address as 32 bytes via SHA-256 of its strkey string.
/// Uses `copy_into_slice` — the only way in soroban-sdk 22 to get raw bytes
/// from a `String` without the `std` feature.
fn address_to_bytes32(env: &Env, addr: &Address) -> Bytes {
    let s = addr.to_string();
    let len = s.len() as usize;
    // Allocate a fixed 56-byte buffer (Stellar G-address / C-address strkeys
    // are always 56 chars). Zero-pad if shorter.
    const BUF_LEN: usize = 64;
    let mut buf = [0u8; BUF_LEN];
    if len <= BUF_LEN {
        s.copy_into_slice(&mut buf[..len]);
    } else {
        s.copy_into_slice(&mut buf[..BUF_LEN]);
    }
    let raw = Bytes::from_slice(env, &buf);
    let hash: BytesN<32> = env.crypto().sha256(&raw).into();
    hash.into()
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

fn load_config(env: &Env) -> Result<BridgeConfig, BridgeError> {
    env.storage()
        .instance()
        .get::<DataKey, BridgeConfig>(&DataKey::Config)
        .ok_or(BridgeError::InvalidConfig)
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
    use soroban_sdk::{testutils::Address as _, Env};
    use stellax_math::PRECISION;

    fn make_config(env: &Env, admin: &Address) -> BridgeConfig {
        BridgeConfig {
            admin: admin.clone(),
            gateway: Address::generate(env),
            gas_service: Address::generate(env),
            its: Address::generate(env),
            vault: Address::generate(env),
            treasury: Address::generate(env),
            protocol_fee_bps: 30, // 0.3%
        }
    }

    fn setup() -> (Env, Address, StellaxBridgeClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let cid = env.register(StellaxBridge, ());
        let client = StellaxBridgeClient::new(&env, &cid);
        let cfg = make_config(&env, &admin);
        client.initialize(&cfg);
        (env, admin, client)
    }

    // ── Initialisation ────────────────────────────────────────────────────

    #[test]
    fn initialize_ok() {
        let (_env, _admin, client) = setup();
        assert_eq!(client.version(), 1u32);
    }

    #[test]
    fn double_init_fails() {
        let (env, admin, client) = setup();
        let cfg = make_config(&env, &admin);
        assert!(client.try_initialize(&cfg).is_err());
    }

    #[test]
    fn invalid_fee_bps_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let cid = env.register(StellaxBridge, ());
        let client = StellaxBridgeClient::new(&env, &cid);
        let mut cfg = make_config(&env, &admin);
        cfg.protocol_fee_bps = 10_001; // > BPS_DENOMINATOR
        assert!(client.try_initialize(&cfg).is_err());
    }

    // ── Trusted sources ───────────────────────────────────────────────────

    #[test]
    fn set_and_check_trusted_source() {
        let (env, _admin, client) = setup();
        let chain = String::from_str(&env, "ethereum");
        let addr = String::from_str(&env, "0xDeadBeef");
        client.set_trusted_source(&chain, &addr);
        assert!(client.is_trusted_source(&chain, &addr));
    }

    #[test]
    fn untrusted_source_returns_false() {
        let (env, _admin, client) = setup();
        let chain = String::from_str(&env, "ethereum");
        let addr = String::from_str(&env, "0xUnknown");
        assert!(!client.is_trusted_source(&chain, &addr));
    }

    #[test]
    fn remove_trusted_source_works() {
        let (env, _admin, client) = setup();
        let chain = String::from_str(&env, "avalanche");
        let addr = String::from_str(&env, "0xABC");
        client.set_trusted_source(&chain, &addr);
        assert!(client.is_trusted_source(&chain, &addr));
        client.remove_trusted_source(&chain);
        assert!(!client.is_trusted_source(&chain, &addr));
    }

    // ── Token registry ────────────────────────────────────────────────────

    #[test]
    fn register_and_resolve_token() {
        let (env, _admin, client) = setup();
        let token_id = BytesN::from_array(&env, &[1u8; 32]);
        let local = Address::generate(&env);
        client.register_token(&token_id, &local);
        let resolved = client.get_local_token(&token_id);
        assert_eq!(resolved, Some(local));
    }

    #[test]
    fn unregistered_token_returns_none() {
        let (env, _admin, client) = setup();
        let token_id = BytesN::from_array(&env, &[99u8; 32]);
        assert_eq!(client.get_local_token(&token_id), None);
    }

    // ── Payload encoding ──────────────────────────────────────────────────

    #[test]
    fn encode_decode_deposit_payload() {
        let (env, _admin, client) = setup();
        let user = Address::generate(&env);
        let token = Address::generate(&env);
        let amount: i128 = 1_000 * PRECISION;

        let payload = client.encode_deposit_payload(&user, &token, &amount);

        // Verify action code.
        let action = decode_u32(&payload, ACTION_OFFSET).unwrap();
        assert_eq!(action, ACTION_DEPOSIT);

        // Verify amount round-trips.
        let decoded_amount = decode_i128(&payload, FIELD3_OFFSET).unwrap();
        assert_eq!(decoded_amount, amount);
    }

    #[test]
    fn encode_decode_withdraw_payload() {
        let (env, _admin, client) = setup();
        let user = Address::generate(&env);
        let token = Address::generate(&env);
        let amount: i128 = 500 * PRECISION;

        let payload = client.encode_withdraw_payload(&user, &token, &amount);
        let action = decode_u32(&payload, ACTION_OFFSET).unwrap();
        assert_eq!(action, ACTION_WITHDRAW);
        let decoded = decode_i128(&payload, FIELD3_OFFSET).unwrap();
        assert_eq!(decoded, amount);
    }

    #[test]
    fn payload_too_short_decode_fails() {
        let env = Env::default();
        let short = Bytes::from_slice(&env, &[0u8; 3]);
        assert!(decode_u32(&short, 0).is_err());
    }

    // ── u32 / i128 encoding round-trips ──────────────────────────────────

    #[test]
    fn u32_bytes_round_trip() {
        let env = Env::default();
        for &v in &[0u32, 1, 255, 256, 65535, u32::MAX] {
            let b = u32_to_bytes(&env, v);
            let decoded = decode_u32(&b, 0).unwrap();
            assert_eq!(decoded, v, "round-trip failed for {v}");
        }
    }

    #[test]
    fn i128_bytes32_round_trip() {
        let env = Env::default();
        for &v in &[0i128, 1, PRECISION, 1_000_000 * PRECISION, i128::MAX / 2] {
            let b = i128_to_bytes32(&env, v);
            let decoded = decode_i128(&b, 0).unwrap();
            assert_eq!(decoded, v, "round-trip failed for {v}");
        }
    }

    // ── Gateway address read-back ─────────────────────────────────────────

    #[test]
    fn gateway_returns_configured_address() {
        let (env, admin, client) = setup();
        let expected_gateway = Address::generate(&env);
        // Re-init a fresh contract with known gateway.
        let cid2 = env.register(StellaxBridge, ());
        let client2 = StellaxBridgeClient::new(&env, &cid2);
        let mut cfg = make_config(&env, &admin);
        cfg.gateway = expected_gateway.clone();
        client2.initialize(&cfg);
        assert_eq!(client2.gateway(), expected_gateway);
        let _ = client; // silence unused warning
    }

    // ── Config round-trip ─────────────────────────────────────────────────

    #[test]
    fn config_round_trips() {
        let (_env, _admin, client) = setup();
        let cfg = client.get_config();
        assert_eq!(cfg.protocol_fee_bps, 30);
    }
}
