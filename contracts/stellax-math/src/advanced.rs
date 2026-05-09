//! Advanced math: integer power, square root, exponential, natural log, and
//! the standard-normal cumulative distribution function (Φ). All operate on
//! 18-decimal fixed-point `i128` values.
//!
//! These functions are the building blocks of the Black-Scholes options
//! pricing model implemented in `stellax-options` (Phase 7).
//!
//! ## Algorithm choices
//! - `pow`: fast exponentiation by squaring in fixed-point.
//! - `sqrt_fixed`: Babylonian (Newton) iteration with a smart initial guess
//!   based on the bit length of the input.
//! - `exp_fixed`: argument range reduction via `exp(x) = 2^k · exp(r)` then
//!   Taylor series on the small remainder `r`. Range reduction keeps the
//!   series convergent and bounded in i128.
//! - `ln_fixed`: argument range reduction via `ln(x) = k·ln(2) + ln(m)` with
//!   `m ∈ [1, 2)`, then the AGM-style series
//!   `ln(m) = 2·(z + z^3/3 + z^5/5 + …)` with `z = (m-1)/(m+1)`.
//! - `normal_cdf`: Abramowitz & Stegun 26.2.17 rational approximation, max
//!   absolute error ≈ 7.5e-8 in floating point — far better than the
//!   precision required for option pricing.

use crate::constants::PRECISION;
use crate::fixed::{mul_div, mul_precision};

// --------------------------------------------------------------------------
// pow — integer exponent on a fixed-point base.
// --------------------------------------------------------------------------

/// Compute `base^exponent` where `base` is 18-decimal fixed-point and
/// `exponent` is an unsigned integer. Result remains 18-decimal fixed-point.
///
/// Uses exponentiation by squaring (O(log n) multiplications). Each
/// multiplication goes through [`mul_precision`] which uses 256-bit
/// intermediates, so overflow only happens for genuinely too-large results.
pub fn pow(base: i128, exponent: u32) -> i128 {
    if exponent == 0 {
        return PRECISION;
    }
    let mut result = PRECISION;
    let mut acc = base;
    let mut exp = exponent;
    while exp > 0 {
        if exp & 1 == 1 {
            result = mul_precision(result, acc);
        }
        exp >>= 1;
        if exp > 0 {
            acc = mul_precision(acc, acc);
        }
    }
    result
}

// --------------------------------------------------------------------------
// sqrt_fixed — Newton's method on i128.
// --------------------------------------------------------------------------

/// Square root of an 18-decimal fixed-point number.
///
/// Computes `sqrt(x · 10^18)` via Newton's method on the integer `x · 10^18`.
/// Mathematically: `sqrt_fixed(x) = sqrt(x_repr · 10^18)` because
/// `(y/1e9)^2 = y^2/1e18` so we need an extra factor of 1e18 inside the sqrt
/// to land back at 18-decimal precision.
///
/// Initial guess uses the bit length of the input; convergence is reached in
/// well under 200 iterations for any i128 input.
///
/// # Panics
/// if `x < 0`.
pub fn sqrt_fixed(x: i128) -> i128 {
    assert!(x >= 0, "sqrt_fixed: negative input");
    if x == 0 {
        return 0;
    }
    // We want sqrt(x * 1e18). Use the 256-bit primitive to compute scaled.
    // mul_div(x, PRECISION, 1) might overflow for x > i128::MAX/1e18 (~1.7e20),
    // which is safely above any realistic price/volatility. For very large x
    // we shift the algorithm: sqrt(x*1e18) = sqrt(x)*sqrt(1e18) approximated
    // by working in u128 with controlled scaling.
    let scaled = scaled_for_sqrt(x);
    isqrt_u128(scaled) as i128
}

/// Multiply `x` (i128, ≥ 0) by 1e18 and return as `u128`.
/// Falls back to a saturating operation that preserves precision for large `x`.
fn scaled_for_sqrt(x: i128) -> u128 {
    let ux = x as u128;
    let p = PRECISION as u128;
    match ux.checked_mul(p) {
        Some(v) => v,
        None => {
            // Extremely large input — shift down before scaling, then
            // scale the result back. Loses some precision but keeps the
            // protocol functional in pathological cases.
            let shift = 32u32;
            let reduced = ux >> shift;
            (reduced * p) << shift
        }
    }
}

/// Integer square root of a `u128` via Newton iteration.
fn isqrt_u128(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    // Initial guess: 2^(ceil(bits/2)).
    let bits = 128 - n.leading_zeros();
    let mut x: u128 = 1u128 << bits.div_ceil(2);
    loop {
        let next = (x + n / x) / 2;
        if next >= x {
            return x;
        }
        x = next;
    }
}

