// ── Treasury e2e: collect_fee → distribute → treasury/staker balances ─────────
//
// Treasury on testnet:
//   admin          = deployer
//   insurance_fund = deployer (admin address, used during initialization)
//   insurance_cap  = 1_000_000_000_000_000_000_000 (enormous — never capped)
//   splits         = insurance:60%, treasury:20%, staker:20%
//
// Authorized fee sources (wired at deploy time): perp_engine, options, risk.
// The deployer is NOT in the list. We add it in this test so we can drive
// collect_fee without needing to go through the full trading path.
//
// Flow:
//  1. version() → 1.
//  2. add_authorized_source(deployer, deployer_addr) — idempotent if re-run.
//  3. Fund treasury contract with 2 USDC via USDC SAC transfer (so distribute
//     can physically send tokens to the insurance_fund = deployer).
//  4. collect_fee(deployer, USDC, 2_000_000) — accounting only; verify pending.
//  5. distribute(USDC) → insurance receives 60%, treasury bucket = 20%, staker = 20%.
//  6. get_treasury_balance(USDC) = 400_000.
//  7. get_staker_balance(USDC) = 400_000.
//  8. get_pending_fees(USDC) = 0.
//  9. withdraw_treasury(deployer, USDC, 100_000) → deployer balance increases.
// 10. get_treasury_balance(USDC) decreases by 100_000.

import { beforeAll, describe, expect, it } from "vitest";

import { getCtx } from "../lib/fixtures.js";
import { invoke, simulateRead } from "../lib/invoke.js";
import { addrVal, i128Val } from "../lib/scval.js";
import { fundWithUsdc } from "../lib/stellar-classic.js";

// ── Constants ─────────────────────────────────────────────────────────────────

