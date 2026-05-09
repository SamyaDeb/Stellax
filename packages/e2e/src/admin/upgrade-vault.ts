// Upgrade the vault contract to the fixed WASM (MathOverflow fix for large deposits)
import { Keypair, nativeToScVal } from "@stellar/stellar-sdk";
import { spawnSync } from "node:child_process";
import { loadDeployments } from "../lib/deployments.js";
import { invoke } from "../lib/invoke.js";

const NEW_WASM_HASH =
  "779db449e68048db958a27600f9872bb8f5fd60b65e42f6da6e6b207fd61f7cd";

function loadDeployerKeypair(): Keypair {
  const r = spawnSync("stellar", ["keys", "show", "stellax-deployer"], {
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`stellar keys show failed: ${r.stderr}`);
  return Keypair.fromSecret(r.stdout.trim());
}

function hexToBytes32(hex: string): Uint8Array {
  if (hex.length !== 64) throw new Error(`Expected 64-char hex, got ${hex.length}`);
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function main() {
  const d = loadDeployments();
  const net = { rpcUrl: d.rpc_url, passphrase: d.network_passphrase };
  const deployer = loadDeployerKeypair();

  console.log(`vault:    ${d.vault}`);
  console.log(`new hash: ${NEW_WASM_HASH}\n`);

  const hashBytes = hexToBytes32(NEW_WASM_HASH);
  // BytesN<32> is ScvBytes with exactly 32 bytes
  const hashScVal = nativeToScVal(Buffer.from(hashBytes), { type: "bytes" });

  console.log("Calling vault.upgrade(new_wasm_hash)...");
  await invoke(net, deployer, d.vault, "upgrade", [hashScVal]);
  console.log("✓ Vault upgraded successfully.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
