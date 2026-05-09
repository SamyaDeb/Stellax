#!/usr/bin/env node
/**
 * setup-phase3-funding.mjs
 *
 * Phase 3 post-upgrade wiring — continuous funding settlement.
 *
 * Runs three idempotent on-chain configuration calls:
 *
 *   Step 1 — perp_engine.set_funding_pool(treasury)
 *     Registers the treasury as the funding-pool sub-account inside the vault.
 *     On testnet the treasury acts as a placeholder; swap to SLP vault once
 *     Phase 2 is deployed and seeded.
 *
 *   Step 2 — vault.add_authorized_caller(funding_contract)
 *     Permits the funding contract to call vault.move_balance() when settling
 *     funding payments between traders and the funding pool.
 *
 *   Step 3 — funding.set_vault_config(vault, funding_pool, usdc_token)
 *     Registers the vault address, the funding-pool sub-account address, and
 *     the USDC SAC inside the funding contract so settle_funding_for_position
 *     can execute balance transfers.
 *
 * Usage:
 *   node scripts/setup-phase3-funding.mjs
 *
 * Prerequisites:
 *   - stellar CLI configured with identity `stellax-deployer`
 *   - funding + perp-engine already upgraded (Phase 3 wasm)
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
  xdr,
} from "@stellar/stellar-sdk";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEPLOY_FILE = join(__dirname, "../deployments/testnet.json");

const RPC_URL    = "https://soroban-testnet.stellar.org";
const PASSPHRASE = Networks.TESTNET;

const deploy = JSON.parse(readFileSync(DEPLOY_FILE, "utf8"));

const VAULT          = deploy.contracts.vault;
const FUNDING        = deploy.contracts.funding;
const PERP_ENGINE    = deploy.contracts.perp_engine;
const TREASURY       = deploy.contracts.treasury;
const USDC_SAC       = deploy.usdc_token;

// Phase 3 testnet: use the treasury as funding pool placeholder.
// Swap to SLP vault address once Phase 2 is seeded on-chain.
const FUNDING_POOL   = TREASURY;

const log = {
  step: (n, t) => console.log(`\n\x1b[36m━━━ Step ${n} — ${t}\x1b[0m`),
  ok:   (m)    => console.log(`  \x1b[32m✓\x1b[0m ${m}`),
  info: (m)    => console.log(`  \x1b[2m${m}\x1b[0m`),
  warn: (m)    => console.log(`  \x1b[33m⚠\x1b[0m ${m}`),
};

function loadKey(alias) {
  const r = spawnSync("stellar", ["keys", "show", alias], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`stellar keys show ${alias} failed:\n${r.stderr}`);
  return r.stdout.trim();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function addr(s) {
  return new Address(s).toScVal();
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
  console.log("\n\x1b[1mStellaX — Phase 3 funding settlement wiring\x1b[0m");
  log.info(`vault         : ${VAULT}`);
  log.info(`funding       : ${FUNDING}`);
  log.info(`perp_engine   : ${PERP_ENGINE}`);
  log.info(`funding_pool  : ${FUNDING_POOL}  (treasury placeholder)`);
  log.info(`usdc_token    : ${USDC_SAC}`);

  const rpc = new SorobanRpc.Server(RPC_URL, { allowHttp: false });
  const deployerKp = Keypair.fromSecret(loadKey("stellax-deployer"));
  const DEPLOYER   = deployerKp.publicKey();
  log.info(`deployer      : ${DEPLOYER}`);

  // ── Step 1: set_funding_pool on perp-engine ──────────────────────────────
  log.step(1, "perp_engine.set_funding_pool(treasury)");
  const existingPool = await simRead(rpc, DEPLOYER, PERP_ENGINE, "get_funding_pool", []);
  if (existingPool && existingPool !== FUNDING_POOL) {
    log.warn(`Existing funding pool ${existingPool} differs — updating to ${FUNDING_POOL}`);
  } else if (existingPool === FUNDING_POOL) {
    log.ok("already set — skipping");
  }
  if (existingPool !== FUNDING_POOL) {
    await invoke(rpc, deployerKp, PERP_ENGINE, "set_funding_pool", [addr(FUNDING_POOL)]);
  }

  // ── Step 2: vault.add_authorized_caller(funding) ─────────────────────────
  log.step(2, "vault.add_authorized_caller(funding_contract)");
  // add_authorized_caller is idempotent (silently ignores duplicates).
  await invoke(rpc, deployerKp, VAULT, "add_authorized_caller", [addr(FUNDING)]);

  // ── Step 3: funding.set_vault_config(vault, funding_pool, usdc_token) ────
  log.step(3, "funding.set_vault_config(vault, funding_pool, usdc_token)");
  await invoke(rpc, deployerKp, FUNDING, "set_vault_config", [
    addr(VAULT),
    addr(FUNDING_POOL),
    addr(USDC_SAC),
  ]);

  // ── Step 4: verify ────────────────────────────────────────────────────────
  log.step(4, "Verify get_vault_config on funding contract");
  const vaultCfg = await simRead(rpc, DEPLOYER, FUNDING, "get_vault_config", []);
  log.ok(`get_vault_config: ${JSON.stringify(vaultCfg)}`);

  const poolOnPerp = await simRead(rpc, DEPLOYER, PERP_ENGINE, "get_funding_pool", []);
  log.ok(`get_funding_pool (perp-engine): ${poolOnPerp}`);

  console.log("\n\x1b[32;1m✓ Phase 3 wiring complete.\x1b[0m");
  console.log("\nNext steps:");
  console.log("  • Start keeper with WORKER_FUNDING_SETTLER_ENABLED=true");
  console.log("  • After Phase 2 SLP deploy: re-run with FUNDING_POOL = slp_vault_address");
}

main().catch((e) => {
  console.error("\n\x1b[31;1m✗ FAILED:\x1b[0m", e?.stack ?? e?.message ?? e);
  process.exit(1);
});