// 2 USDC in Stellar 7-decimal (2 * 10^7 = 20_000_000 stroops)
const FEE_AMOUNT = 2_000_0000n; // 2 USDC

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("treasury", () => {
  const ctx = getCtx();

  // ── Setup ──────────────────────────────────────────────────────────────────

  beforeAll(async () => {
    // Fund the deployer with USDC so it can transfer to the treasury contract.
    console.log("  ▸ funding deployer with 5 USDC for treasury test …");
    await fundWithUsdc(ctx.deployer, 5);
    console.log(`    deployer: ${ctx.deployer.publicKey()}`);
  }, 120_000);

  // ── Test 1: version ────────────────────────────────────────────────────────

  it("version() returns deployed treasury version", async () => {
    const v = await simulateRead<number>(
      ctx.net,
      ctx.deployer.publicKey(),
      ctx.deployments.treasury,
      "version",
      [],
    );
    console.log(`    treasury version: ${v}`);
    expect(v).toBeGreaterThanOrEqual(1);
  });

  // ── Test 2: add_authorized_source (deployer → test fee source) ────────────

  it("add_authorized_source registers deployer as fee source", async () => {
    // Idempotent — safe to call multiple times (no error, just no-op if exists).
    await invoke(
      ctx.net,
      ctx.deployer,
      ctx.deployments.treasury,
      "add_authorized_source",
      [addrVal(ctx.deployer.publicKey())],
    );
    console.log(`    added authorized source: ${ctx.deployer.publicKey()}`);
    // No assertion needed — if it throws the test fails.
  });

  // ── Test 3 + 4: fund contract + collect_fee ────────────────────────────────

  it("collect_fee increments pending_fees", async () => {
    // Read existing pending before this test run (may be > 0 from prior test).
    const pendingBefore = await simulateRead<bigint>(
      ctx.net,
      ctx.deployer.publicKey(),
      ctx.deployments.treasury,
      "get_pending_fees",
      [addrVal(ctx.deployments.usdc)],
    );
    console.log(`    pending_fees before: ${pendingBefore}`);

    // Transfer FEE_AMOUNT USDC from deployer to treasury so distribute can pay out.
    // (collect_fee only updates accounting; the tokens must already be in the contract.)
    await invoke(ctx.net, ctx.deployer, ctx.deployments.usdc, "transfer", [
      addrVal(ctx.deployer.publicKey()),
      addrVal(ctx.deployments.treasury),
      i128Val(FEE_AMOUNT),
    ]);
    console.log(`    transferred ${FEE_AMOUNT} USDC to treasury`);

    // Collect the fee — deployer is now an authorized source.
    // source.require_auth() is satisfied by the deployer signing the tx.
    await invoke(ctx.net, ctx.deployer, ctx.deployments.treasury, "collect_fee", [
      addrVal(ctx.deployer.publicKey()),
      addrVal(ctx.deployments.usdc),
      i128Val(FEE_AMOUNT),
    ]);

    const pendingAfter = await simulateRead<bigint>(
      ctx.net,
      ctx.deployer.publicKey(),
      ctx.deployments.treasury,
      "get_pending_fees",
      [addrVal(ctx.deployments.usdc)],
    );
    console.log(`    pending_fees after collect_fee: ${pendingAfter}`);
    expect(pendingAfter).toBe(pendingBefore + FEE_AMOUNT);
  });

  // ── Test 5: distribute splits fees correctly ──────────────────────────────

  it("distribute splits fees 60/20/20 and clears pending", async () => {
    // Record balances before so we can compute deltas (prior test runs may
    // have left non-zero treasury/staker balances).
    const tbBefore = await simulateRead<bigint>(
      ctx.net,
      ctx.deployer.publicKey(),
      ctx.deployments.treasury,
      "get_treasury_balance",
      [addrVal(ctx.deployments.usdc)],
    );
    const sbBefore = await simulateRead<bigint>(
      ctx.net,
      ctx.deployer.publicKey(),
      ctx.deployments.treasury,
      "get_staker_balance",
      [addrVal(ctx.deployments.usdc)],
    );
    console.log(`    treasury_balance before distribute: ${tbBefore}`);
    console.log(`    staker_balance   before distribute: ${sbBefore}`);

    // Distribute — permissionless, anyone can call.
    await invoke(ctx.net, ctx.deployer, ctx.deployments.treasury, "distribute", [
      addrVal(ctx.deployments.usdc),
    ]);

    const tbAfter = await simulateRead<bigint>(
      ctx.net,
      ctx.deployer.publicKey(),
      ctx.deployments.treasury,
      "get_treasury_balance",
      [addrVal(ctx.deployments.usdc)],
    );
    const sbAfter = await simulateRead<bigint>(
      ctx.net,
      ctx.deployer.publicKey(),
      ctx.deployments.treasury,
      "get_staker_balance",
      [addrVal(ctx.deployments.usdc)],
    );
    const pending = await simulateRead<bigint>(
      ctx.net,
      ctx.deployer.publicKey(),
      ctx.deployments.treasury,
      "get_pending_fees",
      [addrVal(ctx.deployments.usdc)],
    );

    console.log(`    treasury_balance after distribute: ${tbAfter}`);
    console.log(`    staker_balance   after distribute: ${sbAfter}`);
    console.log(`    pending_fees     after distribute: ${pending}`);

    // treasury: +20% of FEE_AMOUNT, staker: +20% of FEE_AMOUNT
    const expectedTreasuryDelta = (FEE_AMOUNT * 2000n) / 10000n;  // 20%
    const expectedStakerDelta   = (FEE_AMOUNT * 2000n) / 10000n;  // 20%

    expect(tbAfter - tbBefore).toBe(expectedTreasuryDelta);
    expect(sbAfter - sbBefore).toBe(expectedStakerDelta);
    expect(pending).toBe(0n);
  });

  // ── Test 6: withdraw_treasury sends tokens to destination ─────────────────

  it("withdraw_treasury moves tokens out of the treasury bucket", async () => {
    const tbBefore = await simulateRead<bigint>(
      ctx.net,
      ctx.deployer.publicKey(),
      ctx.deployments.treasury,
      "get_treasury_balance",
      [addrVal(ctx.deployments.usdc)],
    );
    console.log(`    treasury_balance before withdraw: ${tbBefore}`);
    expect(tbBefore).toBeGreaterThan(0n);

    const withdrawAmount = 100_000n; // 0.01 USDC

    await invoke(ctx.net, ctx.deployer, ctx.deployments.treasury, "withdraw_treasury", [
      addrVal(ctx.deployer.publicKey()),
      addrVal(ctx.deployments.usdc),
      i128Val(withdrawAmount),
    ]);

    const tbAfter = await simulateRead<bigint>(
      ctx.net,
      ctx.deployer.publicKey(),
      ctx.deployments.treasury,
      "get_treasury_balance",
      [addrVal(ctx.deployments.usdc)],
    );
    console.log(`    treasury_balance after withdraw: ${tbAfter}`);
    expect(tbBefore - tbAfter).toBe(withdrawAmount);
  });
});
