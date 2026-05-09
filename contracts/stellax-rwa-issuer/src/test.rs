//! Unit tests for `stellax-rwa-issuer`.
//!
//! Exercises the full SEP-41 surface plus the bespoke `credit_yield` batch,
//! `auth_required` opt-in, APY metadata, and admin pause path. Each test
//! uses `env.mock_all_auths()` because the contract relies on
//! `require_auth()` for both holder transfers and admin operations.

use super::*;
use soroban_sdk::{testutils::Address as _, Address, Env, String, Vec};

fn deploy(env: &Env, auth_required: bool) -> (Address, StellaxRwaIssuerClient<'_>, Address) {
    let admin = Address::generate(env);
    let contract_id = env.register(
        StellaxRwaIssuer,
        (
            admin.clone(),
            String::from_str(env, "Mock Franklin BENJI"),
            String::from_str(env, "BENJI"),
            6u32,
            500u32, // 5.00% APY
            auth_required,
        ),
    );
    let client = StellaxRwaIssuerClient::new(env, &contract_id);
    (contract_id, client, admin)
}

#[test]
fn metadata_matches_constructor() {
    let env = Env::default();
    let (_, client, _) = deploy(&env, false);
    assert_eq!(client.symbol(), String::from_str(&env, "BENJI"));
    assert_eq!(client.decimals(), 6u32);
    let cfg = client.get_config();
    assert_eq!(cfg.apy_bps, 500);
    assert!(!cfg.auth_required);
    assert!(!cfg.paused);
    assert_eq!(cfg.total_supply, 0);
}

#[test]
fn mint_increases_balance_and_total_supply() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client, _) = deploy(&env, false);
    let alice = Address::generate(&env);
    client.mint(&alice, &1_000_000); // 1 BENJI at 6 decimals
    assert_eq!(client.balance(&alice), 1_000_000);
    assert_eq!(client.get_config().total_supply, 1_000_000);
}

#[test]
fn transfer_moves_balance() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client, _) = deploy(&env, false);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    client.mint(&alice, &10_000_000);
    client.transfer(&alice, &bob, &3_000_000);
    assert_eq!(client.balance(&alice), 7_000_000);
    assert_eq!(client.balance(&bob), 3_000_000);
}

#[test]
fn approve_then_transfer_from_consumes_allowance() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client, _) = deploy(&env, false);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let carol = Address::generate(&env);
    client.mint(&alice, &10_000_000);
    let exp = env.ledger().sequence() + 1_000;
    client.approve(&alice, &bob, &5_000_000, &exp);
    assert_eq!(client.allowance(&alice, &bob), 5_000_000);
    client.transfer_from(&bob, &alice, &carol, &2_000_000);
    assert_eq!(client.allowance(&alice, &bob), 3_000_000);
    assert_eq!(client.balance(&carol), 2_000_000);
}

#[test]
fn burn_reduces_supply() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client, _) = deploy(&env, false);
    let alice = Address::generate(&env);
    client.mint(&alice, &10_000_000);
    client.burn(&alice, &4_000_000);
    assert_eq!(client.balance(&alice), 6_000_000);
    assert_eq!(client.get_config().total_supply, 6_000_000);
}

#[test]
fn credit_yield_drips_to_many_holders_and_tracks_cumulative() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client, _) = deploy(&env, false);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    client.mint(&alice, &1_000_000_000); // 1000 BENJI
    client.mint(&bob, &500_000_000); //  500 BENJI

    // Drip 5.00% APY for 1 day = 1000 * 0.05 / 365 ≈ 0.137 BENJI for alice,
    // 500 * 0.05 / 365 ≈ 0.0685 BENJI for bob (in 6-decimal native units).
    let mut holders = Vec::new(&env);
    holders.push_back(alice.clone());
    holders.push_back(bob.clone());
    let mut deltas = Vec::new(&env);
    deltas.push_back(137_000i128);
    deltas.push_back(68_500i128);

    client.credit_yield(&holders, &deltas, &1u64);

    assert_eq!(client.balance(&alice), 1_000_000_000 + 137_000);
    assert_eq!(client.balance(&bob), 500_000_000 + 68_500);
    assert_eq!(client.cumulative_yield(&alice), 137_000);
    assert_eq!(client.cumulative_yield(&bob), 68_500);
    assert_eq!(
        client.get_config().total_supply,
        1_500_000_000 + 137_000 + 68_500
    );

    // Idempotent across epochs: a second drip accumulates without losing the first.
    let mut deltas2 = Vec::new(&env);
    deltas2.push_back(137_000i128);
    deltas2.push_back(68_500i128);
    client.credit_yield(&holders, &deltas2, &2u64);
    assert_eq!(client.cumulative_yield(&alice), 274_000);
}

#[test]
fn credit_yield_skips_zero_deltas() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client, _) = deploy(&env, false);
    let alice = Address::generate(&env);
    client.mint(&alice, &1_000_000);

    let mut holders = Vec::new(&env);
    holders.push_back(alice.clone());
    let mut deltas = Vec::new(&env);
    deltas.push_back(0i128); // rounds to zero this epoch

    client.credit_yield(&holders, &deltas, &1u64);
    assert_eq!(client.balance(&alice), 1_000_000);
    assert_eq!(client.cumulative_yield(&alice), 0);
}

#[test]
fn credit_yield_rejects_length_mismatch() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client, _) = deploy(&env, false);
    let alice = Address::generate(&env);
    let mut holders = Vec::new(&env);
    holders.push_back(alice);
    let deltas: Vec<i128> = Vec::new(&env);
    let res = client.try_credit_yield(&holders, &deltas, &1u64);
    assert_eq!(res, Err(Ok(RwaError::LengthMismatch)));
}

#[test]
fn auth_required_blocks_unauthorized_mint_and_allows_authorized() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client, _) = deploy(&env, true);
    let alice = Address::generate(&env);

    // Without authorisation, mint fails with NotAuthorized — proves our
    // mainnet-readiness against AUTH_REQUIRED-flagged real BENJI/USDY.
    let res = client.try_mint(&alice, &1_000_000);
    assert_eq!(res, Err(Ok(RwaError::NotAuthorized)));

    client.set_authorized(&alice, &true);
    client.mint(&alice, &1_000_000);
    assert_eq!(client.balance(&alice), 1_000_000);
}

#[test]
fn pause_blocks_transfers_and_mints() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client, _) = deploy(&env, false);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    client.mint(&alice, &1_000_000);
    client.pause();
    assert_eq!(
        client.try_transfer(&alice, &bob, &10),
        Err(Ok(RwaError::Paused))
    );
    assert_eq!(client.try_mint(&alice, &10), Err(Ok(RwaError::Paused)));
    client.unpause();
    client.transfer(&alice, &bob, &10);
    assert_eq!(client.balance(&bob), 10);
}

#[test]
fn set_apy_bps_rejects_excessive_values() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client, _) = deploy(&env, false);
    assert_eq!(
        client.try_set_apy_bps(&50_000), // 500% — clearly a bug
        Err(Ok(RwaError::InvalidConfig))
    );
    client.set_apy_bps(&525); // 5.25% — accepted
    assert_eq!(client.get_config().apy_bps, 525);
}
