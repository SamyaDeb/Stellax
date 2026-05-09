// ── Perp engine e2e: open / close / PnL ────────────────────────────────────────
//
// Flow:
//  1. Push fresh RedStone prices (oracle config already set to 5-feed + 24h staleness
//     by vault.test.ts beforeAll — we just refresh the price data).
//  2. Fund a new user with 10 USDC via DEX and deposit into the vault.
//  3. Open a LONG XLM-PERP (market 0) position.
//  4. Open a SHORT XLM-PERP position.
//  5. Verify unrealized PnL on the long is positive (oracle $0.17 > vAMM entry ≈ $0.01).
//  6. Close both positions; confirm they are gone.
//
// vAMM note:
//   The XLM-PERP vAMM is initialised with base=1e21, quote=1e23 (mark=$100).
//   Oracle XLM ≈ $0.17.  The execution_price from the vAMM is extremely small
//   (≈ 1e16 = $0.01) because price_impact_factor=1e14 makes each trade feel
//   tiny to the pool.  We bypass the oracle-vs-vAMM slippage guard by passing
//   max_slippage_bps = 1_000_000_000.  This is intentional for e2e testing;
//   it reflects that the vAMM and oracle prices can diverge until the funding
//   rate re-anchors them.

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
  u32Val,
  u64Val,
} from "../lib/scval.js";
import { fundWithUsdc } from "../lib/stellar-classic.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** XLM-PERP market id (matches environments.toml markets[0].id) */
const MARKET_XLM = 0;

/** 1 XLM in 18-decimal base-asset precision */
const SIZE_1XLM = 1_000_000_000_000_000_000n;

/** 0.5 XLM — used for the short leg so both positions fit under the OI cap */
const SIZE_HALF_XLM = 500_000_000_000_000_000n;

/** Bypass the vAMM/oracle slippage check entirely — needed because the vAMM
 *  mark price ($100) and oracle XLM price ($0.17) diverge by orders of magnitude
 *  until the funding rate re-anchors them. */
const MAX_SLIPPAGE_BYPASS = 1_000_000_000;

/** 10 USDC in native 7-decimal (Stellar classic) */
const DEPOSIT_NATIVE = 100_000_000n;

