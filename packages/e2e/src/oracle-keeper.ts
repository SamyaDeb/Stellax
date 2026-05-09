#!/usr/bin/env tsx
/**
 * oracle-keeper.ts
 *
 * Continuously pushes fresh RedStone prices (XLM, BTC, ETH, SOL) to the
 * StellaX oracle contract on Stellar testnet.
 *
 * The on-chain oracle accepts prices for 24 h; this keeper refreshes every
 * ORACLE_INTERVAL_MS (default: 5 minutes) so the frontend always sees live
 * prices.
 *
 * Usage (from repo root):
 *   npm run oracle:keeper
 *   # or directly:
 *   cd packages/e2e && npx tsx src/oracle-keeper.ts
 *
 * Environment variables (all optional):
 *   ORACLE_INTERVAL_MS   Push interval in ms (default: 300_000 = 5 min)
 *   ORACLE_FEEDS         Comma-separated feed list (default: XLM,BTC,ETH,SOL)
 *   ORACLE_SIGNERS       Minimum unique RedStone signers required (default: 3)
 */

import { getCtx } from "./lib/fixtures.js";
import { invoke } from "./lib/invoke.js";
import { fetchRedStonePayload } from "./lib/redstone.js";
import { bytesVal } from "./lib/scval.js";

// ── Config ────────────────────────────────────────────────────────────────────

const INTERVAL_MS = Number(process.env.ORACLE_INTERVAL_MS ?? 5 * 60 * 1000);
const FEEDS = (process.env.ORACLE_FEEDS ?? "XLM,BTC,ETH,SOL").split(",").map((s) => s.trim());
const UNIQUE_SIGNERS = Number(process.env.ORACLE_SIGNERS ?? 3);

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

// ── Push once ─────────────────────────────────────────────────────────────────

async function pushOnce(): Promise<void> {
  const { net, deployments, deployer } = getCtx();
  const t0 = Date.now();

  process.stdout.write(
    `[${timestamp()}] Fetching RedStone payload for ${FEEDS.join(",")}… `,
  );

  const payload = await fetchRedStonePayload(FEEDS, UNIQUE_SIGNERS);
  process.stdout.write(`${payload.length} bytes. Pushing on-chain… `);

  await invoke(net, deployer, deployments.oracle, "write_prices", [
    bytesVal(payload),
  ]);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`done (${elapsed}s)`);
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { deployments, deployer } = getCtx();

  console.log("StellaX oracle keeper starting…");
  console.log(`  feeds    : ${FEEDS.join(", ")}`);
  console.log(`  interval : ${(INTERVAL_MS / 60_000).toFixed(1)} min`);
  console.log(`  oracle   : ${deployments.oracle}`);
  console.log(`  deployer : ${deployer.publicKey()}`);
  console.log("");

  let consecutiveErrors = 0;

  async function tick(): Promise<void> {
    try {
      await pushOnce();
      consecutiveErrors = 0;
    } catch (err: unknown) {
      consecutiveErrors++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[${timestamp()}] ERROR (${consecutiveErrors} consecutive): ${msg}`,
      );
      if (consecutiveErrors >= 10) {
        console.error("10 consecutive errors — exiting.");
        process.exit(1);
      }
    }
  }

  // Push immediately on start, then on each interval tick.
  await tick();
  setInterval(() => { void tick(); }, INTERVAL_MS);
  console.log(
    `\nKeeper running. Next push in ${(INTERVAL_MS / 60_000).toFixed(1)} min. Press Ctrl+C to stop.\n`,
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("Fatal:", msg);
  process.exit(1);
});
