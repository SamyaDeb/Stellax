#!/usr/bin/env node
/**
 * structured-settler.mjs
 *
 * Keeper daemon that watches the StellaX structured (covered-call) vault and,
 * on each epoch expiry:
 *
 *   1. Calls `structured.roll_epoch()` to settle the expired epoch and start
 *      the next one.
 *   2. Reads the settled epoch's `premium` field.
 *   3. Calls `slp_vault.sweep_fees(premium)` to uplift the SLP NAV so that
 *      covered-call yield flows into the single SLP share class.
 *
 * This implements the unified HLP-style single-vault architecture where all
 * protocol yield (fees + funding + options premium) consolidates into one NAV.
 *
 * Usage:
 *   node scripts/structured-settler.mjs
 *   node scripts/structured-settler.mjs --interval 30   # poll every 30 s
 *   node scripts/structured-settler.mjs --dry-run        # simulate only
 *
 * Prerequisites:
 *   - `stellax-keeper` stellar CLI identity must be funded with XLM.
 *   - The keeper address must be authorised as a sweeper on the SLP vault:
 *       stellar contract invoke --id <slp_vault> --fn add_sweeper \
 *         --source stellax-deployer -- --caller <keeper_address>
 *   - deployments/testnet.json must contain contracts.slp_vault and
 *     contracts.structured.
 *
 * Environment:
 *   KEEPER_ALIAS  — stellar CLI key alias to use (default: stellax-keeper)
 *   RPC_URL       — Soroban RPC endpoint (default: testnet)
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

const __dirname   = dirname(fileURLToPath(import.meta.url));
const ROOT        = join(__dirname, "..");
const DEPLOY_FILE = join(ROOT, "deployments/testnet.json");

const RPC_URL    = process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";
const PASSPHRASE = Networks.TESTNET;
const KEY_ALIAS  = process.env.KEEPER_ALIAS ?? "stellax-keeper";

// ── CLI flags ─────────────────────────────────────────────────────────────────

const intervalArgIdx = process.argv.indexOf("--interval");
const POLL_INTERVAL_S = intervalArgIdx !== -1
  ? parseInt(process.argv[intervalArgIdx + 1] ?? "60", 10)
  : 60;
const DRY_RUN = process.argv.includes("--dry-run");

// ── Helpers ───────────────────────────────────────────────────────────────────

const log = {
  step: (n, t) => console.log(`\n\x1b[36m━━━ Step ${n} — ${t}\x1b[0m`),
  ok:   (m)    => console.log(`  \x1b[32m✓\x1b[0m ${m}`),
  info: (m)    => console.log(`  \x1b[2m${m}\x1b[0m`),
  warn: (m)    => console.log(`  \x1b[33m⚠\x1b[0m ${m}`),
  err:  (m)    => console.error(`  \x1b[31m✗\x1b[0m ${m}`),
  ts:   ()     => new Date().toISOString(),
};

function loadKey(alias) {
  const r = spawnSync("stellar", ["keys", "secret", alias], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(
      `stellar keys secret ${alias} failed:\n${r.stderr}\n\n` +
      "Create the key with: stellar keys generate --network testnet " + alias,
    );
  }
  const key = r.stdout.trim();
  if (!key.startsWith("S")) throw new Error(`Expected secret key starting with S, got: ${key.slice(0, 4)}…`);
  return key;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function i128(n) { return nativeToScVal(typeof n === "number" ? BigInt(n) : n, { type: "i128" }); }

function addrScVal(pubkey) {
  return new Address(pubkey).toScVal();
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
      log.ok(`${method} confirmed — tx ${send.hash.slice(0, 12)}…`);
      return r.returnValue ? scValToNative(r.returnValue) : undefined;
    }
    if (r.status === "FAILED") throw new Error(`tx ${method} FAILED: ${JSON.stringify(r)}`);
    if (Date.now() > deadline) throw new Error(`${method} timeout after 120s`);
  }
}

// ── Epoch state reader ────────────────────────────────────────────────────────
// get_epoch() returns a Soroban struct; scValToNative gives us a plain object
// with snake_case keys matching the Rust field names.
//
// EpochState {
//   epoch_id:     u64
//   start_time:   u64  (unix secs)
//   end_time:     u64  (unix secs)
//   strike:       i128 (7-decimal oracle price)
//   option_id:    u64
//   total_assets: i128
//   premium:      i128
//   settled:      bool
// }

async function readEpoch(rpc, keeperPubkey, STRUCTURED) {
  const raw = await simRead(rpc, keeperPubkey, STRUCTURED, "get_epoch");
  if (raw === null) return null;
  return raw;
}

// ── Single settle pass ────────────────────────────────────────────────────────

async function settleIfReady(rpc, keeperKp, STRUCTURED, SLP_VAULT) {
  const KEEPER = keeperKp.publicKey();
  const nowSec = BigInt(Math.floor(Date.now() / 1000));

  // 1. Read current epoch
  const epoch = await readEpoch(rpc, KEEPER, STRUCTURED);
  if (epoch === null) {
    log.warn("get_epoch returned null — structured contract may not be initialised.");
    return;
  }

  const endTime  = BigInt(epoch.end_time ?? epoch.endTime ?? 0);
  const settled  = Boolean(epoch.settled);
  const epochId  = epoch.epoch_id ?? epoch.epochId ?? "?";
  const premium  = BigInt(epoch.premium ?? 0);

  log.info(`[${log.ts()}] epoch #${epochId} | end_time ${endTime} | now ${nowSec} | settled ${settled} | premium ${premium}`);

  if (settled) {
    log.info("Epoch already settled — nothing to do.");
    return;
  }

  if (endTime > nowSec) {
    const remainSec = Number(endTime - nowSec);
    log.info(`Epoch still active — ${remainSec}s remaining.`);
    return;
  }

  // Epoch has expired and is not yet settled.
  log.ok(`Epoch #${epochId} expired. Proceeding with roll.`);

  // 2. Roll epoch
  if (DRY_RUN) {
    log.warn("[DRY RUN] Would call roll_epoch() now.");
  } else {
    log.step(1, "roll_epoch");
    await invoke(rpc, keeperKp, STRUCTURED, "roll_epoch", [addrScVal(KEEPER)]);
  }

  // 3. Read premium from the just-settled epoch
  //    After roll_epoch the contract starts a new epoch; the settled premium
  //    is still readable from the previous state or returned by roll_epoch.
  //    We read it from what we already have (captured before the roll).
  if (premium <= 0n) {
    log.info("Epoch premium is 0 — nothing to sweep.");
    return;
  }

  log.info(`Premium to sweep: ${premium} (7-dec USDC = ${Number(premium) / 1e7} USDC)`);

  // 4. Sweep premium into SLP vault
  if (DRY_RUN) {
    log.warn(`[DRY RUN] Would call sweep_fees(${premium}) on SLP vault.`);
  } else {
    log.step(2, `sweep_fees(${premium}) → SLP vault`);
    try {
      await invoke(rpc, keeperKp, SLP_VAULT, "sweep_fees", [i128(premium)]);
      log.ok(`SLP NAV uplifted by ${Number(premium) / 1e7} USDC.`);
    } catch (err) {
      log.err(`sweep_fees failed: ${err.message}`);
      log.warn(
        "Pre-condition: keeper must be authorised as a sweeper on the SLP vault.\n" +
        "  Fix: stellar contract invoke --id " + SLP_VAULT + " --fn add_sweeper \\\n" +
        "    --source stellax-deployer -- --caller " + KEEPER,
      );
    }
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n\x1b[1mStellaX — Structured Settler Keeper\x1b[0m");
  if (DRY_RUN) console.log("\x1b[33m[DRY RUN MODE — no transactions will be submitted]\x1b[0m");

  const deploy = JSON.parse(readFileSync(DEPLOY_FILE, "utf8"));
  const STRUCTURED = deploy.contracts?.structured;
  const SLP_VAULT  = deploy.contracts?.slp_vault;

  if (!STRUCTURED) throw new Error("deployments/testnet.json missing contracts.structured");
  if (!SLP_VAULT)  throw new Error("deployments/testnet.json missing contracts.slp_vault");

  log.info(`structured : ${STRUCTURED}`);
  log.info(`slp_vault  : ${SLP_VAULT}`);
  log.info(`poll every : ${POLL_INTERVAL_S}s`);

  const keeperKp = Keypair.fromSecret(loadKey(KEY_ALIAS));
  log.info(`keeper     : ${keeperKp.publicKey()}`);

  const rpc = new SorobanRpc.Server(RPC_URL, { allowHttp: false });

  log.ok("Keeper started. Entering poll loop…\n");

  for (;;) {
    try {
      await settleIfReady(rpc, keeperKp, STRUCTURED, SLP_VAULT);
    } catch (err) {
      log.err(`settleIfReady threw: ${err.message}`);
    }
    await sleep(POLL_INTERVAL_S * 1000);
  }
}

main().catch((err) => {
  console.error("\n\x1b[31mFatal:\x1b[0m", err.message);
  process.exit(1);
});
