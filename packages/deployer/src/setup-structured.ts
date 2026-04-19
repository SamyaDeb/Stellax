// One-off script: initialize the structured vault on testnet (if not already done)
// and configure it for testnet-friendly e2e testing.
//
// Run: npx tsx src/setup-structured.ts

import { invokeSDK, addrVal, u32Val, u64Val, i128Val, symbolVal, mapVal } from "./sdkinvoke.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "../../../");
const dep = JSON.parse(readFileSync(join(REPO_ROOT, "deployments/testnet.json"), "utf8"));

const RPC = dep.rpc_url as string;
const PASSPHRASE = dep.network_passphrase as string;
const IDENTITY = dep.deployer_identity as string;

const STRUCTURED = dep.contracts.structured as string;
const DEPLOYER = dep.deployer as string;
const OPTIONS = dep.contracts.options as string;
const VAULT = dep.contracts.vault as string;
const ORACLE = dep.contracts.oracle as string;
const TREASURY = dep.contracts.treasury as string;
const USDC = dep.usdc_token as string;

async function main() {
  console.log("▸ checking structured vault config …");

  // ── Initialize (only if not yet initialized) ──────────────────────────────
  try {
    console.log("  initializing structured vault …");
    await invokeSDK(RPC, PASSPHRASE, IDENTITY, STRUCTURED, "initialize", [
      mapVal([
        ["admin",                   addrVal(DEPLOYER)],
        ["epoch_duration",          u64Val(7 * 24 * 60 * 60)],
        ["keeper",                  addrVal(DEPLOYER)],
        ["kind",                    u32Val(0)],  // VaultKind::CoveredCall
        ["max_vault_cap",           i128Val(100_000_000_000_000_000_000_000n)],
        ["option_market_id",        u32Val(0)],
        ["options_contract",        addrVal(OPTIONS)],
        ["oracle_contract",         addrVal(ORACLE)],
        ["performance_fee_bps",     u32Val(1000)],
        ["premium_budget_bps",      u32Val(100)],
        ["strike_delta_bps",        u32Val(1000)],
        ["treasury",                addrVal(TREASURY)],
        ["underlying_asset_symbol", symbolVal("USDC")],
        ["underlying_token",        addrVal(USDC)],
        ["vault_contract",          addrVal(VAULT)],
      ]),
    ]);
    console.log("  ✓ initialized");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("#1") || msg.includes("AlreadyInitialized")) {
      console.log("  ✓ already initialized (skipped)");
    } else {
      throw e;
    }
  }

  // ── Upgrade to new WASM ───────────────────────────────────────────────────
  console.log("▸ upgrading to new WASM …");
  // WASM hash from the build step above
  const NEW_WASM = "4eaf6b4e4d94792503996b355c36ddd79643cc70d5731a3106e3be222628d1cf";
  const { xdr } = await import("@stellar/stellar-sdk");
  await invokeSDK(RPC, PASSPHRASE, IDENTITY, STRUCTURED, "upgrade", [
    xdr.ScVal.scvBytes(Buffer.from(NEW_WASM, "hex")),
  ]);
  console.log("  ✓ upgraded");

  // ── Set option asset symbol → XLM (fixes oracle lookup in roll_epoch) ────
  console.log("▸ setting option_asset = XLM …");
  await invokeSDK(RPC, PASSPHRASE, IDENTITY, STRUCTURED, "set_option_asset", [
    symbolVal("XLM"),
  ]);
  console.log("  ✓ option_asset = XLM");

  // ── Set short epoch duration for testnet (120s) ────────────────────────────
  console.log("▸ setting epoch_duration = 120s …");
  await invokeSDK(RPC, PASSPHRASE, IDENTITY, STRUCTURED, "set_epoch_duration", [
    u64Val(120n),
  ]);
  console.log("  ✓ epoch_duration = 120s");

  console.log("\n✅ Structured vault ready for e2e testing.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