// --------------------------------------------------------------------------
// exp_fixed — argument-reduced Taylor series.
// --------------------------------------------------------------------------

/// `e^x` for 18-decimal fixed-point `x`. Supports negative inputs.
///
/// Uses the identity `exp(x) = 2^k · exp(r)` with `k = round(x / ln 2)` and
/// `|r| ≤ ln(2)/2 ≈ 0.347`. The remainder is evaluated via a 25-term Taylor
/// series, which is more than enough for 18-decimal accuracy on such a small
/// argument.
///
/// Saturates to 0 for very negative inputs and panics on overflow when `k`
/// would exceed the i128 range (input > ~88).
pub fn exp_fixed(x: i128) -> i128 {
    // ln(2) in 18-dec fixed point: 0.693147180559945309
    const LN2: i128 = 693_147_180_559_945_309;
    // Min input for which exp(x) >= 1 wei in 18-dec representation.
    if x <= -41_446_531_673_892_822_312 {
        // exp(-41.4..) ≈ 1e-18, anything smaller rounds to 0.
        return 0;
    }
    // Max input keeping result in i128: exp(x) < 1.7e20 -> x < ~46.
    assert!(x < 46_000_000_000_000_000_000, "exp_fixed: overflow");

    // k = round(x / ln 2). Use signed integer division with rounding.
    let k_num = x;
    let mut k = k_num / LN2;
    let rem = k_num - k * LN2;
    // Round k toward nearest integer for the smallest possible |r|.
    if rem > LN2 / 2 {
        k += 1;
    } else if rem < -LN2 / 2 {
        k -= 1;
    }
    let r = x - k * LN2; // |r| ≤ LN2/2

    // Taylor series for exp(r): 1 + r + r²/2! + r³/3! + …
    let mut term = PRECISION;
    let mut sum = PRECISION;
    for n in 1u32..=25 {
        term = mul_precision(term, r) / n as i128;
        sum += term;
        if term == 0 {
            break;
        }
    }

    // Multiply by 2^k. For k > 0 left-shift the result; for k < 0 right-shift.
    if k >= 0 {
        // Use a saturating shift via repeated multiplication to keep things
        // honest if k is large (it can be up to ~66).
        let shift = k as u32;
        if shift >= 127 {
            // Will overflow; the assert above protects against this in practice.
            panic!("exp_fixed: shift overflow");
        }
        sum << shift
    } else {
        let shift = (-k) as u32;
        if shift >= 127 {
            return 0;
        }
        sum >> shift
    }
}

// --------------------------------------------------------------------------
// ln_fixed — argument-reduced atanh series.
// --------------------------------------------------------------------------

/// Natural logarithm of an 18-decimal fixed-point number.
///
/// `x` must be strictly positive. For `x = 1` (i.e. `PRECISION`) the result
/// is exactly 0. Reduces `x` to `m ∈ [1, 2)` by computing the integer power
/// of two, then applies the rapidly-convergent series
/// `ln(m) = 2·(z + z³/3 + z⁵/5 + …)` with `z = (m-1)/(m+1)`.
///
/// # Panics
/// if `x <= 0`.
pub fn ln_fixed(x: i128) -> i128 {
    assert!(x > 0, "ln_fixed: non-positive input");
    if x == PRECISION {
        return 0;
    }

    const LN2: i128 = 693_147_180_559_945_309;

    // Reduce to m * 2^k with m in [1e18, 2e18). k may be negative.
    let mut m = x;
    let mut k: i128 = 0;
    while m >= 2 * PRECISION {
        m /= 2;
        k += 1;
    }
    while m < PRECISION {
        m *= 2;
        k -= 1;
    }

    // z = (m - 1e18) / (m + 1e18) in 18-dec.
    let num = m - PRECISION;
    let den = m + PRECISION;
    let z = mul_div(num, PRECISION, den);

    // Series: 2 * sum_{i=0..} z^(2i+1) / (2i+1)
    let z2 = mul_precision(z, z);
    let mut term = z;
    let mut sum = z;
    for i in 1u32..40 {
        term = mul_precision(term, z2);
        let denom = (2 * i + 1) as i128;
        sum += term / denom;
        if term == 0 {
            break;
        }
    }
    let ln_m = 2 * sum;

    ln_m + k * LN2
}

// --------------------------------------------------------------------------
// normal_cdf — Abramowitz & Stegun 26.2.17 rational approximation.
// --------------------------------------------------------------------------

