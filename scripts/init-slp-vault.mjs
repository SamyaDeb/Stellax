#!/usr/bin/env node
/**
 * init-slp-vault.mjs
 *
 * Initialises the already-deployed `stellax-slp-vault` contract instance
 * and wires it into the StellaX ecosystem. Does NOT build, upload, or
 * deploy a new contract — targets the existing ID in deployments/testnet.json.
 *
 * Steps:
 *   Step 1 — Idempotency check via sim version()
 *   Step 2 — slpVault.initialize(SlpConfig)
 *   Step 3 — vault.add_authorized_caller(slp_vault)
 *   Step 4 — perp_engine.set_funding_pool(slp_vault)
 *             + funding.set_vault_config(vault, slp_vault, usdc)  [skippable]
 *   Step 5 — Verify: print version, nav_per_share, total_assets
 *
 * Usage:
 *   node scripts/init-slp-vault.mjs [--skip-funding-pool]
 *
 *     --skip-funding-pool   Skip Step 4 (keep treasury as funding pool).
 *
 * Prerequisites:
 *   - stellar CLI configured with identity `stellax-deployer` (funded)
 *   - deployments/testnet.json must contain contracts.slp_vault
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
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT        = join(__dirname, "..");
const DEPLOY_FILE = join(ROOT, "deployments/testnet.json");

const RPC_URL    = "https://soroban-testnet.stellar.org";
const PASSPHRASE = Networks.TESTNET;

const SKIP_FUNDING_POOL = process.argv.includes("--skip-funding-pool");

// ── Logging ───────────────────────────────────────────────────────────────────

const log = {
  step: (n, t) => console.log(`\n\x1b[36m━━━ Step ${n} — ${t}\x1b[0m`),
  ok:   (m)    => console.log(`  \x1b[32m✓\x1b[0m ${m}`),
  info: (m)    => console.log(`  \x1b[2m${m}\x1b[0m`),
  warn: (m)    => console.log(`  \x1b[33m⚠\x1b[0m ${m}`),
};

// ── Key loading ───────────────────────────────────────────────────────────────

function loadKey(alias) {
  const r = spawnSync("stellar", ["keys", "secret", alias], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`stellar keys secret ${alias} failed:\n${r.stderr}`);
  const key = r.stdout.trim();
  if (!key.startsWith("S")) throw new Error(`Expected secret key starting with S, got: ${key.slice(0, 4)}…`);
  return key;
}

// ── ScVal helpers (must match Rust field order in SlpConfig) ──────────────────

function addr(s) { return new Address(s).toScVal(); }
function u32(n)  { return nativeToScVal(n, { type: "u32" }); }
function u64(n)  { return nativeToScVal(typeof n === "number" ? BigInt(n) : n, { type: "u64" }); }
function i128(n) { return nativeToScVal(typeof n === "number" ? BigInt(n) : n, { type: "i128" }); }

/** Build a Soroban map ScVal from key-value pairs. */
function scMap(entries) {
  return xdr.ScVal.scvMap(
    entries.map(([k, v]) => new xdr.ScMapEntry({ key: k, val: v })),
  );
}

// ── RPC helpers ───────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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

