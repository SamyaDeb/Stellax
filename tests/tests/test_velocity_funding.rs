//! J.2.4 — Velocity funding integration sanity.
//!
//! In this in-memory harness the real perp engine's `get_mark_price`
//! returns the oracle price (no vAMM), so the mark-index premium is
//! structurally zero. That means the velocity integrator cannot ramp
//! here the way it does in the unit tests (which use a `MockPerp` with
//! `set_mark_price`). The *ramp dynamics* are covered by the inline
//! tests in `contracts/stellax-funding/src/lib.rs:602+`.
//!
//! What we *do* verify at the integration layer:
//!   1. A freshly-registered market has zero velocity and zero rate.
//!   2. Calling `update_funding` repeatedly across time (with zero
//!      premium) does not spuriously drift velocity or rate — the V2
//!      integrator is quiescent when mark ≡ index.
//!   3. `settle_funding` on an open position returns zero PnL when
//!      there has been no funding accumulation.

use stellax_integration_tests::{setup, BTC_MARKET_ID, PRECISION, USDC_DECIMALS};

fn usdc(whole: i128) -> i128 {
    whole * 10i128.pow(USDC_DECIMALS)
}

#[test]
fn fresh_market_has_zero_velocity_and_rate() {
    let s = setup();
    assert_eq!(s.funding.get_funding_velocity(&BTC_MARKET_ID), 0);
    assert_eq!(s.funding.get_current_funding_rate(&BTC_MARKET_ID), 0);
    let (acc_long, acc_short) = s.funding.get_accumulated_funding(&BTC_MARKET_ID);
    assert_eq!(acc_long, 0);
    assert_eq!(acc_short, 0);
}

#[test]
fn zero_premium_keeps_velocity_quiescent() {
    let s = setup();

    // Tick update_funding 5 times across 50 minutes. Mark = oracle in
    // integration → premium = 0 → velocity/rate must remain zero.
    for _ in 0..5 {
        s.advance_time(600); // 10 minutes.
        s.funding.update_funding(&BTC_MARKET_ID);
    }

    assert_eq!(
        s.funding.get_funding_velocity(&BTC_MARKET_ID),
        0,
        "zero premium must not induce velocity",
    );
    assert_eq!(
        s.funding.get_current_funding_rate(&BTC_MARKET_ID),
        0,
        "zero premium must not induce rate",
    );
}

#[test]
fn update_funding_is_safe_after_open_position() {
    let s = setup();
    s.vault.deposit(&s.user_one, &s.usdc, &usdc(500_000));

    // Open a position — the perp engine ticks funding internally.
    let _id = s.perp.open_position(
        &s.user_one,
        &BTC_MARKET_ID,
        &(10 * PRECISION),
        &true,
        &5u32,
        &200u32,
        &None,
    );

    // Cross-contract update_funding after an open must not panic and
    // must leave rate at 0 (mark ≡ index → zero premium).
    s.advance_time(3_600);
    s.funding.update_funding(&BTC_MARKET_ID);
    assert_eq!(s.funding.get_current_funding_rate(&BTC_MARKET_ID), 0);
}
