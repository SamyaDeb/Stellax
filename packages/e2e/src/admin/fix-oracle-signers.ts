// ── One-shot admin script: rewrite oracle signers + threshold ────────────────
//
// Phase 14 deploy seeded the oracle with a single (wrong) RedStone signer.
// Real redstone-primary-prod packages are signed by 5 nodes; this script calls
// update_config to register all 5 and set threshold=3 (production-grade).
//
// Run once per network:
//   pnpm --filter @stellax/e2e exec tsx src/admin/fix-oracle-signers.ts

import { loadDeployerKeypair } from "../lib/accounts.js";
import { loadDeployments } from "../lib/deployments.js";
import { invoke } from "../lib/invoke.js";
import { bytesVal, symbolVal, u32Val, u64Val, vecVal } from "../lib/scval.js";

// Must match packages/deployer/src/config.ts :: REDSTONE_PRIMARY_SIGNERS_EVM.
const PRIMARY_SIGNERS = [
  "0x51Ce04Be4b3E32572C4Ec9135221d0691Ba7d202",
  "0x8BB8F32Df04c8b654987DAaeD53D6B6091e3B774",
  "0x9c5AE89C4Af6aA32cE58588DBaF90d18a855B6de",
  "0xDD682daEC5A90dD295d14DA4b0bec9281017b5bE",
  "0xdEB22f54738d54976C4c0fe5ce6d408E40d88499",
];

const THRESHOLD = 3;
const MAX_STALENESS_MS = 60_000n;
const FEED_IDS = ["XLM", "BTC", "ETH", "SOL"];

function hexToBytes(hex: string): Buffer {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Buffer.from(clean, "hex");
}

async function main() {
  const d = loadDeployments();
  const net = { rpcUrl: d.rpc_url, passphrase: d.network_passphrase };
  const admin = loadDeployerKeypair();

  console.log(`▸ oracle: ${d.oracle}`);
  console.log(`▸ admin : ${admin.publicKey()}`);
  console.log(`▸ signers (${PRIMARY_SIGNERS.length}), threshold=${THRESHOLD}`);

  await invoke(net, admin, d.oracle, "update_config", [
    vecVal(PRIMARY_SIGNERS.map((s) => bytesVal(hexToBytes(s)))),
    u32Val(THRESHOLD),
    u64Val(MAX_STALENESS_MS),
    vecVal(FEED_IDS.map(symbolVal)),
  ]);

  console.log("✓ oracle config updated");
}

main().catch((err) => {
  console.error("✗ fix-oracle-signers failed:", err);
  process.exit(1);
});
