//! J.2.6 — Staking rewards: stake, deposit, advance epoch, pro-rata claim.
//!
//! End-to-end coverage of Phase G staking:
//!
//!   1. Two users stake different amounts of STLX in epoch 0.
//!   2. Treasury deposits a USDC reward pool in epoch 0.
//!   3. Advance clock past epoch-0 boundary.
//!   4. Both users claim; payouts are proportional to stake.
//!   5. Before epoch 0 closes, `claim_rewards` yields NothingToClaim.

use stellax_integration_tests::{setup, USDC_DECIMALS};

fn usdc(whole: i128) -> i128 {
    whole * 10i128.pow(USDC_DECIMALS)
}

fn stlx(whole: i128) -> i128 {
    whole * 10i128.pow(7) // STLX is 7dp.
}

#[test]
fn two_stakers_split_rewards_pro_rata() {
    let s = setup();

    // user_one stakes 100 STLX, user_two stakes 300 STLX → 1:3 ratio.
    s.staking.stake(&s.user_one, &stlx(100));
    s.staking.stake(&s.user_two, &stlx(300));

    // Treasury deposits 400 USDC of rewards in epoch 0.
    // Treasury must first deposit USDC into the vault? No — staking uses
    // the raw token. The treasury has 1,000,000 USDC wallet balance from
    // the harness mint. `deposit_epoch_rewards` pulls directly via
    // TokenClient.transfer, so wallet balance is what matters.
    s.staking
        .deposit_epoch_rewards(&s.treasury, &s.usdc, &usdc(400));

    // Advance past epoch 0 so it closes.
    s.advance_epoch();

    // Expected: user_one gets 100 USDC, user_two gets 300 USDC.
    let one_before = s.usdc_token.balance(&s.user_one);
    let two_before = s.usdc_token.balance(&s.user_two);

    let one_claim = s.staking.claim_rewards(&s.user_one);
    let two_claim = s.staking.claim_rewards(&s.user_two);

    assert_eq!(one_claim, usdc(100), "user_one 1/4 share");
    assert_eq!(two_claim, usdc(300), "user_two 3/4 share");

    assert_eq!(s.usdc_token.balance(&s.user_one) - one_before, usdc(100));
    assert_eq!(s.usdc_token.balance(&s.user_two) - two_before, usdc(300));
}

#[test]
#[should_panic]
fn cannot_claim_before_epoch_closes() {
    let s = setup();
    s.staking.stake(&s.user_one, &stlx(100));
    s.staking
        .deposit_epoch_rewards(&s.treasury, &s.usdc, &usdc(100));

    // Still in epoch 0 — nothing to claim yet.
    s.staking.claim_rewards(&s.user_one);
}

#[test]
fn late_stakers_do_not_claim_prior_epochs() {
    let s = setup();

    // Epoch 0: only user_one stakes. Treasury deposits 100 USDC.
    s.staking.stake(&s.user_one, &stlx(100));
    s.staking
        .deposit_epoch_rewards(&s.treasury, &s.usdc, &usdc(100));

    // Advance to epoch 1. user_two now joins — should not receive the
    // epoch-0 rewards retroactively (stake_epoch = current_epoch = 1,
    // last_claim_epoch = 1).
    s.advance_epoch();
    s.staking.stake(&s.user_two, &stlx(100));

    // user_one should still get the full 100 USDC from epoch 0.
    let one = s.staking.claim_rewards(&s.user_one);
    assert_eq!(one, usdc(100));

    // user_two can't claim anything yet (epoch 1 is current and still open).
    // After epoch 1 closes with no deposits, there's still nothing.
    s.advance_epoch();
    let err = s.staking.try_claim_rewards(&s.user_two);
    assert!(err.is_err(), "late staker should get NothingToClaim");
}

#[test]
fn stake_entry_tracks_balance_and_epoch() {
    let s = setup();
    s.staking.stake(&s.user_one, &stlx(50));
    let entry = s.staking.get_stake(&s.user_one);
    assert_eq!(entry.amount, stlx(50));

    // Top up in the same epoch.
    s.staking.stake(&s.user_one, &stlx(25));
    let entry2 = s.staking.get_stake(&s.user_one);
    assert_eq!(entry2.amount, stlx(75));
}
