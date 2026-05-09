#!/usr/bin/env node
/**
 * seed-slp-vault.mjs
 *
 * Seeds the StellaX SLP vault with an initial USDC deposit from the deployer
 * to bootstrap NAV (nav_per_share starts at 1.0 = 1e7 in 7dp native units).
 *
 * This sets the initial "floor" price for LP shares so the vault can accept
 * public deposits without div-by-zero on the first share mint.
 *
 * Usage:
 *   node scripts/seed-slp-vault.mjs [--amount <native>]
 *
 *   --amount <native>  Seed amount in 7-decimal native USDC units.
 *                      Default: 1000_0000000 (= 1000 USDC).
 *
 * Prerequisites:
 *   - `stellax-deployer` stellar CLI identity must be funded with USDC.
 *   - deployments/testnet.json must contain `contracts.slp_vault`.
 *   - Admin must have previously called vault.add_authorized_caller(slp_vault)
 *     and funded the slp_vault entry in the collateral vault.
 *     (Both already done by deploy-slp-vault.mjs.)
 *
 * What it does:
 *   1. Reads slp_vault contract ID from deployments/testnet.json.
 *   2. Reads current nav_per_share and total_assets for idempotency check.
 *   3. Calls slp_vault.seed(amount) with the deployer key.
 *   4. Prints resulting nav_per_share and total_assets.
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

// ── Parse CLI args ────────────────────────────────────────────────────────────

const amountArgIdx = process.argv.indexOf("--amount");
const SEED_AMOUNT = amountArgIdx !== -1
  ? BigInt(process.argv[amountArgIdx + 1])
  : 1_000_0000000n; // 1000 USDC (7dp)

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  if (!key.startsWith("S")) throw new Error(`Expected secret key starting with S, got: ${key.slice(0, 4)}…`);
  return key;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function i128(n) { return nativeToScVal(typeof n === "number" ? BigInt(n) : n, { type: "i128" }); }

async function invoke(rpc, signer, contractId, method, args) {
  const account  = await rpc.getAccount(signer.publicKey());
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(contract.call(method, ...args))
    .setTimeout(120)
    .build();

  const sim = await rpc.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`simulate ${method}: ${sim.error}`);
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
  console.log("\n\x1b[1mStellaX — Seed SLP Vault\x1b[0m");

  const deploy = JSON.parse(readFileSync(DEPLOY_FILE, "utf8"));
  const SLP_VAULT = deploy.contracts?.slp_vault;
  if (!SLP_VAULT) {
    throw new Error(
      "deployments/testnet.json does not contain contracts.slp_vault.\n" +
      "Run node scripts/deploy-slp-vault.mjs first.",
    );
  }

  log.info(`slp_vault   : ${SLP_VAULT}`);
  log.info(`seed_amount : ${SEED_AMOUNT.toString()} (${Number(SEED_AMOUNT) / 1e7} USDC)`);

  const rpc = new SorobanRpc.Server(RPC_URL, { allowHttp: false });
  const deployerKp = Keypair.fromSecret(loadKey("stellax-deployer"));
  const DEPLOYER   = deployerKp.publicKey();
  log.info(`deployer    : ${DEPLOYER}`);

  // ── Step 1: Read current state ────────────────────────────────────────────
  log.step(1, "Read current SLP vault state");

  const navPerShareBefore = await simRead(rpc, DEPLOYER, SLP_VAULT, "nav_per_share");
  const totalAssetsBefore = await simRead(rpc, DEPLOYER, SLP_VAULT, "total_assets");
  const totalSharesBefore = await simRead(rpc, DEPLOYER, SLP_VAULT, "total_shares");

  log.info(`nav_per_share  : ${navPerShareBefore ?? "null"}`);
  log.info(`total_assets   : ${totalAssetsBefore ?? "null"}`);
  log.info(`total_shares   : ${totalSharesBefore ?? "null"}`);

  // Idempotency: if total_assets is already non-zero, skip.
  if (totalAssetsBefore !== null && BigInt(totalAssetsBefore) > 0n) {
    log.warn(
      `SLP vault already seeded (total_assets = ${totalAssetsBefore}). ` +
      "Pass a larger --amount or investigate if re-seeding is intended.",
    );
    log.warn("Skipping seed call — vault is already initialised.");
    process.exit(0);
  }

  // ── Step 2: Call seed ─────────────────────────────────────────────────────
  log.step(2, `Call seed(${SEED_AMOUNT}) on SLP vault`);

  await invoke(rpc, deployerKp, SLP_VAULT, "seed", [i128(SEED_AMOUNT)]);

  // ── Step 3: Verify ────────────────────────────────────────────────────────
  log.step(3, "Verify post-seed state");

  const navPerShareAfter = await simRead(rpc, DEPLOYER, SLP_VAULT, "nav_per_share");
  const totalAssetsAfter = await simRead(rpc, DEPLOYER, SLP_VAULT, "total_assets");
  const totalSharesAfter = await simRead(rpc, DEPLOYER, SLP_VAULT, "total_shares");

  log.ok(`nav_per_share  : ${navPerShareAfter}`);
  log.ok(`total_assets   : ${totalAssetsAfter}`);
  log.ok(`total_shares   : ${totalSharesAfter}`);

  console.log("\n\x1b[32mSLP vault seeded successfully.\x1b[0m");
  console.log("NAV/share =", navPerShareAfter, "— LP deposits are now open.");
}

main().catch((err) => {
  console.error("\n\x1b[31mError:\x1b[0m", err.message);
  process.exit(1);
});
