//! Shared `contracttype` structs reused across StellaX contracts.
//!
//! Keeping them in this library guarantees ABI compatibility between the
//! perp engine, vault, risk engine, and options contracts when they perform
//! cross-contract calls.

use soroban_sdk::{contracttype, Address, Symbol};

/// A user's open derivatives position (perp or option leg).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Position {
    pub owner: Address,
    pub market_id: u32,
    /// Position size in base-asset units, 18-decimal precision.
    pub size: i128,
    /// Volume-weighted entry price, 18-decimal precision.
    pub entry_price: i128,
    /// Margin currently locked to this position, 18-decimal USD-equivalent.
    pub margin: i128,
    pub leverage: u32,
    pub is_long: bool,
    /// Snapshot of the funding index at last interaction; used to compute
    /// owed/earned funding without iterating history.
    pub last_funding_idx: i128,
    pub open_timestamp: u64,
}

/// Configuration of a perpetual market. Stored in the perp engine's
/// instance storage and exposed via cross-contract reads.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Market {
    pub market_id: u32,
    pub base_asset: Symbol,
    pub quote_asset: Symbol,
    pub max_leverage: u32,
    pub maker_fee_bps: u32,
    pub taker_fee_bps: u32,
    /// Open-interest cap on the long side, 18-decimal base-asset units.
    pub max_oi_long: i128,
    /// Open-interest cap on the short side.
    pub max_oi_short: i128,
    pub is_active: bool,
}

/// Oracle price reading. `price` is normalized to 18-decimal PRECISION.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    pub price: i128,
    /// Timestamp (ms) attested by the oracle data package.
    pub package_timestamp: u64,
    /// Ledger timestamp (s) when the price was written on-chain.
    pub write_timestamp: u64,
}

/// On-chain options contract, supports both calls and puts.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OptionContract {
    pub option_id: u64,
    pub strike: i128,
    pub expiry: u64,
    pub is_call: bool,
    pub size: i128,
    pub premium: i128,
    pub writer: Address,
    pub holder: Address,
    pub is_exercised: bool,
}

/// Single epoch of a structured product vault (e.g., weekly covered-call cycle).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultEpoch {
    pub epoch_id: u32,
    pub start_time: u64,
    pub end_time: u64,
    pub total_deposits: i128,
    pub total_premium: i128,
    pub settled: bool,
}

/// Margin mode selected by a user — affects how PnL flows between positions.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MarginMode {
    /// Single shared collateral pool across all positions.
    Cross,
    /// Each position has dedicated, segregated collateral.
    Isolated,
}