async function simRead(rpc, pubkey, contractId, method, args = []) {
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

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n\x1b[1mStellaX — Init SLP Vault (existing contract)\x1b[0m");

  const deploy = JSON.parse(readFileSync(DEPLOY_FILE, "utf8"));

  const SLP_VAULT   = deploy.contracts?.slp_vault;
  const VAULT       = deploy.contracts?.vault;
  const PERP_ENGINE = deploy.contracts?.perp_engine;
  const TREASURY    = deploy.contracts?.treasury;
  const FUNDING     = deploy.contracts?.funding;
  const USDC_SAC    = deploy.usdc_token;

  if (!SLP_VAULT)   throw new Error("deployments/testnet.json: missing contracts.slp_vault");
  if (!VAULT)       throw new Error("deployments/testnet.json: missing contracts.vault");
  if (!PERP_ENGINE) throw new Error("deployments/testnet.json: missing contracts.perp_engine");
  if (!TREASURY)    throw new Error("deployments/testnet.json: missing contracts.treasury");
  if (!FUNDING)     throw new Error("deployments/testnet.json: missing contracts.funding");
  if (!USDC_SAC)    throw new Error("deployments/testnet.json: missing usdc_token");

  log.info(`slp_vault   : ${SLP_VAULT}`);
  log.info(`vault       : ${VAULT}`);
  log.info(`perp_engine : ${PERP_ENGINE}`);
  log.info(`treasury    : ${TREASURY}`);
  log.info(`funding     : ${FUNDING}`);
  log.info(`usdc_token  : ${USDC_SAC}`);

  const rpc = new SorobanRpc.Server(RPC_URL, { allowHttp: false });
  const deployerKp = Keypair.fromSecret(loadKey("stellax-deployer"));
  const DEPLOYER   = deployerKp.publicKey();
  log.info(`deployer    : ${DEPLOYER}`);

  // ── Step 1: Idempotency check ─────────────────────────────────────────────
  // NOTE: version() always returns CONTRACT_VERSION (1) via unwrap_or even on
  // a fresh uninitialized contract — it cannot be used as an init guard.
  // get_config() is the correct check: it calls load_config() which returns
  // Err(InvalidConfig) when DataKey::Config is absent, causing sim to error
  // and simRead to return null.
  log.step(1, "Idempotency check — sim get_config()");

  const existingConfig = await simRead(rpc, DEPLOYER, SLP_VAULT, "get_config");
  const alreadyInitialized = existingConfig !== null;
  if (alreadyInitialized) {
    log.warn("SLP vault already initialized (get_config returned data)");
    log.warn("Skipping initialize — proceeding to check wiring steps.");
  } else {
    log.ok("get_config() returned null (sim error) — contract is uninitialized");
  }

  // ── Step 2: Initialize ────────────────────────────────────────────────────
  log.step(2, "slpVault.initialize(SlpConfig)");

  if (alreadyInitialized) {
    log.warn("Skipping initialize (already done)");
  } else {
    // Keys must be lexicographically sorted by symbol for Soroban map encoding.
    const configMap = scMap([
      [xdr.ScVal.scvSymbol("admin"),           addr(DEPLOYER)],
      [xdr.ScVal.scvSymbol("cooldown_secs"),   u64(3600)],                      // 1 h on testnet
      [xdr.ScVal.scvSymbol("keeper"),          addr(DEPLOYER)],                 // keeper = deployer on testnet
      [xdr.ScVal.scvSymbol("max_vault_cap"),   i128(1_000_000n * 10n ** 18n)],  // 1 M USDC (18dp)
      [xdr.ScVal.scvSymbol("perp_engine"),     addr(PERP_ENGINE)],
      [xdr.ScVal.scvSymbol("perp_market_ids"), xdr.ScVal.scvVec([u32(0), u32(1), u32(2), u32(3)])],
      [xdr.ScVal.scvSymbol("skew_cap_bps"),    u32(5000)],                      // 50 % OI/NAV cap
      [xdr.ScVal.scvSymbol("treasury"),        addr(TREASURY)],
      [xdr.ScVal.scvSymbol("usdc_token"),      addr(USDC_SAC)],
      [xdr.ScVal.scvSymbol("vault_contract"),  addr(VAULT)],
    ]);

    await invoke(rpc, deployerKp, SLP_VAULT, "initialize", [configMap]);
    log.ok("initialized");
  }

  // ── Step 3: vault.add_authorized_caller(slp_vault) ───────────────────────
  log.step(3, "vault.add_authorized_caller(slp_vault)");
  await invoke(rpc, deployerKp, VAULT, "add_authorized_caller", [addr(SLP_VAULT)]);

  // ── Step 4: perp_engine.set_funding_pool(slp_vault) ──────────────────────
  if (SKIP_FUNDING_POOL) {
    log.step(4, "perp_engine.set_funding_pool — SKIPPED (--skip-funding-pool)");
    log.warn("Treasury remains as funding pool");
  } else {
    log.step(4, "perp_engine.set_funding_pool(slp_vault)");
    const currentPool = await simRead(rpc, DEPLOYER, PERP_ENGINE, "get_funding_pool");
    log.info(`current funding_pool : ${currentPool ?? "null"}`);

    if (currentPool === SLP_VAULT) {
      log.ok("funding_pool already points to slp_vault — skipping");
    } else {
      await invoke(rpc, deployerKp, PERP_ENGINE, "set_funding_pool", [addr(SLP_VAULT)]);

      // Also sync funding contract's vault config
      await invoke(rpc, deployerKp, FUNDING, "set_vault_config", [
        addr(VAULT),
        addr(SLP_VAULT),
        addr(USDC_SAC),
      ]);
      log.ok("funding.set_vault_config updated to slp_vault");
    }
  }

  // ── Step 5: Verify ────────────────────────────────────────────────────────
  log.step(5, "Verify");

  const version     = await simRead(rpc, DEPLOYER, SLP_VAULT, "version");
  const navPerShare = await simRead(rpc, DEPLOYER, SLP_VAULT, "nav_per_share");
  const totalAssets = await simRead(rpc, DEPLOYER, SLP_VAULT, "total_assets");

  log.ok(`version       = ${version}`);
  log.ok(`nav_per_share = ${navPerShare}`);
  log.ok(`total_assets  = ${totalAssets}`);

  console.log("\n\x1b[32;1m✓ SLP vault initialized and wired.\x1b[0m");
  console.log("\nNext steps:");
  console.log("  • Seed the pool:  node scripts/seed-slp-vault.mjs");
  console.log("  • Then LP deposits are open. sxSLP tokens auto-register in Freighter on first deposit.");
}

main().catch((e) => {
  console.error("\n\x1b[31;1m✗ FAILED:\x1b[0m", e?.stack ?? e?.message ?? e);
  process.exit(1);
});
