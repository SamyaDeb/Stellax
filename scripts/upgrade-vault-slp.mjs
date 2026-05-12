#!/usr/bin/env node
/**
 * upgrade-vault-slp.mjs
 *
 * Minimal upgrade script for the two HLP Phase-SLP changes:
 *
 *   Step 1  — Upload new stellax-vault WASM (current_token_total now includes
 *             SLP vault balance; no storage layout changes)
 *   Step 2  — vault.upgrade(new_wasm_hash)
 *   Step 3  — vault.set_sub_account(SlpPool, slp_vault_addr)
 *             (registers SLP vault so deposit-cap math is correct)
 *
 * stellax-risk WASM hash is UNCHANGED (credit_insurance was already dead-code
 * eliminated by the optimizer), so no risk upload/upgrade is performed.
 *
 * Usage:  node scripts/upgrade-vault-slp.mjs [--dry-run]
 */

import {
  Address, Contract, Keypair, Networks, Operation,
  TransactionBuilder, rpc as SorobanRpc, scValToNative, nativeToScVal, xdr,
} from "@stellar/stellar-sdk";
import { spawnSync }  from "node:child_process";
import { readFileSync } from "node:fs";
import { request }     from "node:https";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));

const RPC_URL     = "https://soroban-testnet.stellar.org";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const PASSPHRASE  = Networks.TESTNET;
const FEE         = "5000000";

const DRY_RUN = process.argv.includes("--dry-run");

const VAULT     = "CDDA3QFNHWZDX4IWHHNISPOI3R5KX4OPEUIQC5NA2RAB2HTMOS7YW4IM";
const SLP_VAULT = "CATD6NCR3DB2FWAH4NGAJURYWOOSS6YTGD62SQRA42YARTI36TNZFTW4";
const DEPLOYER  = "GAVFAXLV54GY7M4WZYIZQGP5NFRAJOUQA2LA4UDDUWVJCOIEPEMKYNQG";

const VAULT_WASM = resolve(__dir, "../target/wasm32-unknown-unknown/release/stellax_vault.optimized.wasm");

// SubAccountRole::SlpPool — must match the on-chain enum variant index.
// contracts/stellax-vault/src/lib.rs: Treasury=0, Insurance=1, SlpPool=2, FundingPool=3
// Soroban C-style enums are passed as ScvU32 with the discriminant value.
function slpPoolVariant() {
  return nativeToScVal(2, { type: "u32" });
}
function addr(s) { return new Address(s).toScVal(); }

const log = {
  step: (n, t) => console.log(`\n\x1b[36m━━━ Step ${n} — ${t}\x1b[0m`),
  ok:   (m)    => console.log(`  \x1b[32m✓\x1b[0m ${m}`),
  info: (m)    => console.log(`  \x1b[2m${m}\x1b[0m`),
  warn: (m)    => console.log(`  \x1b[33m⚠\x1b[0m ${m}`),
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadKey(alias) {
  const r = spawnSync("stellar", ["keys", "secret", alias], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`stellar keys secret ${alias}:\n${r.stderr}`);
  const k = r.stdout.trim();
  if (!k.startsWith("S")) throw new Error("Expected secret key starting with S");
  return k;
}

async function getAccountHorizon(pubkey) {
  return new Promise((res, rej) => {
    const url = new URL(`${HORIZON_URL}/accounts/${pubkey}`);
    const req = request({ hostname: url.hostname, path: url.pathname, method: "GET" }, (r) => {
      let data = ""; r.on("data", c => data += c);
      r.on("end", async () => {
        const { Account } = await import("@stellar/stellar-sdk");
        res(new Account(pubkey, JSON.parse(data).sequence));
      });
    });
    req.on("error", rej); req.end();
  });
}

async function submitAndWait(rpc, tx, label) {
  const txXdr = tx.toEnvelope().toXDR("base64");
  const body  = `tx=${encodeURIComponent(txXdr)}`;
  const hResp = await new Promise((res, rej) => {
    const req = request({
      hostname: "horizon-testnet.stellar.org", path: "/transactions", method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
    }, (r) => { let d = ""; r.on("data", c => d += c); r.on("end", () => res({ status: r.statusCode, body: JSON.parse(d) })); });
    req.on("error", rej); req.write(body); req.end();
  });
  if (hResp.status !== 200) {
    const codes = hResp.body?.extras?.result_codes ?? {};
    if (codes.transaction !== "tx_already_in_ledger")
      throw new Error(`Horizon ${label}: HTTP ${hResp.status} ${JSON.stringify(codes)}`);
  }
  const hash = hResp.body.hash ?? tx.hash().toString("hex");
  log.info(`    hash: ${hash}`);
  const deadline = Date.now() + 120_000;
  for (;;) {
    await sleep(4_000);
    const r = await rpc.getTransaction(hash);
    if (r.status === "SUCCESS") { log.ok(`${label}`); return r; }
    if (r.status === "FAILED") throw new Error(`${label} FAILED: ${JSON.stringify(r)}`);
    if (Date.now() > deadline) throw new Error(`${label} timeout — hash: ${hash}`);
    log.info(`    still waiting…`);
  }
}

async function invoke(rpc, signer, contractId, method, args, label) {
  const account = await getAccountHorizon(signer.publicKey());
  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args)).setTimeout(180).build();
  const sim = await rpc.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) throw new Error(`simulate ${label}: ${sim.error}`);
  if (DRY_RUN) { log.ok(`${label} — DRY RUN sim OK`); return null; }
  const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(signer);
  return submitAndWait(rpc, prepared, label);
}

