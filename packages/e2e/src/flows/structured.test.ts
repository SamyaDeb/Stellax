// ── Structured vault e2e: deposit / roll / settle / roll ──────────────────────
//
// Structured vault on testnet:
//   kind = CoveredCall, option_market_id = 0 (XLM), strike_delta_bps = 1000 (10% OTM)
//   epoch_duration_override = 120s, option_asset = XLM
//
// This test is designed for repeated runs on testnet.  Because the structured
// contract stores epoch state persistently, prior runs leave an active epoch.
// The beforeAll hook detects the current epoch state and either:
//   a) rolls a stale (expired) epoch to start a fresh one, or
//   b) waits for the current active epoch to expire, then rolls it.
//
// Deposit behaviour depends on whether an epoch is active at the time of the
// deposit call (mid-epoch ↔ !epoch.settled — and since settled is always false
// after the first roll_epoch, deposits are ALWAYS queued on repeated runs).
//
// The test therefore:
//  1. Accepts 0 shares after deposit when queued (mid-epoch).
//  2. Skips the between-epoch withdraw path when the user has no shares.
//  3. Uses relative epoch IDs (baseEpochId + 1, baseEpochId + 2) so assertions
//     remain correct regardless of how many prior runs have been executed.
//
// Flow (first run vs repeated run):
//  • First run (no prior epoch): deposit → immediate 1:1 shares, withdraw 2e18, roll × 2.
//  • Repeated runs: epoch already active → deposit queued → roll × 2, verify epoch_id.

import { beforeAll, describe, expect, it } from "vitest";
import type { Keypair } from "@stellar/stellar-sdk";

import { getCtx, spawnUsers } from "../lib/fixtures.js";
import { invoke, simulateRead } from "../lib/invoke.js";
import { fetchRedStonePayload } from "../lib/redstone.js";
import {
  addrVal,
  bytesVal,
  i128Val,
  u32Val,
} from "../lib/scval.js";
import { fundWithUsdc } from "../lib/stellar-classic.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const MARKET_XLM = 0;
const IV_80PCT = 800_000_000_000_000_000n;           // 0.8e18 = 80% annualised
const DEPOSIT_NATIVE = 100_000_000n;                  // 10 USDC in 7-dec
const DEPOSIT_INTERNAL = 10_000_000_000_000_000_000n; // 10e18 (18-dec)
const WITHDRAW_SHARES = 2_000_000_000_000_000_000n;   // 2e18 shares = 2 USDC

const ALL_FEEDS = ["XLM", "BTC", "ETH", "SOL", "USDC"];

// ── Type helpers ──────────────────────────────────────────────────────────────

type EpochState = {
  epoch_id: number;   // u32
  start_time: bigint; // u64
  end_time: bigint;   // u64
  strike: bigint;     // i128
  option_id: bigint;  // u64
  total_assets: bigint; // i128
  premium: bigint;    // i128
  settled: boolean;
};

// ── Helper: read current epoch, returning null if none exists ─────────────────

async function tryGetEpoch(ctx: ReturnType<typeof getCtx>): Promise<EpochState | null> {
  try {
    return await simulateRead<EpochState>(
      ctx.net,
      ctx.deployer.publicKey(),
      ctx.deployments.structured,
      "get_epoch",
      [],
    );
  } catch {
    return null; // NoActiveEpoch error #9
  }
}

// ── Helper: push fresh prices ─────────────────────────────────────────────────

