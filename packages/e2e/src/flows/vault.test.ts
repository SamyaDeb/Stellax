// ── Vault e2e: deposit / withdraw / lock / unlock ─────────────────────────────
//
// Before running:
//  1. Updates oracle config: adds USDC to feed_ids, raises staleness to 24 h
//  2. Pushes fresh RedStone prices (XLM, BTC, ETH, SOL, USDC)
//  3. Funds a fresh user with 10 USDC via classic Stellar DEX
//
// Key constants (deployer is authorized_caller set during deployment):
//  • USDC on Stellar testnet: decimals = 7, so 10 USDC = 100_000_000
//  • Internal vault precision: 18 decimals, so 10 USDC = 10_000_000_000_000_000_000
//
// Tests are serial and stateful: each one relies on the vault state left by the
// previous test (deposit → withdraw → lock → unlock).

import { beforeAll, describe, expect, it } from "vitest";

import { loadDeployerKeypair } from "../lib/accounts.js";
import { getCtx, spawnUsers } from "../lib/fixtures.js";
import { invoke, simulateRead } from "../lib/invoke.js";
import { fetchRedStonePayload, PRIMARY_PROD_SIGNERS_EVM } from "../lib/redstone.js";
import {
  addrVal,
  bytesVal,
  i128Val,
  symbolVal,
  u32Val,
  u64Val,
  vecVal,
} from "../lib/scval.js";
import { fundWithUsdc } from "../lib/stellar-classic.js";
import type { Keypair } from "@stellar/stellar-sdk";

// ── Constants ─────────────────────────────────────────────────────────────────

/** 10 USDC in native 7-decimal (Stellar classic) */
const DEPOSIT_NATIVE = 100_000_000n;
/** 10 USDC in 18-decimal internal vault representation */
const DEPOSIT_INTERNAL = 10_000_000_000_000_000_000n;

/** 5 USDC native / internal */
const WITHDRAW_NATIVE = 50_000_000n;
const WITHDRAW_INTERNAL = 5_000_000_000_000_000_000n;

/** 3 USDC to lock (18-decimal) */
const LOCK_AMOUNT = 3_000_000_000_000_000_000n;

/** Staleness window for vault tests: 24 hours in ms */
const STALENESS_MS_24H = BigInt(24 * 60 * 60 * 1000);

const ALL_FEEDS = ["XLM", "BTC", "ETH", "SOL", "USDC"];

