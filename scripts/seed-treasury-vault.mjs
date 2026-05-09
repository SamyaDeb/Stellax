#!/usr/bin/env node
/**
 * seed-treasury-vault.mjs
 *
 * IMMEDIATE FIX for:
 *   invoke(close_position) simulation failed: HostError: Error(Contract, #8)
 *   VaultError::InsufficientBalance — treasury vault balance is 0 (or too low
 *   to cover user profit payouts from vault.move_balance(treasury → user)).
 *
 * Root cause:
 *   The perp engine's settle_position_close calls:
 *     vault.move_balance(treasury → user, profit_amount)
 *   on profitable closes.  The treasury contract address has no internal vault
 *   balance because vault.deposit() requires the depositor to sign, and
 *   treasury is a contract — not a keypair.
 *
 * Fix applied here (no WASM redeployment required):
 *   1. vault.add_authorized_caller(deployer)  — idempotent, admin-only call
 *   2. vault.credit(deployer, treasury, usdc, SEED_AMOUNT)
 *      Credits treasury's internal vault balance synthetically (no token
 *      transfer). The vault's `credit` function was designed for this exact
 *      pattern (e.g. cross-chain bridge credits).
 *
 * After running this script, close_position simulations will succeed for
 * profitable positions with profit up to SEED_AMOUNT.
 *
 * For the permanent fix also run:
 *   make optimize && bash scripts/upgrade-testnet.sh
 * which deploys the new settle_position_close that explicitly credits
 * close_fee to treasury before paying out gross_pnl.
 *
 * Usage:
 *   node scripts/seed-treasury-vault.mjs
 *
 * Prerequisites:
 *   - stellar CLI configured with identity `stellax-deployer`
 *   - stellax-deployer must be the vault admin (it is, per deployments/testnet.json)
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

// ── Config ───────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEPLOY_FILE = join(__dirname, "../deployments/testnet.json");

const RPC_URL     = "https://soroban-testnet.stellar.org";
const PASSPHRASE  = Networks.TESTNET;

const deploy = JSON.parse(readFileSync(DEPLOY_FILE, "utf8"));

const VAULT    = deploy.contracts.vault;
const TREASURY = deploy.contracts.treasury;
const USDC_SAC = deploy.usdc_token;

// 10 000 USDC at 7 decimals (Stellar testnet USDC from GBBD47IF… issuer = 7dp).
// Enough to cover thousands of small testnet profit payouts.
const SEED_AMOUNT_NATIVE = 10_000n * 10_000_000n; // 10k USDC, 7dp

// ── Helpers ──────────────────────────────────────────────────────────────────

const log = {
  step: (n, t) => console.log(`\n\x1b[36m━━━ Step ${n} — ${t} \x1b[0m`),
  ok:   (m)    => console.log(`  \x1b[32m✓\x1b[0m ${m}`),
  info: (m)    => console.log(`  \x1b[2m${m}\x1b[0m`),
  warn: (m)    => console.log(`  \x1b[33m⚠\x1b[0m ${m}`),
  fail: (m)    => console.log(`  \x1b[31m✗\x1b[0m ${m}`),
};

function loadKey(alias) {
  const r = spawnSync("stellar", ["keys", "show", alias], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`stellar keys show ${alias} failed:\n${r.stderr}`);
  return r.stdout.trim();
}

function loadKeypair(alias) {
  const secret = loadKey(alias);
  return Keypair.fromSecret(secret);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Encode an i128 value as ScVal.
function i128(n) {
  const v    = BigInt(n);
  const neg  = v < 0n;
  const abs  = neg ? -v : v;
  const mask = (1n << 64n) - 1n;
  const lo   = abs & mask;
  const hi   = abs >> 64n;
  const loU  = xdr.Uint64.fromString(lo.toString());
  const hiI  = neg
    ? xdr.Int64.fromString((-(hi + (lo === 0n ? 0n : 1n))).toString())
    : xdr.Int64.fromString(hi.toString());
  return xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: hiI, lo: loU }));
}

const enc = {
  addr:  (s) => new Address(s).toScVal(),
  i128:  (n) => i128(n),
};

/** Simulate + assemble + sign + send + poll a Soroban transaction. */
async function invoke(rpc, signer, contractId, method, args) {
  const account  = await rpc.getAccount(signer.publicKey());
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
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
    if (r.status === "FAILED") {
      throw new Error(`tx ${method} FAILED: ${JSON.stringify(r)}`);
    }
    if (Date.now() > deadline) throw new Error(`${method} timeout`);
  }
}

