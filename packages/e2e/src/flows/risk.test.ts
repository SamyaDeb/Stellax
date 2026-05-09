// ── Risk engine e2e: forced liquidation ───────────────────────────────────────
//
// Setup:
//   • V2 opens a short near the current oracle price.
//   • The test then admin-pushes a higher XLM price to force the short below
//     maintenance and exercise the liquidation path deterministically.
//
// Flow:
//  1. Open a short position (size=1e18, leverage=5, max_slippage_bypass).
//  2. Call `get_account_health(user)` — shows health metrics.
//  3. Call `risk.liquidate(keeper, user, positionId, None)` signed by keeper.
//  4. Verify `LiquidationOutcome.liquidated_size > 0`.
//  5. Verify position is gone after full liquidation close.

import { beforeAll, describe, expect, it } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
import type { Keypair } from "@stellar/stellar-sdk";

import { getCtx, spawnUsers } from "../lib/fixtures.js";
import { invoke, simulateRead } from "../lib/invoke.js";
import { fetchRedStonePayload } from "../lib/redstone.js";
import {
  addrVal,
  boolVal,
  bytesVal,
  i128Val,
  symbolVal,
  u32Val,
  u64Val,
} from "../lib/scval.js";
import { fundWithUsdc } from "../lib/stellar-classic.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const MARKET_XLM = 0;
const SIZE_1XLM = 1_000_000_000_000_000_000n;  // 1e18
const MAX_SLIPPAGE_BYPASS = 1_000_000_000;
const DEPOSIT_NATIVE = 100_000_000n;            // 10 USDC in 7-dec
const ALL_FEEDS = ["XLM", "BTC", "ETH", "SOL", "USDC"];

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("risk", () => {
  const ctx = getCtx();
  let user: Keypair;
  let keeper: Keypair;
  let shortPositionId: bigint;

  beforeAll(async () => {
    console.log("  ▸ pushing fresh RedStone prices …");
    const payload = await fetchRedStonePayload(ALL_FEEDS);
    try {
      await invoke(ctx.net, ctx.deployer, ctx.deployments.oracle, "write_prices", [
        bytesVal(payload),
      ]);
    } catch (err) {
      if (!String(err).includes("#11")) throw err;
      console.log("    RedStone payload is older than stored oracle price; using stored price");
    }

    console.log("  ▸ spawning user + keeper, funding user with 10 USDC …");
    [user, keeper] = await spawnUsers(2, "risk-user");
    await fundWithUsdc(user, 10);
    await invoke(ctx.net, user, ctx.deployments.vault, "deposit", [
      addrVal(user.publicKey()),
      addrVal(ctx.deployments.usdc),
      i128Val(DEPOSIT_NATIVE),
    ]);
    console.log(`    user:   ${user.publicKey()}`);
    console.log(`    keeper: ${keeper.publicKey()}`);
  }, 180_000);

  // ── Test 1: open short position ────────────────────────────────────────────

  it("opens a short XLM-PERP position at vAMM entry price", async () => {
    const posId = await invoke<bigint>(
      ctx.net,
      user,
      ctx.deployments.perp_engine,
      "open_position",
      [
        addrVal(user.publicKey()),
        u32Val(MARKET_XLM),
        i128Val(SIZE_1XLM),
        boolVal(false),           // short
        u32Val(5),                // leverage
        u32Val(MAX_SLIPPAGE_BYPASS),
        xdr.ScVal.scvVoid(),      // price_payload = None
      ],
    );
    shortPositionId = posId!;
    console.log(`    opened short position_id: ${shortPositionId}`);
    expect(typeof shortPositionId).toBe("bigint");
    expect(shortPositionId).toBeGreaterThan(0n);
  });

  // ── Test 2: account health check ──────────────────────────────────────────

  it("get_account_health returns health metrics for user", async () => {
    // At account level, equity = vault_collateral + unrealized_pnl.
    // user has 10 USDC deposited; short PnL at oracle ≈ -0.16 USDC.
    // equity ≈ 9.84 USDC >> maintenance (< 0.01 USDC) → NOT account-liquidatable.
    // However, at position level (position.margin only), it IS liquidatable.
    type AccountHealth = {
      equity: bigint;
      total_margin_required: bigint;
      margin_ratio: bigint;
      free_collateral: bigint;
      liquidatable: boolean;
    };
    const health = await simulateRead<AccountHealth>(
      ctx.net,
      ctx.deployer.publicKey(),
      ctx.deployments.risk,
      "get_account_health",
      [addrVal(user.publicKey())],
    );
    console.log(`    equity:                ${health.equity}`);
    console.log(`    total_margin_required: ${health.total_margin_required}`);
    console.log(`    free_collateral:       ${health.free_collateral}`);
    console.log(`    liquidatable (acct):   ${health.liquidatable}`);
    // equity should be close to 10 USDC (10e18) minus a small loss
    expect(health.equity).toBeGreaterThan(0n);
  });

  // ── Test 3: liquidate the under-margined position ─────────────────────────

  it("liquidate(keeper, user, posId) succeeds — position margin < maintenance", async () => {
    await invoke(ctx.net, ctx.deployer, ctx.deployments.oracle, "admin_push_price", [
      symbolVal("XLM"),
      i128Val(1_000_000_000_000_000_000n),
      u64Val(BigInt(Date.now()) + 10_000_000n),
    ]);

    type LiquidationOutcome = {
      liquidated_size: bigint;
      oracle_price: bigint;
      remaining_margin: bigint;
      keeper_reward: bigint;
      insurance_delta: bigint;
      adl_triggered: boolean;
    };
    const outcome = await invoke<LiquidationOutcome>(
      ctx.net,
      keeper,
      ctx.deployments.risk,
      "liquidate",
      [
        addrVal(keeper.publicKey()),
        addrVal(user.publicKey()),
        u64Val(shortPositionId),
        xdr.ScVal.scvVoid(),
      ],
    );
    console.log(`    liquidated_size:  ${outcome!.liquidated_size}`);
    console.log(`    oracle_price:     ${outcome!.oracle_price}`);
    console.log(`    remaining_margin: ${outcome!.remaining_margin}`);
    console.log(`    keeper_reward:    ${outcome!.keeper_reward}`);
    console.log(`    insurance_delta:  ${outcome!.insurance_delta}`);
    console.log(`    adl_triggered:    ${outcome!.adl_triggered}`);

    expect(outcome!.liquidated_size).toBeGreaterThan(0n);
    expect(outcome!.oracle_price).toBeGreaterThan(0n);
  });

  // ── Test 4: position is gone after liquidation ────────────────────────────

  it("position no longer exists after full liquidation", async () => {
    let notFound = false;
    try {
      await simulateRead(
        ctx.net,
        user.publicKey(),
        ctx.deployments.perp_engine,
        "get_position",
        [addrVal(user.publicKey()), u64Val(shortPositionId)],
      );
    } catch {
      notFound = true;
    }
    expect(notFound).toBe(true);
  });
});
