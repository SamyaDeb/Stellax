// ── Fix: Re-initialize locked_margin_total for the structured vault ───────────
//
// Problem: The vault's `locked_margin_total[structured_vault]` storage entry
// has expired (Soroban Persistent storage TTL). As a result, calls to
// `get_total_collateral_value`, `get_free_collateral_value`, and `lock_margin`
// all fail with Error(Contract, #12) when the vault tries to read the missing
// locked_margin_total.
//
// Fix: The deployer is registered as an authorized vault caller. We call
// lock_margin(deployer, structured_vault, dummy_id, 1) and then
// unlock_margin(deployer, structured_vault, dummy_id, 1) to re-create the
// locked_margin_total entry with value 0.
//
// After this, roll_epoch should succeed because the vault can read the
// locked_margin_total for the structured vault (returns 0 free to lock).
//
// Run with:
//   pnpm --filter @stellax/e2e exec tsx src/admin/fix-structured-margin.ts

import { loadDeployerKeypair } from "../lib/accounts.js";
import { loadDeployments } from "../lib/deployments.js";
import { invoke } from "../lib/invoke.js";
import { addrVal, i128Val, u64Val } from "../lib/scval.js";

const DUMMY_POSITION_ID = 999999n; // won't conflict with real option IDs

async function main() {
  const d = loadDeployments();
  const net = { rpcUrl: d.rpc_url, passphrase: d.network_passphrase };
  const deployer = loadDeployerKeypair();

  console.log(`▸ vault      : ${d.vault}`);
  console.log(`▸ structured : ${d.structured}`);
  console.log(`▸ deployer   : ${deployer.publicKey()}`);
  console.log(`▸ dummy pos  : ${DUMMY_POSITION_ID}`);

  // Step 1: lock 1 unit of margin (creates the locked_margin_total entry)
  console.log("\n▸ calling vault.lock_margin(deployer, structured_vault, 999999, 1) …");
  await invoke(net, deployer, d.vault, "lock_margin", [
    addrVal(deployer.publicKey()),    // caller (deployer = authorized)
    addrVal(d.structured),            // user (structured vault)
    u64Val(DUMMY_POSITION_ID),        // position_id (dummy)
    i128Val(1n),                      // amount = 1 (smallest unit)
  ]);
  console.log("  ✓ lock_margin succeeded");

  // Step 2: unlock 1 unit (sets locked_margin_total to 0, entry persists with value 0)
  console.log("▸ calling vault.unlock_margin(deployer, structured_vault, 999999, 1) …");
  await invoke(net, deployer, d.vault, "unlock_margin", [
    addrVal(deployer.publicKey()),    // caller
    addrVal(d.structured),            // user
    u64Val(DUMMY_POSITION_ID),        // same dummy position_id
    i128Val(1n),                      // amount = 1
  ]);
  console.log("  ✓ unlock_margin succeeded");

  console.log("\n✓ locked_margin_total for structured vault has been re-initialized to 0.");
  console.log("  Re-run the structured e2e tests: pnpm --filter @stellax/e2e test:structured");
}

main().catch((err) => {
  console.error("✗ fix-structured-margin failed:", err.message ?? err);
  process.exit(1);
});