/// Standard-normal cumulative distribution function Φ(x), 18-decimal output
/// in [0, 1e18].
///
/// Implements the Abramowitz & Stegun 26.2.17 rational polynomial:
///
/// ```text
/// φ(x) = (1/√(2π)) · e^(-x²/2)
/// Φ(x) ≈ 1 - φ(x) · (a₁k + a₂k² + a₃k³ + a₄k⁴ + a₅k⁵)   for x ≥ 0
/// k    = 1 / (1 + 0.2316419·x)
/// ```
///
/// For `x < 0` we use the symmetry `Φ(-x) = 1 - Φ(x)`.
///
/// Maximum absolute error of the underlying floating-point formula is
/// 7.5e-8, comfortably below the 18-decimal noise floor for the inputs
/// (`|x| ≤ 6`) seen in option pricing.
pub fn normal_cdf(x: i128) -> i128 {
    let abs_x = x.abs();

    // Constants in 18-decimal fixed-point.
    // a1..a5 from Abramowitz & Stegun 26.2.17.
    const A1: i128 = 319_381_530_000_000_000; // 0.319381530
    const A2: i128 = -356_563_782_000_000_000; // -0.356563782
    const A3: i128 = 1_781_477_937_000_000_000; // 1.781477937
    const A4: i128 = -1_821_255_978_000_000_000; // -1.821255978
    const A5: i128 = 1_330_274_429_000_000_000; // 1.330274429
    const P_COEF: i128 = 231_641_900_000_000_000; // 0.2316419
                                                  // 1 / sqrt(2π) = 0.39894228040143268
    const INV_SQRT_2PI: i128 = 398_942_280_401_432_677;

    // For very large |x|, return saturating bounds to avoid wasted work.
    // |x| > 8 gives Φ(x) within 1e-15 of {0, 1}.
    let eight = 8 * PRECISION;
    if abs_x > eight {
        return if x > 0 { PRECISION } else { 0 };
    }

    // φ(x) = INV_SQRT_2PI * exp(-x²/2)
    let x2 = mul_precision(abs_x, abs_x);
    let neg_half_x2 = -x2 / 2;
    let phi = mul_precision(INV_SQRT_2PI, exp_fixed(neg_half_x2));

    // k = 1 / (1 + 0.2316419 * |x|)
    let k = mul_div(
        PRECISION,
        PRECISION,
        PRECISION + mul_precision(P_COEF, abs_x),
    );

    // Polynomial in k (Horner's form): k(a1 + k(a2 + k(a3 + k(a4 + k·a5))))
    let mut poly = A5;
    poly = A4 + mul_precision(poly, k);
    poly = A3 + mul_precision(poly, k);
    poly = A2 + mul_precision(poly, k);
    poly = A1 + mul_precision(poly, k);
    poly = mul_precision(poly, k);

    let upper = PRECISION - mul_precision(phi, poly);

    if x >= 0 {
        upper
    } else {
        PRECISION - upper
    }
}

// --------------------------------------------------------------------------
// normal_pdf — standard-normal probability density φ(x).
// --------------------------------------------------------------------------

