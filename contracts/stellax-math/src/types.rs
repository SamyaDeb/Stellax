//! Shared `contracttype` structs reused across StellaX contracts.
//!
//! Keeping them in this library guarantees ABI compatibility between the
//! perp engine, vault, risk engine, and options contracts when they perform
//! cross-contract calls.

use soroban_sdk::{contracttype, Address, Map, Symbol};

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

/// Per-market skew tracking for oracle-price perp execution (V2).
/// Replaces VammState. Execution price = oracle ± skew fee.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkewState {
    /// Cumulative OI imbalance in base units (long - short), 18-dec.
    pub skew: i128,
    /// Governance-set scaling factor for skew fee (e.g. 1e14 = 0.01%).
    pub skew_scale: i128,
    /// Maker rebate in bps (negative fee for adding liquidity to the thin side).
    pub maker_rebate_bps: u32,
}

/// Status of a limit order in the CLOB.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OrderStatus {
    Open,
    Filled,
    Cancelled,
    Expired,
}

/// Aggregated Greek values across all open positions for a user.
/// Used by the risk engine to compute portfolio margin (Phase C).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PortfolioGreeks {
    /// Net delta per market (market_id → net_delta in base units, 18-dec).
    /// Positive = net long, negative = net short.
    pub net_delta: Map<u32, i128>,
    /// Notional value of all open positions, USD 18-dec.
    pub total_notional: i128,
    /// Net portfolio delta magnitude (sum of |net_delta_i * price_i|), USD 18-dec.
    pub net_delta_notional: i128,
}

/// Result of portfolio-aware margin calculation (Phase C).
/// `portfolio_margin_required` can be substantially lower than the sum of
/// individual per-position margins when a user has offsetting perp + option
/// positions on the same underlying.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PortfolioHealth {
    pub total_collateral_value: i128,
    pub portfolio_margin_required: i128,
    pub free_collateral: i128,
    pub liquidatable: bool,
    /// Net directional exposure, USD 18-dec.
    pub net_delta_usd: i128,
}

/// A signed limit order placed off-chain and submitted to the CLOB contract.
/// The `signature` is an Ed25519 signature over the canonical hash of all
/// other fields (excluding `status` and `filled_size`).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LimitOrder {
    pub order_id: u64,
    pub trader: Address,
    pub market_id: u32,
    /// Position size in 18-decimal base units.
    pub size: i128,
    /// Limit price in 18-decimal USD.
    pub price: i128,
    pub is_long: bool,
    pub leverage: u32,
    /// Ledger timestamp after which order is void.
    pub expiry: u64,
    /// Monotonically increasing per-trader nonce; prevents replay.
    pub nonce: u64,
    /// Ed25519 signature over SHA-256 of canonical order bytes.
    pub signature: soroban_sdk::BytesN<64>,
    pub status: OrderStatus,
    /// Amount of `size` already filled, 18-decimal base units.
    pub filled_size: i128,
}

/// Phase E — Stochastic Volatility Inspired (SVI) surface parameters.
///
/// Per-expiry bucket. Total variance `w(k) = a + b * (ρ*(k - m) + sqrt((k - m)^2 + σ²))`
/// where `k = ln(K/F)` is log-moneyness (K = strike, F = forward). The implied
/// vol at a point is `sqrt(w)`. All params are PRECISION-scaled fixed point.
///
/// Invariants enforced at write time by `stellax-options::set_vol_surface`:
///   • `b >= 0` (convexity)
///   • `|rho| < PRECISION` (strict |ρ| < 1)
///   • `sigma_svi > 0`
///   • `a >= -b * sigma_svi * sqrt(1 - rho^2)` (positive variance at k = m)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SviParams {
    /// Vertical translation of the total-variance smile (PRECISION-scaled).
    pub a: i128,
    /// Slope of the asymptotic wings (PRECISION-scaled, typically 0..5e17).
    pub b: i128,
    /// Rotation / asymmetry parameter in (-1, 1), PRECISION-scaled.
    pub rho: i128,
    /// ATM log-moneyness offset (typically ~0), PRECISION-scaled.
    pub m: i128,
    /// ATM smoothness. Controls curvature at the money; must be > 0.
    pub sigma_svi: i128,
    /// Unix timestamp of this expiry bucket.
    pub expiry: u64,
    /// Ledger time of last update. Used by staleness checks.
    pub updated_at: u64,
}

/// Phase E — Full Greeks snapshot for a single option.
///
/// All magnitudes are PRECISION-scaled. Sign conventions:
///   • delta: +[0,1] for calls, -[0,1] for puts
///   • gamma: always >= 0
///   • vega: always >= 0 (dV/dσ)
///   • theta: daily time decay, almost always < 0 for long positions
///   • iv: implied vol used in the pricing (from SVI surface or legacy flat)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OptionGreeks {
    pub delta: i128,
    pub gamma: i128,
    pub vega: i128,
    pub theta: i128,
    pub iv: i128,
}
