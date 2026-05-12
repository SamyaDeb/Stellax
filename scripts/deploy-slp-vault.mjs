#!/usr/bin/env node
/**
 * deploy-slp-vault.mjs
 *
 * Builds, uploads, deploys, and initialises the `stellax-slp-vault` contract
 * on Stellar testnet then wires it into the ecosystem:
 *
 *   Step 1 — Build wasm (cargo build --release -p stellax-slp-vault)
 *   Step 2 — Upload wasm to network (stellar contract upload)
 *   Step 3 — Deploy contract instance (stellar contract deploy)
 *   Step 4 — Initialize with SlpConfig (RPC invocation)
 *   Step 5 — vault.add_authorized_caller(slp_vault)
 *   Step 6 — perp_engine.set_funding_pool(slp_vault)  [optional — updates the
 *             treasury placeholder set in setup-phase3-funding.mjs]
 *   Step 7 — Update deployments/testnet.json with contract id + wasm hash
 *
 * Usage:
 *   node scripts/deploy-slp-vault.mjs [--skip-build] [--skip-funding-pool]
 *
 *     --skip-build          Skip cargo build (use existing wasm artifact).
 *     --skip-funding-pool   Skip Step 6 (keep treasury as funding pool for now).
 *
 * Prerequisites:
 *   - stellar CLI configured with identity `stellax-deployer`
 *   - Rust toolchain with wasm32v1-none target
 *   - Existing contracts in deployments/testnet.json
 */

import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  rpc as SorobanRpc,
  scValToNative,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { spawnSync, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT        = join(__dirname, "..");
const DEPLOY_FILE = join(ROOT, "deployments/testnet.json");
const WASM_PATH   = join(ROOT, "target/wasm32v1-none/release/stellax_slp_vault.wasm");

const RPC_URL    = "https://soroban-testnet.stellar.org";
const PASSPHRASE = Networks.TESTNET;
const NETWORK    = "testnet";

const SKIP_BUILD        = process.argv.includes("--skip-build");
const SKIP_FUNDING_POOL = process.argv.includes("--skip-funding-pool");

const log = {
  step: (n, t) => console.log(`\n\x1b[36m━━━ Step ${n} — ${t}\x1b[0m`),
  ok:   (m)    => console.log(`  \x1b[32m✓\x1b[0m ${m}`),
  info: (m)    => console.log(`  \x1b[2m${m}\x1b[0m`),
  warn: (m)    => console.log(`  \x1b[33m⚠\x1b[0m ${m}`),
};

function loadKey(alias) {
  const r = spawnSync("stellar", ["keys", "secret", alias], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`stellar keys secret ${alias} failed:\n${r.stderr}`);
  const key = r.stdout.trim();
  if (!key.startsWith("S")) throw new Error(`Expected secret key starting with S, got: ${key.slice(0,4)}…`);
  return key;
}

function runCli(...args) {
  const r = spawnSync("stellar", args, { encoding: "utf8", cwd: ROOT });
  if (r.status !== 0) throw new Error(`stellar ${args[0]} failed:\n${r.stderr}\n${r.stdout}`);
  return r.stdout.trim();
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function addr(s) { return new Address(s).toScVal(); }
function u32(n)  { return nativeToScVal(n, { type: "u32" }); }
function u64(n)  { return nativeToScVal(typeof n === "number" ? BigInt(n) : n, { type: "u64" }); }
function i128(n) { return nativeToScVal(typeof n === "number" ? BigInt(n) : n, { type: "i128" }); }

/** Build a Soroban map ScVal from key-value pairs of ScVals. */
function scMap(entries) {
  return xdr.ScVal.scvMap(
    entries.map(([k, v]) => new xdr.ScMapEntry({ key: k, val: v })),
  );
}

async function invoke(rpc, signer, contractId, method, args) {
  const account  = await rpc.getAccount(signer.publicKey());
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(contract.call(method, ...args))
    .setTimeout(120)
    .build();

  const sim = await rpc.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`sim ${method}: ${sim.error}`);
  }
  const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(signer);

  const send = await rpc.sendTransaction(prepared);
  if (send.status === "ERROR") {
    throw new Error(`send ${method}: ${JSON.stringify(send.errorResult)}`);
  }

  const deadline = Date.now() + 120_000;
  for (;;) {
    await sleep(2_000);
    const r = await rpc.getTransaction(send.hash);
    if (r.status === "SUCCESS") {
      log.ok(`${method} — tx ${send.hash.slice(0, 12)}…`);
      return r.returnValue ? scValToNative(r.returnValue) : undefined;
    }
    if (r.status === "FAILED") throw new Error(`tx ${method} FAILED: ${JSON.stringify(r)}`);
    if (Date.now() > deadline) throw new Error(`${method} timeout`);
  }
}

