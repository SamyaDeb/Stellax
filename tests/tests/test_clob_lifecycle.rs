//! J.2.2 — CLOB order lifecycle: place → match → settle.
//!
//! Exercises the real `stellax-clob` contract end-to-end against perp engine:
//!
//!   1. A buy and a sell at crossing prices on the same market can be
//!      settled by the keeper.
//!   2. After settlement both orders are Filled and positions exist in perp.
//!   3. Non-keeper callers cannot settle.
//!   4. Traders can cancel their own open orders (and only their own).

use soroban_sdk::testutils::Address as _;
use soroban_sdk::Address;
use stellax_integration_tests::{setup, BTC_MARKET_ID, PRECISION, USDC_DECIMALS};
use stellax_math::types::OrderStatus;

fn usdc(whole: i128) -> i128 {
    whole * 10i128.pow(USDC_DECIMALS)
}

#[test]
fn crossing_orders_settle_and_produce_positions() {
    let s = setup();
    s.vault.deposit(&s.user_one, &s.usdc, &usdc(200_000));
    s.vault.deposit(&s.user_two, &s.usdc, &usdc(200_000));

    let size = PRECISION / 10; // 0.1 BTC
    let buy_price = 101 * PRECISION;
    let sell_price = 99 * PRECISION;

    // user_one places buy (long), user_two places sell (short).
    let buy_id = s.place_limit_order(&s.user_one, BTC_MARKET_ID, size, buy_price, true, 5);
    let sell_id = s.place_limit_order(&s.user_two, BTC_MARKET_ID, size, sell_price, false, 5);

    // Keeper settles.
    let fill = s.clob.settle_matched_orders(&s.keeper, &buy_id, &sell_id);
    assert_eq!(fill, size, "full fill expected");

    let buy = s.clob.get_order(&buy_id);
    let sell = s.clob.get_order(&sell_id);
    assert_eq!(buy.status, OrderStatus::Filled);
    assert_eq!(sell.status, OrderStatus::Filled);
    assert_eq!(buy.filled_size, size);
    assert_eq!(sell.filled_size, size);

    // Each trader should now hold an open position on the BTC market.
    let one_positions = s.perp.get_positions_by_user(&s.user_one);
    let two_positions = s.perp.get_positions_by_user(&s.user_two);
    assert_eq!(one_positions.len(), 1, "user_one should have 1 position");
    assert_eq!(two_positions.len(), 1, "user_two should have 1 position");

    let pos_one = one_positions.get(0).unwrap().position;
    let pos_two = two_positions.get(0).unwrap().position;
    assert!(pos_one.is_long, "buyer should be long");
    assert!(!pos_two.is_long, "seller should be short");
    assert_eq!(pos_one.size, size);
    assert_eq!(pos_two.size, size);
    // Fill price = midpoint = 100.
    assert_eq!(pos_one.entry_price, 100 * PRECISION);
    assert_eq!(pos_two.entry_price, 100 * PRECISION);
}

#[test]
fn partial_fill_leaves_remainder_open() {
    let s = setup();
    s.vault.deposit(&s.user_one, &s.usdc, &usdc(200_000));
    s.vault.deposit(&s.user_two, &s.usdc, &usdc(200_000));

    // Buyer wants 1 BTC, seller only offers 0.3 BTC.
    let buy_size = PRECISION;
    let sell_size = PRECISION * 3 / 10;

    let buy_id = s.place_limit_order(
        &s.user_one,
        BTC_MARKET_ID,
        buy_size,
        101 * PRECISION,
        true,
        5,
    );
    let sell_id = s.place_limit_order(
        &s.user_two,
        BTC_MARKET_ID,
        sell_size,
        99 * PRECISION,
        false,
        5,
    );

    let fill = s.clob.settle_matched_orders(&s.keeper, &buy_id, &sell_id);
    assert_eq!(fill, sell_size);

    let buy = s.clob.get_order(&buy_id);
    let sell = s.clob.get_order(&sell_id);
    assert_eq!(buy.status, OrderStatus::Open, "buy has remainder");
    assert_eq!(buy.filled_size, sell_size);
    assert_eq!(sell.status, OrderStatus::Filled);
}

#[test]
#[should_panic]
fn non_keeper_cannot_settle() {
    let s = setup();
    s.vault.deposit(&s.user_one, &s.usdc, &usdc(200_000));
    s.vault.deposit(&s.user_two, &s.usdc, &usdc(200_000));

    let size = PRECISION / 10;
    let buy_id = s.place_limit_order(&s.user_one, BTC_MARKET_ID, size, 101 * PRECISION, true, 5);
    let sell_id = s.place_limit_order(&s.user_two, BTC_MARKET_ID, size, 99 * PRECISION, false, 5);

    // Random address — not the keeper.
    let imposter = Address::generate(&s.env);
    s.clob.settle_matched_orders(&imposter, &buy_id, &sell_id);
}

#[test]
fn trader_can_cancel_own_open_order() {
    let s = setup();
    s.vault.deposit(&s.user_one, &s.usdc, &usdc(200_000));

    let size = PRECISION / 10;
    let order_id = s.place_limit_order(&s.user_one, BTC_MARKET_ID, size, 101 * PRECISION, true, 5);

    s.clob.cancel_order(&s.user_one, &order_id);
    let order = s.clob.get_order(&order_id);
    assert_eq!(order.status, OrderStatus::Cancelled);
}

#[test]
#[should_panic]
fn non_owner_cannot_cancel_order() {
    let s = setup();
    s.vault.deposit(&s.user_one, &s.usdc, &usdc(200_000));

    let size = PRECISION / 10;
    let order_id = s.place_limit_order(&s.user_one, BTC_MARKET_ID, size, 101 * PRECISION, true, 5);

    // user_two is not the order owner.
    s.clob.cancel_order(&s.user_two, &order_id);
}

#[test]
#[should_panic]
fn non_crossing_prices_cannot_settle() {
    let s = setup();
    s.vault.deposit(&s.user_one, &s.usdc, &usdc(200_000));
    s.vault.deposit(&s.user_two, &s.usdc, &usdc(200_000));

    let size = PRECISION / 10;
    // Buy price BELOW sell price → does not cross.
    let buy_id = s.place_limit_order(&s.user_one, BTC_MARKET_ID, size, 98 * PRECISION, true, 5);
    let sell_id = s.place_limit_order(&s.user_two, BTC_MARKET_ID, size, 102 * PRECISION, false, 5);

    s.clob.settle_matched_orders(&s.keeper, &buy_id, &sell_id);
}