async function pushPrices(ctx: ReturnType<typeof getCtx>): Promise<void> {
  const payload = await fetchRedStonePayload(ALL_FEEDS);
  await invoke(ctx.net, ctx.deployer, ctx.deployments.oracle, "write_prices", [
    bytesVal(payload),
  ]);
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("structured", () => {
  const ctx = getCtx();
  let user: Keypair;

  // baseEpochId = epoch_id of the active epoch AFTER beforeAll completes.
  // Assertions use baseEpochId + 1 / + 2 to remain valid across repeated runs.
  let baseEpochId: number = 0;

  // start_time of the epoch active at the END of beforeAll (the one the deposit
  // lands in).  Used to compute sleep duration before the first roll in the tests.
  let epochStartTime: bigint = 0n;

  // Whether the deposit was queued (mid-epoch) rather than immediately minted.
  let depositQueued: boolean = false;

  beforeAll(async () => {
    console.log("  ▸ pushing fresh RedStone prices …");
    await pushPrices(ctx);

    console.log("  ▸ setting implied volatility for XLM market (deployer = keeper) …");
    await invoke(ctx.net, ctx.deployer, ctx.deployments.options, "set_implied_volatility", [
      u32Val(MARKET_XLM),
      i128Val(IV_80PCT),
    ]);

    // ── Detect and handle existing epoch state ───────────────────────────────
    const existing = await tryGetEpoch(ctx);

    if (existing !== null) {
      console.log(`  ▸ found existing epoch ${existing.epoch_id} (settled=${existing.settled})`);
      // epoch.settled is ALWAYS false in the contract — mid_epoch is always true
      // once any epoch has been created.  We need to roll through any existing
      // epoch so we start from a known-fresh epoch in this test run.

      const nowSec = BigInt(Math.floor(Date.now() / 1000));

      if (nowSec < existing.end_time) {
        // Epoch not yet expired — wait for it.
        const waitMs = Number(existing.end_time - nowSec) * 1000 + 5_000;
        console.log(`    sleeping ${Math.ceil(waitMs / 1_000)}s for current epoch to expire …`);
        await new Promise((r) => setTimeout(r, waitMs));
      }

      // Roll the expired epoch → starts a fresh one.
      console.log("  ▸ rolling expired epoch to get a fresh baseline …");
      await pushPrices(ctx);
      await invoke(ctx.net, ctx.deployer, ctx.deployments.structured, "roll_epoch", []);

      // Record the newly-rolled epoch as our baseline.
      const fresh = await tryGetEpoch(ctx);
      if (fresh !== null) {
        baseEpochId = fresh.epoch_id;
        epochStartTime = fresh.start_time;
        console.log(`    baseline epoch after roll: epoch_id=${baseEpochId}`);
      }
      depositQueued = true; // mid-epoch — deposit will be queued
    } else {
      // No epoch has ever been created — very first run.
      baseEpochId = 0;
      depositQueued = false; // between-epoch — deposit will be immediate
      console.log("  ▸ no prior epoch detected — first run");
    }

    // ── Spawn user and fund with USDC ────────────────────────────────────────
    console.log("  ▸ spawning user + funding 10 USDC …");
    [user] = await spawnUsers(1, "structured-user");
    await fundWithUsdc(user, 10);
    console.log(`    user: ${user.publicKey()}`);

    // ── Deposit 10 USDC ──────────────────────────────────────────────────────
    // Between epochs (first run): immediate 1:1 share mint.
    // Mid-epoch (all subsequent runs): deposit is queued in Temporary storage.
    await invoke(ctx.net, user, ctx.deployments.structured, "deposit", [
      addrVal(user.publicKey()),
      i128Val(DEPOSIT_NATIVE),
    ]);
  }, 360_000);

  // ── Test 1: verify balance after deposit ──────────────────────────────────

  it("deposit → shares minted immediately (first run) or queued (mid-epoch runs)", async () => {
    const shares = await simulateRead<bigint>(
      ctx.net,
      user.publicKey(),
      ctx.deployments.structured,
      "balance",
      [addrVal(user.publicKey())],
    );
    console.log(`    shares after deposit: ${shares}`);

    if (depositQueued) {
      // Mid-epoch: deposit is queued; shares minted only when process_pending_deposit
      // is called between epochs.  Balance must be 0 until the next roll.
      console.log("    mid-epoch deposit — shares are queued, balance expected to be 0");
      expect(shares).toBe(0n);
    } else {
      // First run — immediate 1:1 mint.
      console.log("    between-epoch deposit — immediate 1:1 mint");
      expect(shares).toBe(DEPOSIT_INTERNAL);
    }
  });

  // ── Test 2: total_assets / total_shares sanity check ─────────────────────

  it("total_assets and total_shares are non-negative and consistent", async () => {
    const ta = await simulateRead<bigint>(
      ctx.net,
      ctx.deployer.publicKey(),
      ctx.deployments.structured,
      "total_assets",
      [],
    );
    const ts = await simulateRead<bigint>(
      ctx.net,
      ctx.deployer.publicKey(),
      ctx.deployments.structured,
      "total_shares",
      [],
    );
    console.log(`    total_assets: ${ta}, total_shares: ${ts}`);
    expect(ta).toBeGreaterThanOrEqual(0n);
    expect(ts).toBeGreaterThanOrEqual(0n);
    // On first run with immediate deposit: expect exactly 10e18 each.
    if (!depositQueued) {
      expect(ta).toBe(DEPOSIT_INTERNAL);
      expect(ts).toBe(DEPOSIT_INTERNAL);
    }
  });

  // ── Test 3: withdraw (only when user holds shares) ────────────────────────

  it("withdraw 2e18 shares if held, or skip if deposit was queued", async () => {
    const shares = await simulateRead<bigint>(
      ctx.net,
      user.publicKey(),
      ctx.deployments.structured,
      "balance",
      [addrVal(user.publicKey())],
    );

    if (shares === 0n) {
      console.log("    user holds 0 shares (queued deposit) — withdraw not applicable, skipping");
      return; // acceptable on repeated runs
    }

    // Between-epoch path (first run): immediate redemption.
    await invoke(ctx.net, user, ctx.deployments.structured, "withdraw", [
      addrVal(user.publicKey()),
      i128Val(WITHDRAW_SHARES),
    ]);

    const remaining = await simulateRead<bigint>(
      ctx.net,
      user.publicKey(),
      ctx.deployments.structured,
      "balance",
      [addrVal(user.publicKey())],
    );
    const expected = DEPOSIT_INTERNAL - WITHDRAW_SHARES; // 8e18
    console.log(`    remaining shares: ${remaining} (expected: ${expected})`);
    expect(remaining).toBe(expected);
  });

  // ── Test 4: first roll_epoch in this test run ─────────────────────────────

  it("roll_epoch → epoch advances to baseEpochId+1, OTM covered-call written", async () => {
    // For first run: no epoch yet, epochStartTime=0 → sleep is skipped.
    // For repeated runs: epochStartTime is the start of the freshly-rolled
    // baseline epoch created in beforeAll.
    const targetTs = epochStartTime > 0n ? Number(epochStartTime) + 130 : 0;
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec < targetTs) {
      const waitMs = (targetTs - nowSec) * 1000;
      console.log(`    sleeping ${Math.ceil(waitMs / 1_000)}s until baseline epoch expires …`);
      await new Promise((r) => setTimeout(r, waitMs));
    }

    console.log("  ▸ pushing fresh prices before roll …");
    await pushPrices(ctx);
    await invoke(ctx.net, ctx.deployer, ctx.deployments.structured, "roll_epoch", []);

    const epoch = await simulateRead<EpochState>(
      ctx.net,
      ctx.deployer.publicKey(),
      ctx.deployments.structured,
      "get_epoch",
      [],
    );

    // Save start_time for the sleep in the second roll test.
    epochStartTime = epoch.start_time;

    console.log(`    epoch_id: ${epoch.epoch_id}`);
    console.log(`    option_id: ${epoch.option_id}`);
    console.log(`    strike: ${epoch.strike}`);
    console.log(`    premium: ${epoch.premium}`);
    console.log(`    start_time: ${epoch.start_time}, end_time: ${epoch.end_time}`);

    expect(epoch.epoch_id).toBe(baseEpochId + 1);
    expect(epoch.option_id).toBeGreaterThan(0n);
    expect(epoch.strike).toBeGreaterThan(0n);
    expect(epoch.settled).toBe(false);
  }, 240_000);

  // ── Test 5: get_epoch state verification ─────────────────────────────────

  it("get_epoch → epoch_id=baseEpochId+1, settled=false, option active", async () => {
    const epoch = await simulateRead<EpochState>(
      ctx.net,
      ctx.deployer.publicKey(),
      ctx.deployments.structured,
      "get_epoch",
      [],
    );
    console.log(`    epoch_id=${epoch.epoch_id}, option_id=${epoch.option_id}, settled=${epoch.settled}`);
    expect(epoch.epoch_id).toBe(baseEpochId + 1);
    expect(epoch.option_id).toBeGreaterThan(0n);
    expect(epoch.settled).toBe(false);
  });

  // ── Test 6: second roll_epoch after expiry → epoch_id = baseEpochId+2 ────

  it("roll_epoch after epoch expiry → epoch_id advances to baseEpochId+2 with new option", async () => {
    // epoch_duration_override = 120s; wait until start_time + 130s.
    const targetTs = Number(epochStartTime) + 130;
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec < targetTs) {
      const waitMs = (targetTs - nowSec) * 1000;
      console.log(`    sleeping ${Math.ceil(waitMs / 1_000)}s until epoch expires …`);
      await new Promise((r) => setTimeout(r, waitMs));
    }

    console.log("  ▸ pushing fresh prices for second roll …");
    await pushPrices(ctx);
    await invoke(ctx.net, ctx.deployer, ctx.deployments.structured, "roll_epoch", []);

    const epoch = await simulateRead<EpochState>(
      ctx.net,
      ctx.deployer.publicKey(),
      ctx.deployments.structured,
      "get_epoch",
      [],
    );
    console.log(`    new epoch_id: ${epoch.epoch_id}, option_id: ${epoch.option_id}`);
    console.log(`    premium: ${epoch.premium}, strike: ${epoch.strike}`);
    expect(epoch.epoch_id).toBe(baseEpochId + 2);
    expect(epoch.option_id).toBeGreaterThan(0n);
    expect(epoch.settled).toBe(false);
  }, 240_000);
});
