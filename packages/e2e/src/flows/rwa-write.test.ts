// ── Phase Ω6 / M mutating smoke — RWA collateral + perp flow ────────────────
//
// This suite mutates shared testnet state, so it is opt-in:
//   STELLAX_RUN_MUTATING_E2E=true pnpm -F @stellax/e2e exec vitest run src/flows/rwa-write.test.ts
//
// Flow:
//  1. Refresh BENJI oracle timestamp with the current on-chain BENJI price.
//  2. Mint mock BENJI to a disposable funded user.
//  3. Deposit BENJI into the vault and verify collateral accounting.
//  4. Credit one token of RWA yield and verify cumulative-yield accounting.
//  5. Open and close a tiny BENJI-PERP position.
//  6. Withdraw part of the BENJI collateral.

import { beforeAll, describe, expect, it } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
import type { Keypair } from "@stellar/stellar-sdk";

import { getCtx, spawnUsers } from "../lib/fixtures.js";
import { invoke, simulateRead } from "../lib/invoke.js";
import { PRIMARY_PROD_SIGNERS_EVM } from "../lib/redstone.js";
import { fundWithUsdc } from "../lib/stellar-classic.js";
import { addrVal, boolVal, bytesVal, i128Val, symbolVal, u32Val, u64Val, vecVal } from "../lib/scval.js";

interface PriceData {
  price: bigint;
  package_timestamp: bigint;
  write_timestamp: bigint;
}

interface Position {
  owner: string;
  market_id: number;
  size: bigint;
  margin: bigint;
  leverage: number;
  is_long: boolean;
}

const RUN_MUTATING = process.env.STELLAX_RUN_MUTATING_E2E === "true";
const describeIfMutating = RUN_MUTATING ? describe : describe.skip;

const FEED = "BENJI";
const MARKET_ID = 100;
const MINT_NATIVE = 50_000_000n; // 50 BENJI at 6 decimals.
const WITHDRAW_NATIVE = 10_000_000n; // 10 BENJI at 6 decimals.
const YIELD_NATIVE = 1_000_000n; // 1 BENJI at 6 decimals.
const FEE_USDC_NATIVE = 1_000_000n; // 0.1 USDC at 7 decimals for trading fees.
const DEPOSIT_INTERNAL = 50_000_000_000_000_000_000n; // 50 * 1e18.
const WITHDRAW_INTERNAL = 10_000_000_000_000_000_000n; // 10 * 1e18.
const POSITION_SIZE = 1_000_000_000_000_000_000n; // 1 BENJI in 18-dec base precision.
const MAX_SLIPPAGE_BYPASS = 1_000_000_000;
const STALENESS_MS_24H = BigInt(24 * 60 * 60 * 1000);
const ALL_FEEDS = ["XLM", "BTC", "ETH", "SOL", "USDC", "BENJI", "USDY", "OUSG"];
const BENJI_SEED_PRICE = 1_000_000_000_000_000_000n;

function hexToBytes(hex: string): Buffer {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Buffer.from(clean, "hex");
}

async function getOrSeedBenjiPrice(ctx: ReturnType<typeof getCtx>): Promise<PriceData> {
  try {
    return await simulateRead<PriceData>(
      ctx.net,
      ctx.deployer.publicKey(),
      ctx.deployments.oracle,
      "get_price",
      [symbolVal(FEED)],
    );
  } catch (err) {
    console.warn(`  ▸ BENJI oracle price missing/stale; seeding testnet NAV (${(err as Error).message})`);
    await invoke(ctx.net, ctx.deployer, ctx.deployments.oracle, "update_config", [
      vecVal(PRIMARY_PROD_SIGNERS_EVM.map((s) => bytesVal(hexToBytes(s)))),
      u32Val(3),
      u64Val(STALENESS_MS_24H),
      vecVal(ALL_FEEDS.map(symbolVal)),
    ]);
    await invoke(ctx.net, ctx.deployer, ctx.deployments.oracle, "admin_push_price", [
      symbolVal(FEED),
      i128Val(BENJI_SEED_PRICE),
      u64Val(BigInt(Date.now())),
    ]);
    return await simulateRead<PriceData>(
      ctx.net,
      ctx.deployer.publicKey(),
      ctx.deployments.oracle,
      "get_price",
      [symbolVal(FEED)],
    );
  }
}

