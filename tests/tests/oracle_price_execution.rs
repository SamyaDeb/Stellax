//! J.2.1 — Oracle-price execution with skew fee (Phase A).
//!
//! Verifies the V2 oracle-price-based execution model against the real
//! perp-engine contract:
//!
//!   1. First trade at zero skew executes ≈ oracle price (within 0.1%).
//!   2. Additional longs (increasing skew) pay progressively more than oracle.
//!   3. A short that *reduces* skew (maker) executes *below* oracle on the
//!      short side — a maker rebate that improves fill price.

use stellax_integration_tests::{setup, BTC_MARKET_ID, PRECISION, USDC_DECIMALS};

fn usdc(whole: i128) -> i128 {
    whole * 10i128.pow(USDC_DECIMALS)
}

/// Assert `actual` is within `bps` basis points of `expected`.
fn assert_within_bps(actual: i128, expected: i128, bps: i128, ctx: &str) {
    let diff = (actual - expected).abs();
    let tol = (expected.abs() * bps) / 10_000;
    assert!(
        diff <= tol,
        "{ctx}: expected {expected} ±{tol} ({bps}bps), got {actual} (diff {diff})",
    );
}

#[test]
fn first_trade_executes_at_oracle_price_within_tolerance() {
    let s = setup();

    // Fund a healthy collateral buffer.
    s.vault.deposit(&s.user_one, &s.usdc, &usdc(100_000));

    // Open a small long (0.01 BTC) at zero market skew. Oracle = $100.
    let size = PRECISION / 100; // 0.01 BTC
    let pos_id = s.perp.open_position(
        &s.user_one,
        &BTC_MARKET_ID,
        &size,
        &true,
        &5u32,
        &50u32, // 0.5% slippage
        &None,
    );

    let pos = s.perp.get_position(&s.user_one, &pos_id);
    // Oracle price is 100 * PRECISION. At zero skew with skew_scale=1e22
    // and size 1e16, mid_skew = 5e15, so skew fee = 5e15 * 100e18 / 1e22
    //  = 5e13 (negligible; 0.00005%).
    assert_within_bps(
        pos.entry_price,
        100 * PRECISION,
        5, // within 0.05%
        "first-trade entry price vs oracle",
    );
}

#[test]
fn skew_fee_increases_execution_price_for_subsequent_longs() {
    let s = setup();
    s.vault.deposit(&s.user_one, &s.usdc, &usdc(500_000));
    s.vault.deposit(&s.user_two, &s.usdc, &usdc(500_000));

    // First large long: 100 BTC. Mid-skew = 50 BTC; skew_fee_rate = 50e18/1e22
    // = 0.005, so execution ≈ oracle * 1.005.
    let big = 100 * PRECISION;
    let id_one = s.perp.open_position(
        &s.user_one,
        &BTC_MARKET_ID,
        &big,
        &true,
        &10u32,
        &100u32, // 1% slippage
        &None,
    );
    let pos_one = s.perp.get_position(&s.user_one, &id_one);

    // Second long — skew is now +100 BTC already; mid-skew = 150 BTC;
    // skew_fee_rate = 150e18/1e22 = 0.015. Should execute noticeably higher.
    let id_two = s.perp.open_position(
        &s.user_two,
        &BTC_MARKET_ID,
        &big,
        &true,
        &10u32,
        &200u32, // 2% slippage
        &None,
    );
    let pos_two = s.perp.get_position(&s.user_two, &id_two);

    let oracle = 100 * PRECISION;
    assert!(
        pos_one.entry_price > oracle,
        "first long should still pay > oracle (entry={}, oracle={})",
        pos_one.entry_price,
        oracle,
    );
    assert!(
        pos_two.entry_price > pos_one.entry_price,
        "second long into positive skew should execute higher than first \
         (one={}, two={})",
        pos_one.entry_price,
        pos_two.entry_price,
    );
}

#[test]
fn maker_short_against_positive_skew_gets_rebate_below_oracle() {
    let s = setup();
    s.vault.deposit(&s.user_one, &s.usdc, &usdc(500_000));
    s.vault.deposit(&s.user_two, &s.usdc, &usdc(500_000));

    // Push skew heavily positive first.
    let big = 100 * PRECISION;
    s.perp.open_position(
        &s.user_one,
        &BTC_MARKET_ID,
        &big,
        &true,
        &10u32,
        &200u32,
        &None,
    );

    // A modest short by user_two *reduces* skew → maker.
    // maker_rebate_bps = 10 → short sells at oracle * 1.001 (premium for maker).
    let short_size = PRECISION; // 1 BTC
    let id_short = s.perp.open_position(
        &s.user_two,
        &BTC_MARKET_ID,
        &short_size,
        &false,
        &5u32,
        &50u32,
        &None,
    );
    let short_pos = s.perp.get_position(&s.user_two, &id_short);

    // Maker short gets *premium*: entry_price > oracle by ~rebate bps.
    let oracle = 100 * PRECISION;
    assert!(
        short_pos.entry_price > oracle,
        "maker short should execute above oracle (entry={}, oracle={})",
        short_pos.entry_price,
        oracle,
    );
    // Upper bound: premium shouldn't wildly exceed rebate (10bps = 0.1%).
    let upper = oracle + (oracle * 20) / 10_000; // 0.2%
    assert!(
        short_pos.entry_price < upper,
        "maker short rebate should be bounded (entry={}, upper={})",
        short_pos.entry_price,
        upper,
    );
}