async function simRead(rpc, pubkey, contractId, method, args) {
  const account  = await rpc.getAccount(pubkey);
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60)
    .build();
  const sim = await rpc.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) return null;
  return sim.result?.retval ? scValToNative(sim.result.retval) : null;
}

async function main() {
  console.log("\n\x1b[1mStellaX — SLP Vault Deploy\x1b[0m");

  const deploy = JSON.parse(readFileSync(DEPLOY_FILE, "utf8"));

  const VAULT       = deploy.contracts.vault;
  const PERP_ENGINE = deploy.contracts.perp_engine;
  const TREASURY    = deploy.contracts.treasury;
  const USDC_SAC    = deploy.usdc_token;

  log.info(`vault       : ${VAULT}`);
  log.info(`perp_engine : ${PERP_ENGINE}`);
  log.info(`treasury    : ${TREASURY}`);
  log.info(`usdc_token  : ${USDC_SAC}`);

  const rpc = new SorobanRpc.Server(RPC_URL, { allowHttp: false });
  const deployerKp = Keypair.fromSecret(loadKey("stellax-deployer"));
  const DEPLOYER   = deployerKp.publicKey();
  log.info(`deployer    : ${DEPLOYER}`);

  // ── Step 1: Build wasm ───────────────────────────────────────────────────
  log.step(1, "Build stellax-slp-vault wasm");
  if (SKIP_BUILD) {
    log.warn("--skip-build set; using existing wasm artifact");
  } else {
    log.info("running: cargo build --target wasm32v1-none -p stellax-slp-vault --release");
    execFileSync(
      "cargo",
      ["build", "--target", "wasm32v1-none", "-p", "stellax-slp-vault", "--release"],
      { cwd: ROOT, stdio: "inherit" },
    );
    log.ok("cargo build complete");
  }

  // ── Step 2: Upload wasm ──────────────────────────────────────────────────
  log.step(2, "Upload wasm to testnet");
  log.info(`wasm: ${WASM_PATH}`);
  const wasmHash = runCli(
    "contract", "upload",
    "--wasm", WASM_PATH,
    "--source", "stellax-deployer",
    "--network", NETWORK,
  );
  log.ok(`wasm hash: ${wasmHash}`);

  // ── Step 3: Deploy contract ──────────────────────────────────────────────
  log.step(3, "Deploy contract instance");
  const slpVaultId = runCli(
    "contract", "deploy",
    "--wasm-hash", wasmHash,
    "--source", "stellax-deployer",
    "--network", NETWORK,
  );
  log.ok(`slp_vault contract id: ${slpVaultId}`);

  // ── Step 4: Initialize ───────────────────────────────────────────────────
  log.step(4, "Initialize SlpConfig");

  // Verify not already initialized.
  // NOTE: version() always returns CONTRACT_VERSION (1) via unwrap_or — even on
  // a fresh uninitialized contract.  Use get_config() instead: it returns a
  // simulation error (→ null) when the contract has no Config entry.
  const existingConfig = await simRead(rpc, DEPLOYER, slpVaultId, "get_config", []);
  if (existingConfig !== null) {
    log.warn(`contract already initialized; skipping initialize`);
  } else {
    // Soroban maps must be key-sorted by XDR symbol key; keys are Rust field names.
    // The contract's SlpConfig is encoded as a map of symbol → scval pairs.
    const configMap = scMap([
      [xdr.ScVal.scvSymbol("admin"),          addr(DEPLOYER)],
      [xdr.ScVal.scvSymbol("cooldown_secs"),  u64(3600)],       // 1 h on testnet
      [xdr.ScVal.scvSymbol("keeper"),         addr(DEPLOYER)],  // keeper = deployer on testnet
      [xdr.ScVal.scvSymbol("max_vault_cap"),  i128(1_000_000n * 10n ** 18n)],  // 1M USDC
      [xdr.ScVal.scvSymbol("perp_engine"),    addr(PERP_ENGINE)],
      [xdr.ScVal.scvSymbol("perp_market_ids"), xdr.ScVal.scvVec([u32(0), u32(1), u32(2), u32(3)])],
      [xdr.ScVal.scvSymbol("skew_cap_bps"),   u32(5000)],       // 50% OI/NAV cap
      [xdr.ScVal.scvSymbol("treasury"),       addr(TREASURY)],
      [xdr.ScVal.scvSymbol("usdc_token"),     addr(USDC_SAC)],
      [xdr.ScVal.scvSymbol("vault_contract"), addr(VAULT)],
    ]);

    await invoke(rpc, deployerKp, slpVaultId, "initialize", [configMap]);
    log.ok("initialized");
  }

  // ── Step 5: vault.add_authorized_caller(slp_vault) ──────────────────────
  log.step(5, "vault.add_authorized_caller(slp_vault)");
  await invoke(rpc, deployerKp, VAULT, "add_authorized_caller", [addr(slpVaultId)]);

  // ── Step 6: perp_engine.set_funding_pool(slp_vault) ─────────────────────
  if (!SKIP_FUNDING_POOL) {
    log.step(6, "perp_engine.set_funding_pool(slp_vault)  [swap from treasury placeholder]");
    const currentPool = await simRead(rpc, DEPLOYER, PERP_ENGINE, "get_funding_pool", []);
    log.info(`current funding_pool: ${currentPool}`);
    if (currentPool === slpVaultId) {
      log.ok("already set to slp_vault — skipping");
    } else {
      await invoke(rpc, deployerKp, PERP_ENGINE, "set_funding_pool", [addr(slpVaultId)]);

      // Also update funding.set_vault_config with new funding pool
      const FUNDING = deploy.contracts.funding;
      await invoke(rpc, deployerKp, FUNDING, "set_vault_config", [
        addr(VAULT),
        addr(slpVaultId),
        addr(USDC_SAC),
      ]);
      log.ok("funding.set_vault_config updated to slp_vault");
    }
  } else {
    log.warn("--skip-funding-pool set; treasury remains as funding pool");
  }

  // ── Step 7: Update deployments/testnet.json ──────────────────────────────
  log.step(7, "Update deployments/testnet.json");
  deploy.contracts.slp_vault = slpVaultId;
  deploy.wasm_hashes.stellax_slp_vault = wasmHash;
  deploy.upgraded_at = new Date().toISOString();
  writeFileSync(DEPLOY_FILE, JSON.stringify(deploy, null, 2) + "\n", "utf8");
  log.ok("deployments/testnet.json updated");

  // ── Verify ────────────────────────────────────────────────────────────────
  const version = await simRead(rpc, DEPLOYER, slpVaultId, "version", []);
  const navPerShare = await simRead(rpc, DEPLOYER, slpVaultId, "nav_per_share", []);
  log.ok(`version=${version}  nav_per_share=${navPerShare}`);

  console.log("\n\x1b[32;1m✓ SLP vault deployed.\x1b[0m");
  console.log("\nNext steps:");
  console.log(`  • Set VITE_SLP_VAULT_CONTRACT_ID=${slpVaultId} in packages/frontend/.env`);
  console.log(`  • Set SLP_VAULT_CONTRACT_ID=${slpVaultId} in packages/keeper/.env`);
  console.log("  • Seed the pool: call slpVault.seed(amount) as admin to bootstrap NAV");
  console.log("  • Set SLP_FEE_SWEEP_AMOUNT in keeper .env and restart");
}

main().catch((e) => {
  console.error("\n\x1b[31;1m✗ FAILED:\x1b[0m", e?.stack ?? e?.message ?? e);
  process.exit(1);
});