describeIfMutating("rwa write flow (collateral + perp)", () => {
  const ctx = getCtx();
  const rwa = ctx.deployments.mock_rwa?.benji;
  let user: Keypair;
  let priceBefore: PriceData;
  let positionId: bigint;

  beforeAll(async () => {
    if (!rwa?.contract_id) throw new Error("deployments/testnet.json missing mock_rwa.benji.contract_id");

    [user] = await spawnUsers(1, "rwa-write-user");

    priceBefore = await getOrSeedBenjiPrice(ctx);

    const nowMs = BigInt(Date.now());
    if (nowMs - priceBefore.package_timestamp > STALENESS_MS_24H / 2n) {
      await invoke(ctx.net, ctx.deployer, ctx.deployments.oracle, "admin_push_price", [
        symbolVal(FEED),
        i128Val(priceBefore.price),
        u64Val(nowMs),
      ]);
    }

    await fundWithUsdc(user, 1);
    await invoke(ctx.net, user, ctx.deployments.vault, "deposit", [
      addrVal(user.publicKey()),
      addrVal(ctx.deployments.usdc),
      i128Val(FEE_USDC_NATIVE),
    ]);

    await invoke(ctx.net, ctx.deployer, rwa.contract_id, "mint", [
      addrVal(user.publicKey()),
      i128Val(MINT_NATIVE),
    ]);
  }, 300_000);

  it("mints BENJI to a disposable user", async () => {
    const balance = await simulateRead<bigint>(
      ctx.net,
      user.publicKey(),
      rwa!.contract_id,
      "balance",
      [addrVal(user.publicKey())],
    );

    expect(balance).toBeGreaterThanOrEqual(MINT_NATIVE);
  });

  it("deposits BENJI into the vault and values it as collateral", async () => {
    await invoke(ctx.net, user, ctx.deployments.vault, "deposit", [
      addrVal(user.publicKey()),
      addrVal(rwa!.contract_id),
      i128Val(MINT_NATIVE),
    ]);

    const vaultBalance = await simulateRead<bigint>(
      ctx.net,
      user.publicKey(),
      ctx.deployments.vault,
      "get_balance",
      [addrVal(user.publicKey()), addrVal(rwa!.contract_id)],
    );
    expect(vaultBalance).toBe(DEPOSIT_INTERNAL);

    const collateralValue = await simulateRead<bigint>(
      ctx.net,
      user.publicKey(),
      ctx.deployments.vault,
      "get_total_collateral_value",
      [addrVal(user.publicKey())],
    );
    expect(collateralValue).toBeGreaterThan(0n);
  }, 240_000);

  it("credits BENJI yield and updates cumulative-yield accounting", async () => {
    const before = await simulateRead<bigint>(
      ctx.net,
      user.publicKey(),
      rwa!.contract_id,
      "cumulative_yield",
      [addrVal(user.publicKey())],
    );

    await invoke(ctx.net, ctx.deployer, rwa!.contract_id, "credit_yield", [
      vecVal([addrVal(user.publicKey())]),
      vecVal([i128Val(YIELD_NATIVE)]),
      u64Val(BigInt(Date.now())),
    ]);

    const after = await simulateRead<bigint>(
      ctx.net,
      user.publicKey(),
      rwa!.contract_id,
      "cumulative_yield",
      [addrVal(user.publicKey())],
    );
    expect(after - before).toBe(YIELD_NATIVE);
  }, 180_000);

  it("opens and closes a tiny BENJI-PERP position", async () => {
    const posId = await invoke<bigint>(ctx.net, user, ctx.deployments.perp_engine, "open_position", [
      addrVal(user.publicKey()),
      u32Val(MARKET_ID),
      i128Val(POSITION_SIZE),
      boolVal(true),
      u32Val(2),
      u32Val(MAX_SLIPPAGE_BYPASS),
      xdr.ScVal.scvVoid(),
    ]);

    expect(posId).toBeDefined();
    positionId = posId!;

    const pos = await simulateRead<Position>(
      ctx.net,
      user.publicKey(),
      ctx.deployments.perp_engine,
      "get_position",
      [addrVal(user.publicKey()), u64Val(positionId)],
    );
    expect(pos.owner).toBe(user.publicKey());
    expect(pos.market_id).toBe(MARKET_ID);
    expect(pos.size).toBe(POSITION_SIZE);
    expect(pos.is_long).toBe(true);
    expect(pos.leverage).toBe(2);
    expect(pos.margin).toBeGreaterThan(0n);

    await invoke(ctx.net, user, ctx.deployments.perp_engine, "close_position", [
      addrVal(user.publicKey()),
      u64Val(positionId),
      xdr.ScVal.scvVoid(),
    ]);

    let notFound = false;
    try {
      await simulateRead(
        ctx.net,
        user.publicKey(),
        ctx.deployments.perp_engine,
        "get_position",
        [addrVal(user.publicKey()), u64Val(positionId)],
      );
    } catch {
      notFound = true;
    }
    expect(notFound).toBe(true);
  }, 240_000);

  it("withdraws part of the BENJI collateral", async () => {
    await invoke(ctx.net, user, ctx.deployments.vault, "withdraw", [
      addrVal(user.publicKey()),
      addrVal(rwa!.contract_id),
      i128Val(WITHDRAW_NATIVE),
    ]);

    const vaultBalance = await simulateRead<bigint>(
      ctx.net,
      user.publicKey(),
      ctx.deployments.vault,
      "get_balance",
      [addrVal(user.publicKey()), addrVal(rwa!.contract_id)],
    );
    expect(vaultBalance).toBe(DEPOSIT_INTERNAL - WITHDRAW_INTERNAL);
  }, 180_000);
});
