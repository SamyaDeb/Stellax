//! Fixed-point arithmetic over `i128` with 18 decimals of precision.
//!
//! All functions in this module are deterministic, `no_std` compatible, and
//! make no use of floating-point. Overflow protection is provided in two
//! flavours:
//!
//! - **`*_checked`** variants return `Option<i128>` and never panic; callers
//!   handle the failure mode explicitly.
//! - **Default** variants panic on overflow / division-by-zero. Combined with
//!   `overflow-checks = true` in the release profile this gives a clean
//!   "fail-closed" semantics suitable for financial code.

use crate::constants::PRECISION;

// --------------------------------------------------------------------------
// mul_div — the single most important primitive in the protocol.
// --------------------------------------------------------------------------

/// Computes `(a * b) / denominator` with a 256-bit intermediate to avoid
/// overflow even when `a * b` would not fit in `i128`.
///
/// Uses signed 128×128→256 multiplication implemented via 64-bit limbs and
/// an unsigned 256÷128 divide. The result is rounded toward zero (matches
/// Solidity / Rust integer division semantics).
///
/// # Panics
/// - if `denominator == 0`
/// - if the final result does not fit in `i128`
pub fn mul_div(a: i128, b: i128, denominator: i128) -> i128 {
    mul_div_checked(a, b, denominator).expect("mul_div: overflow or div-by-zero")
}

/// Non-panicking variant of [`mul_div`]. Returns `None` on overflow or
/// when `denominator == 0`.
pub fn mul_div_checked(a: i128, b: i128, denominator: i128) -> Option<i128> {
    if denominator == 0 {
        return None;
    }

    // Track sign separately, work with absolute values.
    let neg = (a < 0) ^ (b < 0) ^ (denominator < 0);
    let ua = a.unsigned_abs();
    let ub = b.unsigned_abs();
    let ud = denominator.unsigned_abs();

    // 128 × 128 -> 256-bit product as (high, low).
    let (prod_hi, prod_lo) = umul_128_128(ua, ub);

    // 256 / 128 -> quotient (must fit in 128 bits for a valid i128 result).
    let q = udiv_256_128(prod_hi, prod_lo, ud)?;

    // Fold sign back in. i128::MIN cannot be represented as a positive i128,
    // so we cap one bit below.
    if neg {
        if q > (i128::MAX as u128) + 1 {
            return None;
        }
        if q == (i128::MAX as u128) + 1 {
            Some(i128::MIN)
        } else {
            Some(-(q as i128))
        }
    } else {
        if q > i128::MAX as u128 {
            return None;
        }
        Some(q as i128)
    }
}

// --------------------------------------------------------------------------
// 256-bit helpers.
// --------------------------------------------------------------------------

/// Unsigned 128 × 128 -> 256 multiplication (returns (high, low)).
#[inline]
fn umul_128_128(a: u128, b: u128) -> (u128, u128) {
    // Split each operand into two 64-bit halves.
    let a_lo = a as u64 as u128;
    let a_hi = a >> 64;
    let b_lo = b as u64 as u128;
    let b_hi = b >> 64;

    // Schoolbook multiplication.
    let ll = a_lo * b_lo;
    let lh = a_lo * b_hi;
    let hl = a_hi * b_lo;
    let hh = a_hi * b_hi;

    // Combine partial products.
    let mid = (ll >> 64) + (lh & 0xFFFF_FFFF_FFFF_FFFF) + (hl & 0xFFFF_FFFF_FFFF_FFFF);
    let lo = (ll & 0xFFFF_FFFF_FFFF_FFFF) | (mid << 64);
    let hi = hh + (lh >> 64) + (hl >> 64) + (mid >> 64);
    (hi, lo)
}

/// Unsigned 256 / 128 -> 128 division. Returns `None` if the quotient would
/// overflow `u128` (i.e. `hi >= divisor`).
fn udiv_256_128(hi: u128, lo: u128, divisor: u128) -> Option<u128> {
    if divisor == 0 {
        return None;
    }
    if hi == 0 {
        return Some(lo / divisor);
    }
    if hi >= divisor {
        // Quotient would exceed 128 bits.
        return None;
    }

    // Bitwise long division (128 iterations, each shift-subtract).
    let mut rem_hi = hi;
    let mut rem_lo = lo;
    let mut quotient: u128 = 0;

    for _ in 0..128 {
        // Left-shift (rem_hi : rem_lo) by 1.
        let new_hi = (rem_hi << 1) | (rem_lo >> 127);
        rem_lo <<= 1;
        rem_hi = new_hi;

        quotient <<= 1;

        if rem_hi >= divisor {
            rem_hi -= divisor;
            quotient |= 1;
        }
    }

    Some(quotient)
}

// --------------------------------------------------------------------------
// 18-decimal fixed-point helpers built on mul_div.
// --------------------------------------------------------------------------

/// `a * b` for two 18-decimal fixed-point numbers.
pub fn mul_precision(a: i128, b: i128) -> i128 {
    mul_div(a, b, PRECISION)
}

/// Non-panicking [`mul_precision`].
pub fn mul_precision_checked(a: i128, b: i128) -> Option<i128> {
    mul_div_checked(a, b, PRECISION)
}

/// `a / b` for two 18-decimal fixed-point numbers.
pub fn div_precision(a: i128, b: i128) -> i128 {
    mul_div(a, PRECISION, b)
}

