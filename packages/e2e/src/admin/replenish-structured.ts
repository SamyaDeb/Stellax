// ── One-shot admin script: replenish the structured vault's collateral ────────
//
// The structured vault (CCM5AQAZ…) writes covered-call options each epoch.
// Writing an option locks margin in the main vault under the structured vault's
// address.  After many test runs where options expire ITM, the structured vault
// loses collateral and roll_epoch starts failing with Error(Contract, #12)
// (insufficient free collateral).
//
// This script deposits a large amount of USDC into the structured vault using
// a freshly-funded keypair, restoring the structured vault's free collateral so
// that roll_epoch can write new options again.
//
// Run once when structured tests start failing:
//   pnpm --filter @stellax/e2e exec tsx src/admin/replenish-structured.ts

import { newFundedKeypair } from "../lib/accounts.js";
import { loadDeployments } from "../lib/deployments.js";
import { invoke } from "../lib/invoke.js";
import { addrVal, i128Val } from "../lib/scval.js";
import { fundWithUsdc } from "../lib/stellar-classic.js";

// 200 USDC in 7-decimal  (200 × 10_000_000)
const DEPOSIT_AMOUNT = 2_000_000_000n;
const DEPOSIT_USDC = 200;

async function main() {
  const d = loadDeployments();
  const net = { rpcUrl: d.rpc_url, passphrase: d.network_passphrase };

  console.log(`▸ structured vault : ${d.structured}`);
  console.log(`▸ deposit amount   : ${DEPOSIT_USDC} USDC (${DEPOSIT_AMOUNT} in 7-dec)`);

  // ── Spawn a fresh keypair and fund it with XLM + USDC ──────────────────────
  console.log("\n▸ spawning fresh keypair via friendbot …");
  const user = await newFundedKeypair("replenish-user");
  console.log(`  address: ${user.publicKey()}`);

  console.log(`\n▸ acquiring ${DEPOSIT_USDC} USDC …`);
  await fundWithUsdc(user, DEPOSIT_USDC);

  // ── Deposit USDC into the structured vault ─────────────────────────────────
  // structured.deposit(user: Address, amount: i128) → void
  // The structured vault receives USDC from the user and deposits it into the
  // main vault under the structured vault's own address, increasing free
  // collateral available for option margin locking.
  console.log("\n▸ calling structured.deposit …");
  await invoke(net, user, d.structured, "deposit", [
    addrVal(user.publicKey()),
    i128Val(DEPOSIT_AMOUNT),
  ]);

  console.log(`\n✓ deposited ${DEPOSIT_USDC} USDC into structured vault`);
  console.log("  The structured vault's free collateral in the main vault has been replenished.");
  console.log("  Re-run the structured e2e tests: pnpm --filter @stellax/e2e test:structured");
}

main().catch((err) => {
  console.error("✗ replenish-structured failed:", err);
  process.exit(1);
});
