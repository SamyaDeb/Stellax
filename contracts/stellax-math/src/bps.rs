//! Basis-point and clamping utilities.

use crate::constants::BPS_DENOMINATOR;
use crate::fixed::mul_div;

/// Apply a basis-point fee or rate to a value: `value * bps / 10_000`.
///
/// Used everywhere fees, funding fractions, or other bps-quoted percentages
/// are charged.
pub fn apply_bps(value: i128, bps: u32) -> i128 {
    mul_div(value, bps as i128, BPS_DENOMINATOR as i128)
}

/// Apply a haircut (collateral discount) to a value: `value * (10_000 - bps) / 10_000`.
///
/// Used by the vault when valuing volatile or RWA collateral. `haircut_bps`
/// is clamped to `BPS_DENOMINATOR` to avoid wraparound on misconfiguration.
pub fn apply_haircut(value: i128, haircut_bps: u32) -> i128 {
    let h = haircut_bps.min(BPS_DENOMINATOR);
    let remaining = BPS_DENOMINATOR - h;
    mul_div(value, remaining as i128, BPS_DENOMINATOR as i128)
}

/// Restrict `value` to the inclusive range `[min, max]`.
///
/// # Panics
/// if `min > max`.
pub fn clamp(value: i128, min: i128, max: i128) -> i128 {
    assert!(min <= max, "clamp: min > max");
    if value < min {
        min
    } else if value > max {
        max
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_bps_basic() {
        // 5 bps of 1e18 = 5e14
        assert_eq!(apply_bps(1_000_000_000_000_000_000, 5), 500_000_000_000_000);
        // 100% (10_000 bps) is identity
        assert_eq!(apply_bps(123_456, 10_000), 123_456);
        // 0 bps yields 0
        assert_eq!(apply_bps(123_456, 0), 0);
    }

    #[test]
    fn apply_haircut_basic() {
        // 0% haircut == identity
        assert_eq!(apply_haircut(1000, 0), 1000);
        // 15% haircut on 1000 = 850
        assert_eq!(apply_haircut(1000, 1500), 850);
        // 100% haircut == zero
        assert_eq!(apply_haircut(1000, 10_000), 0);
    }

    #[test]
    fn apply_haircut_clamps_excess_bps() {
        // 20_000 bps clamped to 100% -> all collateral wiped.
        assert_eq!(apply_haircut(1000, 20_000), 0);
    }

    #[test]
    fn clamp_basic() {
        assert_eq!(clamp(5, 0, 10), 5);
        assert_eq!(clamp(-5, 0, 10), 0);
        assert_eq!(clamp(15, 0, 10), 10);
        assert_eq!(clamp(0, 0, 10), 0);
        assert_eq!(clamp(10, 0, 10), 10);
    }

    #[test]
    #[should_panic(expected = "clamp: min > max")]
    fn clamp_panics_on_inverted_range() {
        clamp(0, 10, 0);
    }
}