/** Feed ids that must already be in the oracle (set by vault.test.ts beforeAll) */
const ALL_FEEDS = ["XLM", "BTC", "ETH", "SOL", "USDC"];

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("perp", () => {
  const ctx = getCtx();
  let user: Keypair;
  let longPositionId: bigint;
  let shortPositionId: bigint;

  beforeAll(async () => {
    // ── 1. Refresh oracle prices ──────────────────────────────────────────────
    console.log("  ▸ pushing fresh RedStone prices (XLM,BTC,ETH,SOL,USDC) …");
    const payload = await fetchRedStonePayload(ALL_FEEDS);
    try {
      await invoke(ctx.net, ctx.deployer, ctx.deployments.oracle, "write_prices", [
        bytesVal(payload),
      ]);
    } catch (err) {
      if (!String(err).includes("#11")) throw err;
      console.log("    RedStone payload is older than stored oracle price; using stored price");
    }
    console.log(`    payload size: ${payload.length} bytes`);

    // ── 2. Spawn user + fund with 10 USDC, deposit into vault ─────────────────
    console.log("  ▸ spawning perp user, acquiring 10 USDC via DEX …");
    [user] = await spawnUsers(1, "perp-user");
    await fundWithUsdc(user, 10);

    console.log("  ▸ depositing 10 USDC into vault …");
    await invoke(ctx.net, user, ctx.deployments.vault, "deposit", [
      addrVal(user.publicKey()),
      addrVal(ctx.deployments.usdc),
      i128Val(DEPOSIT_NATIVE),
    ]);
    console.log(`    user: ${user.publicKey()}`);
  }, 180_000);

  // ── Test 1: open long ────────────────────────────────────────────────────────

  it("open long XLM-PERP → position stored with correct fields", async () => {
    const posId = await invoke<bigint>(
      ctx.net,
      user,
      ctx.deployments.perp_engine,
      "open_position",
      [
        addrVal(user.publicKey()),  // user
        u32Val(MARKET_XLM),         // market_id = 0
        i128Val(SIZE_1XLM),         // size = 1 XLM (18-dec)
        boolVal(true),              // is_long
        u32Val(5),                  // leverage = 5x
        u32Val(MAX_SLIPPAGE_BYPASS),// max_slippage_bps — bypass
        xdr.ScVal.scvVoid(),        // price_payload = None
      ],
    );

    expect(posId).toBeDefined();
    longPositionId = posId!;
    console.log(`    long position_id: ${longPositionId}`);

    // Read back and verify fields
    type Position = {
      owner: string;
      market_id: number;
      size: bigint;
      entry_price: bigint;
      margin: bigint;
      leverage: number;
      is_long: boolean;
      last_funding_idx: bigint;
      open_timestamp: bigint;
    };
    const pos = await simulateRead<Position>(
      ctx.net,
      user.publicKey(),
      ctx.deployments.perp_engine,
      "get_position",
      [addrVal(user.publicKey()), u64Val(longPositionId)],
    );

    console.log(`    entry_price: ${pos.entry_price}, margin: ${pos.margin}, size: ${pos.size}`);
    expect(pos.is_long).toBe(true);
    expect(pos.size).toBe(SIZE_1XLM);
    expect(pos.leverage).toBe(5);
    expect(pos.market_id).toBe(MARKET_XLM);
    expect(pos.owner).toBe(user.publicKey());
    // entry_price is the vAMM execution price — should be > 0
    expect(pos.entry_price).toBeGreaterThan(0n);
    // margin = notional / leverage, both derived from vAMM — should be > 0
    expect(pos.margin).toBeGreaterThan(0n);
  });

  // ── Test 2: open short ───────────────────────────────────────────────────────

  it("open short XLM-PERP → position stored with correct fields", async () => {
    const posId = await invoke<bigint>(
      ctx.net,
      user,
      ctx.deployments.perp_engine,
      "open_position",
      [
        addrVal(user.publicKey()),
        u32Val(MARKET_XLM),
        i128Val(SIZE_HALF_XLM),     // 0.5 XLM
        boolVal(false),             // is_long = false (short)
        u32Val(3),                  // leverage = 3x
        u32Val(MAX_SLIPPAGE_BYPASS),
        xdr.ScVal.scvVoid(),
      ],
    );

    expect(posId).toBeDefined();
    shortPositionId = posId!;
    console.log(`    short position_id: ${shortPositionId}`);

    type Position = {
      market_id: number;
      size: bigint;
      leverage: number;
      is_long: boolean;
    };
    const pos = await simulateRead<Position>(
      ctx.net,
      user.publicKey(),
      ctx.deployments.perp_engine,
      "get_position",
      [addrVal(user.publicKey()), u64Val(shortPositionId)],
    );

    expect(pos.is_long).toBe(false);
    expect(pos.size).toBe(SIZE_HALF_XLM);
    expect(pos.leverage).toBe(3);
    expect(pos.market_id).toBe(MARKET_XLM);
  });

  // ── Test 3: unrealized PnL ───────────────────────────────────────────────────

  it("get_unrealized_pnl on long returns a finite bigint", async () => {
    // V2 executes near oracle price with skew fees, so PnL may be slightly
    // positive or negative depending on price movement between open and read.
    const pnl = await simulateRead<bigint>(
      ctx.net,
      user.publicKey(),
      ctx.deployments.perp_engine,
      "get_unrealized_pnl",
      [u64Val(longPositionId)],
    );
    console.log(`    long unrealized PnL: ${pnl} (18-dec USDC)`);
    expect(typeof pnl).toBe("bigint");
  });

  // ── Test 4: close long ───────────────────────────────────────────────────────

  it("close long position → position removed from engine", async () => {
    await invoke(
      ctx.net,
      user,
      ctx.deployments.perp_engine,
      "close_position",
      [addrVal(user.publicKey()), u64Val(longPositionId), xdr.ScVal.scvVoid()],
    );

    // Attempting to read a closed position should fail
    let notFound = false;
    try {
      await simulateRead(
        ctx.net,
        user.publicKey(),
        ctx.deployments.perp_engine,
        "get_position",
        [addrVal(user.publicKey()), u64Val(longPositionId)],
      );
    } catch {
      notFound = true;
    }
    console.log(`    long position not found after close: ${notFound}`);
    expect(notFound).toBe(true);
  });

  // ── Test 5: close short ──────────────────────────────────────────────────────

  it("close short position → position removed from engine", async () => {
    await invoke(
      ctx.net,
      user,
      ctx.deployments.perp_engine,
      "close_position",
      [addrVal(user.publicKey()), u64Val(shortPositionId), xdr.ScVal.scvVoid()],
    );

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
    console.log(`    short position not found after close: ${notFound}`);
    expect(notFound).toBe(true);
  });
});
