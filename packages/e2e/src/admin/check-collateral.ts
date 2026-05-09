// Diagnose structured vault collateral state after unlock_margin fix
import { Keypair } from "@stellar/stellar-sdk";
import { spawnSync } from "node:child_process";
import { loadDeployments } from "../lib/deployments.js";
import { invoke, simulateRead } from "../lib/invoke.js";
import { addrVal, i128Val, u64Val } from "../lib/scval.js";

function loadDeployerKeypair(): Keypair {
  const r = spawnSync("stellar", ["keys", "show", "stellax-deployer"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`stellar keys show failed: ${r.stderr}`);
  return Keypair.fromSecret(r.stdout.trim());
}

const d = loadDeployments();
const net = { rpcUrl: d.rpc_url, passphrase: d.network_passphrase };
const deployer = loadDeployerKeypair();

async function tryRead(label: string, method: string, args: Parameters<typeof simulateRead>[4]) {
  try {
    const result = await simulateRead(net, deployer.publicKey(), d.vault, method, args);
    console.log(`✓ ${label}: ${typeof result === 'bigint' ? result.toString() : JSON.stringify(result)}`);
    return result;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message.split('\n')[0] : String(e);
    console.log(`✗ ${label}: ${msg}`);
    return null;
  }
}

async function tryInvoke(label: string, method: string, args: Parameters<typeof invoke>[4]) {
  try {
    const result = await invoke(net, deployer, d.vault, method, args);
    console.log(`✓ ${label}: succeeded (result=${JSON.stringify(result)})`);
    return true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message.split('\n')[0] : String(e);
    console.log(`✗ ${label}: ${msg}`);
    return false;
  }
}

async function main() {
  console.log(`deployer:   ${deployer.publicKey()}`);
  console.log(`structured: ${d.structured}`);
  console.log(`vault:      ${d.vault}\n`);

  // ── READ checks ─────────────────────────────────────────────────────────────
  console.log("── Read checks ──");
  await tryRead("get_total_collateral_value(structured)", "get_total_collateral_value", [addrVal(d.structured)]);
  await tryRead("get_free_collateral_value(structured)", "get_free_collateral_value", [addrVal(d.structured)]);
  await tryRead("get_total_collateral_value(deployer)", "get_total_collateral_value", [addrVal(deployer.publicKey())]);

  // ── WRITE checks ─────────────────────────────────────────────────────────────
  console.log("\n── Write checks ──");

  // lock_margin with small non-zero amount for structured vault
  await tryInvoke("lock_margin(deployer, structured, pos=99999, amount=1)", "lock_margin", [
    addrVal(deployer.publicKey()),
    addrVal(d.structured),
    u64Val(99999n),
    i128Val(1n),
  ]);

  // unlock it back immediately
  await tryInvoke("unlock_margin(deployer, structured, pos=99999, amount=1)", "unlock_margin", [
    addrVal(deployer.publicKey()),
    addrVal(d.structured),
    u64Val(99999n),
    i128Val(1n),
  ]);

  // unlock any residual from deployer's own test lock from last run
  await tryInvoke("unlock_margin(deployer, deployer, pos=9999, amount=100000000000000000)", "unlock_margin", [
    addrVal(deployer.publicKey()),
    addrVal(deployer.publicKey()),
    u64Val(9999n),
    i128Val(100_000_000_000_000_000n),
  ]);

  console.log("\n── Final state ──");
  await tryRead("get_total_collateral_value(structured)", "get_total_collateral_value", [addrVal(d.structured)]);
  await tryRead("get_free_collateral_value(structured)", "get_free_collateral_value", [addrVal(d.structured)]);
}

main().catch(err => { console.error(err.message || err); process.exit(1); });