function hexToBytes(hex: string): Buffer {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Buffer.from(clean, "hex");
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("vault", () => {
  const ctx = getCtx();
  let user: Keypair;

  beforeAll(async () => {
    // ── 1. Update oracle: add USDC to feed_ids, raise staleness to 24 h ──────
    //
    // The oracle was deployed with feed_ids=[XLM,BTC,ETH,SOL] and
    // max_staleness=60s. The vault calls oracle.get_price("USDC") for
    // collateral valuation, so we must add USDC now.  We also raise the
    // staleness window so vault tests don't expire during the run.
    console.log("  ▸ updating oracle config (add USDC, staleness=24h) …");
    await invoke(ctx.net, ctx.deployer, ctx.deployments.oracle, "update_config", [
      vecVal(PRIMARY_PROD_SIGNERS_EVM.map((s) => bytesVal(hexToBytes(s)))),
      u32Val(3),
      u64Val(STALENESS_MS_24H),
      vecVal(ALL_FEEDS.map(symbolVal)),
    ]);

    // ── 2. Push fresh prices for all 5 feeds ─────────────────────────────────
    console.log("  ▸ fetching & pushing RedStone prices (XLM,BTC,ETH,SOL,USDC) …");
    const payload = await fetchRedStonePayload(ALL_FEEDS);
    try {
      await invoke(
        ctx.net,
        ctx.deployer,
        ctx.deployments.oracle,
        "write_prices",
        [bytesVal(payload)],
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("#11")) throw err;
      console.warn("    RedStone payload was not newer than stored oracle prices; using existing fresh prices.");
      for (const feed of ALL_FEEDS) {
        await simulateRead(ctx.net, ctx.deployer.publicKey(), ctx.deployments.oracle, "get_price", [symbolVal(feed)]);
      }
    }
    console.log(`    payload size: ${payload.length} bytes`);

    // ── 3. Spawn + fund the test user ─────────────────────────────────────────
    [user] = await spawnUsers(1, "vault-user");
    await fundWithUsdc(user, 10); // acquires 10 USDC via DEX
  }, 180_000);

  // ── Test 1: deposit ──────────────────────────────────────────────────────────

  it("deposit 10 USDC → balance = 10 × 10^18 internal", async () => {
    await invoke(ctx.net, user, ctx.deployments.vault, "deposit", [
      addrVal(user.publicKey()),
      addrVal(ctx.deployments.usdc),
      i128Val(DEPOSIT_NATIVE),
    ]);

    const balance = await simulateRead<bigint>(
      ctx.net,
      user.publicKey(),
      ctx.deployments.vault,
      "get_balance",
      [addrVal(user.publicKey()), addrVal(ctx.deployments.usdc)],
    );

    console.log(`    vault balance: ${balance} (expect ${DEPOSIT_INTERNAL})`);
    expect(balance).toBe(DEPOSIT_INTERNAL);
  });

  // ── Test 2: collateral value ─────────────────────────────────────────────────

  it("get_total_collateral_value ≈ $10 (USDC haircut=0)", async () => {
    const value = await simulateRead<bigint>(
      ctx.net,
      user.publicKey(),
      ctx.deployments.vault,
      "get_total_collateral_value",
      [addrVal(user.publicKey())],
    );

    // USDC price from RedStone is ~$1.00 = 1e18. Value = 10 * 1e18 = 1e19.
    // Allow ±2% band for stablecoin de-peg.
    console.log(`    total collateral value: ${value}`);
    expect(value).toBeGreaterThanOrEqual(9_800_000_000_000_000_000n);
    expect(value).toBeLessThanOrEqual(10_200_000_000_000_000_000n);
  });

  // ── Test 3: withdraw ─────────────────────────────────────────────────────────

  it("withdraw 5 USDC → balance drops to 5 × 10^18", async () => {
    await invoke(ctx.net, user, ctx.deployments.vault, "withdraw", [
      addrVal(user.publicKey()),
      addrVal(ctx.deployments.usdc),
      i128Val(WITHDRAW_NATIVE),
    ]);

    const balance = await simulateRead<bigint>(
      ctx.net,
      user.publicKey(),
      ctx.deployments.vault,
      "get_balance",
      [addrVal(user.publicKey()), addrVal(ctx.deployments.usdc)],
    );

    const expected = DEPOSIT_INTERNAL - WITHDRAW_INTERNAL;
    console.log(`    vault balance after withdraw: ${balance} (expect ${expected})`);
    expect(balance).toBe(expected);
  });

  // ── Test 4: lock_margin ──────────────────────────────────────────────────────

  it("deployer (authorized_caller) locks 3 USDC margin for user", async () => {
    // Remaining balance: 5 USDC = 5e18. We lock 3e18.
    await invoke(
      ctx.net,
      ctx.deployer,
      ctx.deployments.vault,
      "lock_margin",
      [
        addrVal(ctx.deployer.publicKey()), // caller = deployer (in authorized_callers)
        addrVal(user.publicKey()),          // user
        u64Val(1n),                         // position_id
        i128Val(LOCK_AMOUNT),              // 3 USDC in 18-dec
      ],
    );

    // lock_margin internally tracks LockedMarginTotal. Verify over-lock is rejected:
    // remaining free = 5 USDC - 3 USDC already locked = 2 USDC.
    // Attempting to lock another 3 USDC (> 2 USDC free) must error with MarginLockExceeded.
    let overLockFailed = false;
    try {
      await invoke(
        ctx.net,
        ctx.deployer,
        ctx.deployments.vault,
        "lock_margin",
        [
          addrVal(ctx.deployer.publicKey()),
          addrVal(user.publicKey()),
          u64Val(2n),
          i128Val(LOCK_AMOUNT), // another 3 USDC, exceeds free 2 USDC
        ],
      );
    } catch {
      overLockFailed = true;
    }

    console.log(`    over-lock rejected: ${overLockFailed}`);
    expect(overLockFailed).toBe(true);
  });

  // ── Test 5: unlock_margin ────────────────────────────────────────────────────

  it("deployer unlocks margin → free collateral restored to ≈ 5 USDC", async () => {
    await invoke(
      ctx.net,
      ctx.deployer,
      ctx.deployments.vault,
      "unlock_margin",
      [
        addrVal(ctx.deployer.publicKey()),
        addrVal(user.publicKey()),
        u64Val(1n),
        i128Val(LOCK_AMOUNT),
      ],
    );

    const free = await simulateRead<bigint>(
      ctx.net,
      user.publicKey(),
      ctx.deployments.vault,
      "get_free_collateral_value",
      [addrVal(user.publicKey())],
    );

    console.log(`    free collateral after unlock: ${free}`);
    // ~5 USDC free after unlock (with 0 margin requirement from risk)
    expect(free).toBeGreaterThanOrEqual(4_800_000_000_000_000_000n);
  });
});
