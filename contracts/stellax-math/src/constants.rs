//! Protocol-wide numeric constants. These are the single source of truth and
//! must never be redefined elsewhere in the codebase.

/// Internal fixed-point precision: 10^18.
///
/// Every monetary value (collateral balance, position size, PnL, funding
/// index) is stored as `i128` scaled by this factor.
pub const PRECISION: i128 = 1_000_000_000_000_000_000;

/// Oracle price precision: 10^7. Matches Stellar's classic 7-decimal layout.
/// Prices from RedStone (typically 8 decimals) are normalized into 18-decimal
/// PRECISION at the oracle boundary; this constant is preserved for legacy
/// price math and external interop.
pub const PRICE_PRECISION: i128 = 10_000_000;

/// Percentage precision: 10^6 (one basis point = 100 units, one bp-of-bp = 1 unit).
pub const PERCENT_PRECISION: i128 = 1_000_000;

/// Basis-point denominator. 100% = 10_000 bps.
pub const BPS_DENOMINATOR: u32 = 10_000;

// ---- Risk parameters ------------------------------------------------------

/// Hard cap on leverage allowed by the protocol (per market caps may be lower).
pub const MAX_LEVERAGE: u32 = 50;

/// Liquidation threshold: position becomes liquidatable when account margin
/// ratio falls below 100% - this value (i.e. account equity / position notional
/// drops below 10%). Expressed in bps.
pub const LIQUIDATION_THRESHOLD_BPS: u32 = 9_000;

/// Maintenance margin requirement (50% of initial margin). Expressed in bps.
pub const MAINTENANCE_MARGIN_BPS: u32 = 5_000;

/// Maximum funding rate per hour: 0.1% = 0.001 in 18-decimal fixed-point.
pub const MAX_FUNDING_RATE_PER_HOUR: i128 = 1_000_000_000_000_000;

// ---- Ledger / TTL ---------------------------------------------------------

/// Approximate ledgers per day (~5s ledger close time on Stellar).
pub const DAY_IN_LEDGERS: u32 = 17_280;

/// TTL bump for persistent storage entries (30 days).
pub const TTL_BUMP_PERSISTENT: u32 = 30 * DAY_IN_LEDGERS;

/// TTL bump for instance storage (contract-tied state, 7 days).
pub const TTL_BUMP_INSTANCE: u32 = 7 * DAY_IN_LEDGERS;

/// TTL bump for temporary storage (orders, ephemeral data, 1 day).
pub const TTL_BUMP_TEMPORARY: u32 = DAY_IN_LEDGERS;

// ---- Threshold for TTL extension calls ------------------------------------
// We only re-extend TTL when remaining lifetime drops below the threshold,
// avoiding gas waste on every read.
pub const TTL_THRESHOLD_PERSISTENT: u32 = 7 * DAY_IN_LEDGERS;
pub const TTL_THRESHOLD_INSTANCE: u32 = DAY_IN_LEDGERS;
pub const TTL_THRESHOLD_TEMPORARY: u32 = DAY_IN_LEDGERS / 2;

// ---- V2: Skew fee / velocity funding constants ----------------------------

/// Default skew scale: 1e14. Skew fee rate = |mid_skew| / skew_scale.
/// At 1e14 scale, a net OI imbalance of 1e14 units produces a 0.01% fee.
pub const DEFAULT_SKEW_SCALE: i128 = 100_000_000_000_000; // 1e14

/// Maximum funding velocity per hour in 18-decimal fixed-point (0.1%/hr).
pub const MAX_FUNDING_VELOCITY: i128 = 1_000_000_000_000_000; // 1e15

/// Seconds per hour (used in velocity-based funding calculations).
pub const SECS_PER_HOUR: u64 = 3_600;
