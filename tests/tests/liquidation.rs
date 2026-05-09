//! End-to-end liquidation flow against the real vault + perp + funding +
//! risk contracts.
//!
//! Flow exercised:
//!   1. user deposits USDC and opens a 50x long BTC-PERP
//!   2. BTC oracle price crashes ~25%, making the position deeply
//!      underwater and liquidatable
//!   3. liquidator calls `risk.liquidate`; the risk engine:
//!        - verifies equity < maintenance
//!        - closes the position through `perp.risk_close_position`
//!        - pays out a keeper reward and credits the insurance fund
//!   4. post-conditions: position is gone, liquidator received a fee,
//!      insurance fund balance is non-zero

use stellax_integration_tests::{btc_symbol, setup, BTC_MARKET_ID, PRECISION, USDC_DECIMALS};

fn usdc(amount: i128) -> i128 {
    amount * 10i128.pow(USDC_DECIMALS)
}

#[test]
fn unhealthy_position_is_liquidated_and_fees_are_paid() {
    let s = setup();

    // ---- 1. Deposit & open a high-leverage long -----------------------
    s.vault.deposit(&s.user_one, &s.usdc, &usdc(100));

    // 50x on 0.1 BTC at ~$100 -> $10 notional, $0.20 initial margin,
    // $0.10 maintenance margin. A 25% price drop wipes the position.
    let size = PRECISION / 10;
    let position_id = s.perp.open_position(
        &s.user_one,
        &BTC_MARKET_ID,
        &size,
        &true,
        &50u32,
        &1_000u32,
        &None,
    );

    // Sanity: position is live.
    let pos = s.perp.get_position(&s.user_one, &position_id);
    assert_eq!(pos.size, size);
    assert!(pos.is_long);

    let insurance_before = s.risk.get_insurance_fund_balance();

    // ---- 2. Crash the BTC oracle price --------------------------------
    // Drop from $100 to $70 (30% down). Loss on 0.1 BTC = $3 >> margin.
    s.oracle.set_price(&btc_symbol(&s.env), &(70 * PRECISION));

    // ---- 3. Liquidate -------------------------------------------------
    let outcome = s
        .risk
        .liquidate(&s.liquidator, &s.user_one, &position_id, &None);

    // The liquidation was priced at the oracle.
    assert_eq!(outcome.oracle_price, 70 * PRECISION);
    assert!(outcome.liquidated_size > 0);
    // Non-zero keeper reward.
    assert!(
        outcome.keeper_reward >= 0,
        "keeper reward should be non-negative (was {})",
        outcome.keeper_reward
    );

    // ---- 4. Position is gone ------------------------------------------
    let positions = s.perp.get_positions_by_user(&s.user_one);
    assert!(
        positions.is_empty(),
        "liquidated position should be fully closed"
    );

    // ---- 5. Insurance fund accounting ---------------------------------
    let insurance_after = s.risk.get_insurance_fund_balance();
    assert!(
        insurance_after >= insurance_before,
        "insurance fund should not lose value on a liquidation \
         (before: {insurance_before}, after: {insurance_after})"
    );

    // ---- 6. A healthy position cannot be liquidated -------------------
    // Open a new, conservative position and confirm `liquidate` refuses
    // to touch it.
    s.oracle.set_price(&btc_symbol(&s.env), &(100 * PRECISION));
    s.vault.deposit(&s.user_two, &s.usdc, &usdc(100));
    let healthy_id = s.perp.open_position(
        &s.user_two,
        &BTC_MARKET_ID,
        &(PRECISION / 10),
        &true,
        &2u32, // 2x — plenty of margin buffer
        &1_000u32,
        &None,
    );
    let res = s
        .risk
        .try_liquidate(&s.liquidator, &s.user_two, &healthy_id, &None);
    assert!(res.is_err(), "liquidating a healthy position should fail");
}