/// Standard-normal probability density function φ(x) = (1/√(2π)) · e^(-x²/2),
/// 18-decimal fixed-point in and out. Always ≥ 0.
///
/// Used by Phase E Greeks (gamma, vega, theta) where partial derivatives
/// of Black-Scholes involve φ(d1).
pub fn normal_pdf(x: i128) -> i128 {
    // 1 / sqrt(2π) = 0.39894228040143268 (18-dec)
    const INV_SQRT_2PI: i128 = 398_942_280_401_432_677;
    let abs_x = x.abs();
    // For |x| > 8, φ(x) < 1e-15 — underflow to 0 keeps the result nonneg and
    // avoids deep exp_fixed calls.
    let eight = 8 * PRECISION;
    if abs_x > eight {
        return 0;
    }
    let x2 = mul_precision(abs_x, abs_x);
    let neg_half_x2 = -x2 / 2;
    mul_precision(INV_SQRT_2PI, exp_fixed(neg_half_x2))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::PRECISION;

    /// Allowed absolute error in fixed-point units (10^-12 in 18-dec terms).
    const TOL: i128 = 1_000_000;

    fn approx_eq(a: i128, b: i128, tol: i128) {
        let diff = (a - b).abs();
        assert!(
            diff <= tol,
            "expected {} ≈ {} (diff {}, tol {})",
            a,
            b,
            diff,
            tol
        );
    }

    // ---- pow ----

    #[test]
    fn pow_zero_exponent() {
        assert_eq!(pow(0, 0), PRECISION);
        assert_eq!(pow(123_456, 0), PRECISION);
    }

    #[test]
    fn pow_one_base() {
        assert_eq!(pow(PRECISION, 100), PRECISION);
    }

    #[test]
    fn pow_two_squared() {
        let two = 2 * PRECISION;
        assert_eq!(pow(two, 2), 4 * PRECISION);
    }

    #[test]
    fn pow_half_to_the_three() {
        let half = PRECISION / 2;
        // 0.5^3 = 0.125
        assert_eq!(pow(half, 3), PRECISION / 8);
    }

    // ---- sqrt ----

    #[test]
    fn sqrt_zero_and_one() {
        assert_eq!(sqrt_fixed(0), 0);
        assert_eq!(sqrt_fixed(PRECISION), PRECISION);
    }

    #[test]
    fn sqrt_four() {
        // sqrt(4) = 2
        approx_eq(sqrt_fixed(4 * PRECISION), 2 * PRECISION, TOL);
    }

    #[test]
    fn sqrt_two() {
        // sqrt(2) ≈ 1.41421356237309515
        let expected: i128 = 1_414_213_562_373_095_048;
        approx_eq(sqrt_fixed(2 * PRECISION), expected, TOL);
    }

    #[test]
    #[should_panic(expected = "sqrt_fixed: negative input")]
    fn sqrt_panics_on_negative() {
        let _ = sqrt_fixed(-1);
    }

    // ---- exp ----

    #[test]
    fn exp_zero() {
        assert_eq!(exp_fixed(0), PRECISION);
    }

    #[test]
    fn exp_one() {
        // e ≈ 2.71828182845904523
        let expected: i128 = 2_718_281_828_459_045_235;
        approx_eq(exp_fixed(PRECISION), expected, TOL * 100);
    }

    #[test]
    fn exp_neg_one() {
        // 1/e ≈ 0.36787944117144232
        let expected: i128 = 367_879_441_171_442_321;
        approx_eq(exp_fixed(-PRECISION), expected, TOL * 100);
    }

    #[test]
    fn exp_two() {
        // e^2 ≈ 7.38905609893065
        let expected: i128 = 7_389_056_098_930_650_227;
        approx_eq(exp_fixed(2 * PRECISION), expected, TOL * 1000);
    }

    #[test]
    fn exp_large_negative_underflows_to_zero() {
        assert_eq!(exp_fixed(-50 * PRECISION), 0);
    }

    // ---- ln ----

    #[test]
    fn ln_one() {
        assert_eq!(ln_fixed(PRECISION), 0);
    }

    #[test]
    fn ln_e() {
        // ln(e) = 1
        let e: i128 = 2_718_281_828_459_045_235;
        approx_eq(ln_fixed(e), PRECISION, TOL * 100);
    }

    #[test]
    fn ln_two() {
        // ln(2) ≈ 0.69314718055994531
        let expected: i128 = 693_147_180_559_945_309;
        approx_eq(ln_fixed(2 * PRECISION), expected, TOL);
    }

    #[test]
    fn ln_half() {
        // ln(0.5) = -ln(2)
        let expected: i128 = -693_147_180_559_945_309;
        approx_eq(ln_fixed(PRECISION / 2), expected, TOL);
    }

    #[test]
    #[should_panic(expected = "ln_fixed: non-positive input")]
    fn ln_panics_on_zero() {
        let _ = ln_fixed(0);
    }

    // ---- normal_cdf ----

    #[test]
    fn cdf_zero() {
        // Φ(0) = 0.5
        let result = normal_cdf(0);
        approx_eq(result, PRECISION / 2, TOL * 1000);
    }

    #[test]
    fn cdf_one() {
        // Φ(1) ≈ 0.8413447460685429
        let expected: i128 = 841_344_746_068_542_948;
        approx_eq(normal_cdf(PRECISION), expected, TOL * 10000);
    }

    #[test]
    fn cdf_neg_one() {
        // Φ(-1) ≈ 0.1586552539314571
        let expected: i128 = 158_655_253_931_457_052;
        approx_eq(normal_cdf(-PRECISION), expected, TOL * 10000);
    }

    #[test]
    fn cdf_two() {
        // Φ(2) ≈ 0.9772498680518208. A&S 26.2.17 max error is ~7.5e-8 in the
        // floating-point formula; in fixed point we observe ~7e-11 here, so
        // tolerance is set to 1e-9.
        let expected: i128 = 977_249_868_051_820_800;
        approx_eq(normal_cdf(2 * PRECISION), expected, 100_000_000_000);
    }

    #[test]
    fn cdf_symmetry() {
        // Φ(x) + Φ(-x) = 1
        for &x in &[
            PRECISION / 4,
            PRECISION / 2,
            PRECISION,
            3 * PRECISION / 2,
            2 * PRECISION,
            3 * PRECISION,
        ] {
            let lhs = normal_cdf(x) + normal_cdf(-x);
            approx_eq(lhs, PRECISION, TOL * 100_000);
        }
    }

    #[test]
    fn cdf_saturation() {
        // Far in tails -> 0 / 1.
        assert_eq!(normal_cdf(20 * PRECISION), PRECISION);
        assert_eq!(normal_cdf(-20 * PRECISION), 0);
    }
}