/// Non-panicking [`div_precision`].
pub fn div_precision_checked(a: i128, b: i128) -> Option<i128> {
    mul_div_checked(a, PRECISION, b)
}

// --------------------------------------------------------------------------
// Decimal conversions.
// --------------------------------------------------------------------------

/// Convert a value from `from_decimals` precision to `to_decimals` precision.
///
/// - When `to_decimals > from_decimals`: multiplies by `10^(to-from)`.
/// - When `to_decimals < from_decimals`: divides by `10^(from-to)` (truncating).
/// - When equal: returns the input unchanged.
///
/// Used at every contract boundary to normalize external token amounts
/// (USDC = 6 decimals, XLM = 7 decimals, RedStone prices = 8 decimals) into
/// the protocol's internal 18-decimal representation, and vice versa on
/// withdrawals.
pub fn to_precision(value: i128, from_decimals: u32, to_decimals: u32) -> i128 {
    to_precision_checked(value, from_decimals, to_decimals).expect("to_precision: overflow")
}

/// Non-panicking [`to_precision`].
pub fn to_precision_checked(value: i128, from_decimals: u32, to_decimals: u32) -> Option<i128> {
    use core::cmp::Ordering;
    match to_decimals.cmp(&from_decimals) {
        Ordering::Equal => Some(value),
        Ordering::Greater => {
            let factor = pow10_checked(to_decimals - from_decimals)?;
            value.checked_mul(factor)
        }
        Ordering::Less => {
            let factor = pow10_checked(from_decimals - to_decimals)?;
            Some(value / factor)
        }
    }
}

/// Compute `10^n` as an `i128`, returning `None` if it would overflow.
pub fn pow10_checked(n: u32) -> Option<i128> {
    let mut acc: i128 = 1;
    let ten: i128 = 10;
    for _ in 0..n {
        acc = acc.checked_mul(ten)?;
    }
    Some(acc)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::PRECISION;

    #[test]
    fn mul_div_basic() {
        assert_eq!(mul_div(2, 3, 6), 1);
        assert_eq!(mul_div(10, 10, 5), 20);
        assert_eq!(mul_div(0, 999, 7), 0);
    }

    #[test]
    fn mul_div_signed() {
        assert_eq!(mul_div(-10, 3, 2), -15);
        assert_eq!(mul_div(10, -3, 2), -15);
        assert_eq!(mul_div(-10, -3, 2), 15);
        assert_eq!(mul_div(10, 3, -2), -15);
    }

    #[test]
    fn mul_div_no_intermediate_overflow() {
        // i128::MAX * 2 / 4 = i128::MAX / 2 — would overflow naive a*b.
        let result = mul_div(i128::MAX, 2, 4);
        assert_eq!(result, i128::MAX / 2);
    }

    #[test]
    fn mul_div_max_values() {
        // (1e36) * (1e36) / (1e36) == 1e36, well within i128.
        let big: i128 = 1_000_000_000_000_000_000_000_000_000_000_000_000;
        assert_eq!(mul_div(big, big, big), big);
    }

    #[test]
    fn mul_div_checked_div_by_zero() {
        assert_eq!(mul_div_checked(1, 1, 0), None);
    }

    #[test]
    fn mul_div_checked_overflow() {
        // Result wouldn't fit in i128.
        assert_eq!(mul_div_checked(i128::MAX, 2, 1), None);
    }

    #[test]
    #[should_panic]
    fn mul_div_panics_on_overflow() {
        let _ = mul_div(i128::MAX, 2, 1);
    }

    #[test]
    fn mul_precision_one_times_one() {
        assert_eq!(mul_precision(PRECISION, PRECISION), PRECISION);
    }

    #[test]
    fn mul_precision_half_times_half() {
        let half = PRECISION / 2;
        // 0.5 * 0.5 = 0.25
        assert_eq!(mul_precision(half, half), PRECISION / 4);
    }

    #[test]
    fn div_precision_basic() {
        // 2 / 4 = 0.5
        assert_eq!(div_precision(2 * PRECISION, 4 * PRECISION), PRECISION / 2);
    }

    #[test]
    fn div_precision_inverse_of_mul() {
        let a = 7 * PRECISION;
        let b = 3 * PRECISION;
        let c = mul_precision(a, b);
        let back = div_precision(c, b);
        assert_eq!(back, a);
    }

    #[test]
    fn to_precision_upscale() {
        // USDC 6 dec -> 18 dec: 1.000000 USDC == 1e18
        assert_eq!(to_precision(1_000_000, 6, 18), PRECISION);
    }

    #[test]
    fn to_precision_downscale() {
        // 18 dec -> 7 dec (Stellar native): 1e18 -> 1e7
        assert_eq!(to_precision(PRECISION, 18, 7), 10_000_000);
    }

    #[test]
    fn to_precision_equal() {
        assert_eq!(to_precision(123, 18, 18), 123);
    }

    #[test]
    fn to_precision_truncates_low_bits() {
        // 1.234567890123456789e18 -> 6 dec (truncates to 1.234567)
        assert_eq!(to_precision(1_234_567_890_123_456_789, 18, 6), 1_234_567);
    }

    #[test]
    fn pow10_checked_works() {
        assert_eq!(pow10_checked(0), Some(1));
        assert_eq!(pow10_checked(18), Some(PRECISION));
        // i128::MAX is < 1e39, so 10^39 must overflow.
        assert_eq!(pow10_checked(39), None);
    }
}