/** Read-only simulate. */
async function simRead(rpc, sourcePubkey, contractId, method, args) {
  const account  = await rpc.getAccount(sourcePubkey);
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60)
    .build();

  const sim = await rpc.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) return null;
  return sim.result?.retval ? scValToNative(sim.result.retval) : null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { Keypair } = await import("@stellar/stellar-sdk");

  console.log("\n\x1b[1mStellaX — seed treasury vault balance\x1b[0m\n");
  log.info(`vault    : ${VAULT}`);
  log.info(`treasury : ${TREASURY}`);
  log.info(`usdc_sac : ${USDC_SAC}`);

  const rpc = new SorobanRpc.Server(RPC_URL, { allowHttp: false });

  // Load deployer — must be the vault admin.
  const deployerSecret = loadKey("stellax-deployer");
  const deployerKp     = Keypair.fromSecret(deployerSecret);
  const DEPLOYER       = deployerKp.publicKey();
  log.info(`deployer : ${DEPLOYER}`);

  // ── Step 1: Read current treasury vault balance ─────────────────────────
  log.step(1, "Read current treasury vault balance");
  const currentBal = await simRead(rpc, DEPLOYER, VAULT, "get_balance", [
    enc.addr(TREASURY),
    enc.addr(USDC_SAC),
  ]);
  log.info(`treasury vault balance (18-dp) : ${currentBal ?? "0 (null = no entry)"}`);

  // Half the seed amount in 18-dp (7dp → 18dp: multiply by 10^11).
  const halfSeedInternal = (SEED_AMOUNT_NATIVE * 10n ** 11n) / 2n;
  const currentInternal  = BigInt(currentBal ?? 0n);

  if (currentInternal >= halfSeedInternal) {
    log.ok(
      `Treasury already has sufficient vault balance (${currentInternal} ≥ ${halfSeedInternal}).` +
      ` Nothing to do.`
    );
    return;
  }

  log.warn(
    `Treasury vault balance ${currentInternal} is below threshold ${halfSeedInternal} — seeding now.`
  );

  // ── Step 2: Add deployer as vault authorized caller ──────────────────────
  // vault.add_authorized_caller is idempotent (silently skips duplicates).
  // Requires vault admin auth — deployer IS the vault admin.
  log.step(2, `Add deployer (${DEPLOYER.slice(0, 8)}…) as vault authorized_caller`);
  await invoke(rpc, deployerKp, VAULT, "add_authorized_caller", [
    enc.addr(DEPLOYER),
  ]);

  // ── Step 3: Credit treasury vault balance ────────────────────────────────
  // vault.credit(caller, user, token, amount_in_native_decimals)
  // Requires:
  //   - caller is an authorized_caller (done in step 2)
  //   - caller.require_auth() — deployer signs
  // Effect: credits TREASURY's internal vault balance by SEED_AMOUNT without
  //         any on-chain token transfer.  Designed for bridge-style inflows.
  log.step(3, `Credit treasury with ${SEED_AMOUNT_NATIVE / 10_000_000n} USDC`);
  await invoke(rpc, deployerKp, VAULT, "credit", [
    enc.addr(DEPLOYER),      // caller  (authorized + signer)
    enc.addr(TREASURY),      // user    (address to credit)
    enc.addr(USDC_SAC),      // token
    enc.i128(SEED_AMOUNT_NATIVE), // amount in native 7-dp USDC units
  ]);

  // ── Step 4: Verify ───────────────────────────────────────────────────────
  log.step(4, "Verify treasury vault balance after seed");
  const newBal = await simRead(rpc, DEPLOYER, VAULT, "get_balance", [
    enc.addr(TREASURY),
    enc.addr(USDC_SAC),
  ]);
  log.ok(`treasury vault balance (18-dp) after seed: ${newBal}`);

  // Expect: SEED_AMOUNT_NATIVE * 10^11 = 10_000 * 10^18 (in 18-dp)
  const expectedInternal = SEED_AMOUNT_NATIVE * 10n ** 11n;
  const actualInternal   = BigInt(newBal ?? 0n);
  if (actualInternal < expectedInternal / 2n) {
    log.warn(`Balance lower than expected (${actualInternal} < ${expectedInternal / 2n}). Check for deposit cap.`);
  } else {
    log.ok(`Seed confirmed — close_position simulations should now succeed for profitable trades.`);
  }

  console.log("\n\x1b[32;1m✓ Treasury vault seed complete.\x1b[0m");
  console.log("\nNext steps:");
  console.log("  1. Retry your close_position — it should now succeed.");
  console.log("  2. For the permanent code fix (explicit close-fee accounting):");
  console.log("       make optimize && bash scripts/upgrade-testnet.sh");
}

main().catch((e) => {
  console.error("\n\x1b[31;1m✗ FAILED:\x1b[0m", e?.stack ?? e?.message ?? e);
  process.exit(1);
});