async function uploadWasm(rpc, signer, wasmPath, label) {
  log.info(`  reading ${wasmPath}`);
  const wasm = readFileSync(wasmPath);
  const account = await getAccountHorizon(signer.publicKey());
  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: PASSPHRASE })
    .addOperation(Operation.uploadContractWasm({ wasm })).setTimeout(180).build();
  const sim = await rpc.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) throw new Error(`simulate ${label}: ${sim.error}`);
  // Wasm hash is the return value of UploadContractWasm
  const wasmHash = sim.result?.retval ? Buffer.from(scValToNative(sim.result.retval)).toString("hex") : null;
  log.info(`  new wasm_hash: ${wasmHash}`);
  if (DRY_RUN) { log.ok(`${label} — DRY RUN sim OK, hash=${wasmHash}`); return wasmHash; }
  const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(signer);
  const r = await submitAndWait(rpc, prepared, label);
  const confirmedHash = r.returnValue ? Buffer.from(scValToNative(r.returnValue)).toString("hex") : wasmHash;
  log.ok(`${label} → wasm_hash: ${confirmedHash}`);
  return confirmedHash;
}

async function main() {
  console.log("\x1b[1mStellaX — Vault SLP Upgrade\x1b[0m");
  if (DRY_RUN) console.log("\x1b[33m[DRY RUN — no transactions will be submitted]\x1b[0m");

  const rpc    = new SorobanRpc.Server(RPC_URL);
  const signer = Keypair.fromSecret(loadKey("stellax-deployer"));

  // ── Step 1: Upload new vault WASM ────────────────────────────────────────
  log.step(1, "Upload stellax-vault WASM (current_token_total + SLP vault)");
  const wasmHash = await uploadWasm(rpc, signer, VAULT_WASM, "upload stellax-vault");

  // ── Step 2: Upgrade vault contract ───────────────────────────────────────
  log.step(2, `vault.upgrade(${wasmHash})`);
  // upgrade(new_wasm_hash: BytesN<32>)
  const hashBytes = xdr.ScVal.scvBytes(Buffer.from(wasmHash, "hex"));
  await invoke(rpc, signer, VAULT, "upgrade", [hashBytes], "vault.upgrade");

  // ── Step 3: Register SLP vault as SlpPool sub-account ────────────────────
  log.step(3, `vault.set_sub_account(SlpPool, ${SLP_VAULT})`);
  // set_sub_account(role: SubAccountRole, account: Address)
  await invoke(rpc, signer, VAULT, "set_sub_account",
    [slpPoolVariant(), addr(SLP_VAULT)],
    "vault.set_sub_account(SlpPool)",
  );

  // ── Verify ────────────────────────────────────────────────────────────────
  log.step("✓", "Verify get_sub_account(SlpPool)");
  const result = await invoke(rpc, signer, VAULT, "get_sub_account",
    [slpPoolVariant()],
    "vault.get_sub_account(SlpPool)",
  );
  if (!DRY_RUN && result?.returnValue) {
    const registered = scValToNative(result.returnValue);
    if (registered === SLP_VAULT) {
      log.ok(`SlpPool sub-account confirmed: ${registered}`);
    } else {
      console.error(`\x1b[31m✗ MISMATCH: expected ${SLP_VAULT}, got ${registered}\x1b[0m`);
      process.exit(1);
    }
  }

  console.log("\n\x1b[32m✅  Vault SLP upgrade complete.\x1b[0m\n");
}

main().catch(e => { console.error("\n\x1b[31m✗ Upgrade error:\x1b[0m", e.message); process.exit(1); });
