#!/usr/bin/env node
/**
 * fix-slp-wiring.mjs
 *
 * The SLP vault still has the OLD perp engine address in its config.perp_engine
 * field (CD3PV6GI…). The new perp engine (CDK7LFB3…) IS in authorized_callers,
 * so credit_pnl / draw_pnl auth passes, but the skew-cap OI check calls
 * get_open_interest on the OLD engine — causing WasmVm, MissingValue when
 * OI > 0 (i.e. any positions are open).
 *
 * Fix (two steps):
 *   1. set_skew_cap_bps(0)       — disable OI check immediately (unblocks trading)
 *   2. set_perp_engine(new_id)   — re-point the config field to the live engine
 *      (re-enables OI-based skew checks correctly once set_perp_engine exists)
 *
 * Usage:
 *   source deployments/testnet.env
 *   node scripts/fix-slp-wiring.mjs
 */

import {
  Address, Contract, Keypair, Networks, TransactionBuilder,
  rpc as SorobanRpc, scValToNative, nativeToScVal, xdr,
} from "@stellar/stellar-sdk";
import { spawnSync } from "node:child_process";
import { request }   from "node:https";

const RPC_URL    = "https://soroban-testnet.stellar.org";
const HORIZON    = "https://horizon-testnet.stellar.org";
const PASSPHRASE = Networks.TESTNET;
const FEE        = "5000000";

const DEPLOYER   = "GAVFAXLV54GY7M4WZYIZQGP5NFRAJOUQA2LA4UDDUWVJCOIEPEMKYNQG";
const SLP_VAULT  = "CATD6NCR3DB2FWAH4NGAJURYWOOSS6YTGD62SQRA42YARTI36TNZFTW4";
const NEW_PERP   = "CDK7LFB334FDFEB5VHFAPTDJGDMTAVXTJQDCCHC2SUMEYLR7ZDQEYYYZ";

const log = {
  step: (t) => console.log(`\n\x1b[36m━━━ ${t}\x1b[0m`),
  ok:   (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`),
  info: (m) => console.log(`  \x1b[2m${m}\x1b[0m`),
  warn: (m) => console.log(`  \x1b[33m⚠\x1b[0m ${m}`),
  fail: (m) => { console.error(`\n\x1b[31m✗ FAIL\x1b[0m  ${m}\n`); process.exit(1); },
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function addr(s)   { return new Address(s).toScVal(); }
function u32(n)    { return nativeToScVal(n, { type: "u32" }); }

function loadKey(alias) {
  const r = spawnSync("stellar", ["keys", "secret", alias], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`stellar keys secret ${alias}: ${r.stderr}`);
  const k = r.stdout.trim();
  if (!k.startsWith("S")) throw new Error("Expected secret key starting with S");
  return k;
}

async function getAccountHorizon(pubkey) {
  return new Promise((res, rej) => {
    const url = new URL(`${HORIZON}/accounts/${pubkey}`);
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
  const deadline = Date.now() + 60_000;
  for (;;) {
    await sleep(4_000);
    const r = await rpc.getTransaction(hash);
    if (r.status === "SUCCESS") { log.ok(label); return r; }
    if (r.status === "FAILED")  throw new Error(`${label} FAILED: ${JSON.stringify(r)}`);
    if (Date.now() > deadline)  throw new Error(`${label} timeout`);
  }
}

async function invoke(rpc, signer, contractId, method, args, label) {
  const account  = await getAccountHorizon(signer.publicKey());
  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args)).setTimeout(180).build();
  const sim = await rpc.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) throw new Error(`simulate ${label}: ${sim.error}`);
  const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(signer);
  return submitAndWait(rpc, prepared, label);
}

async function simRead(rpc, contractId, method, args = []) {
  const account = await rpc.getAccount(DEPLOYER);
  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args)).setTimeout(30).build();
  const sim = await rpc.simulateTransaction(tx);
  if ("error" in sim) return null;
  return scValToNative(sim.result?.retval);
}

// ─── Main ────────────────────────────────────────────────────────────────────

console.log("\x1b[1mStellaX — Fix SLP Wiring\x1b[0m\n");

const rpc    = new SorobanRpc.Server(RPC_URL);
const secret = loadKey("stellax-deployer");
const signer = Keypair.fromSecret(secret);
log.info(`Signer : ${signer.publicKey()}`);
log.info(`SLP    : ${SLP_VAULT}`);
log.info(`NewPerp: ${NEW_PERP}`);

// ── 1. Read current state ─────────────────────────────────────────────────

log.step("1. Read current SLP config");
const cfg = await simRead(rpc, SLP_VAULT, "get_config");
log.info(`  perp_engine (stored): ${cfg?.perp_engine}`);
log.info(`  skew_cap_bps        : ${cfg?.skew_cap_bps}`);
const callers = await simRead(rpc, SLP_VAULT, "get_authorized_callers");
log.info(`  authorized_callers  : ${JSON.stringify(callers)}`);

if (cfg?.perp_engine === NEW_PERP) {
  log.ok("perp_engine already points to new engine — nothing to update.");
} else {
  log.warn(`perp_engine mismatch:\n  stored : ${cfg?.perp_engine}\n  current: ${NEW_PERP}`);
}

// ── 2. Disable skew-cap OI check (set_skew_cap_bps = 0) ──────────────────
//
// The skew-cap check calls get_open_interest on config.perp_engine. Since
// that still points to the old engine, the cross-contract call panics when
// OI > 0.  Setting bps=0 disables the check entirely, unblocking trading.
//
// NOTE: if the contract has a set_perp_engine method we will call it in
// step 3 to re-enable skew checks correctly; otherwise bps=0 stays.

log.step("2. Disable skew-cap (set_skew_cap_bps → 0) to unblock trading");
await invoke(rpc, signer, SLP_VAULT, "set_skew_cap_bps", [u32(0)], "set_skew_cap_bps(0)");

// ── 3. Try set_perp_engine if available ───────────────────────────────────

log.step("3. Attempt set_perp_engine → new perp engine");
try {
  await invoke(rpc, signer, SLP_VAULT, "set_perp_engine", [addr(NEW_PERP)], `set_perp_engine(${NEW_PERP})`);

  // Re-enable skew cap now that the engine pointer is correct.
  log.step("4. Re-enable skew-cap (set_skew_cap_bps → 5000)");
  await invoke(rpc, signer, SLP_VAULT, "set_skew_cap_bps", [u32(5000)], "set_skew_cap_bps(5000)");
} catch (e) {
  log.warn(`set_perp_engine not available on this WASM (${e.message?.slice(0, 80)})`);
  log.warn("Skew-cap remains disabled (0 bps). Trading is unblocked.");
  log.warn("To re-enable skew-cap checks: upgrade SLP vault WASM with set_perp_engine, then run this script again.");
}

// ── 5. Verify ─────────────────────────────────────────────────────────────

log.step("5. Verify final config");
const cfgAfter = await simRead(rpc, SLP_VAULT, "get_config");
log.info(`  perp_engine  : ${cfgAfter?.perp_engine}`);
log.info(`  skew_cap_bps : ${cfgAfter?.skew_cap_bps}`);

const engineOk  = cfgAfter?.perp_engine === NEW_PERP;
const skewOk    = cfgAfter?.skew_cap_bps === 0 || cfgAfter?.perp_engine === NEW_PERP;

if (engineOk) {
  log.ok("perp_engine points to live engine ✓  skew-cap checks will work correctly.");
} else if (skewOk) {
  log.ok("Skew-cap disabled (0 bps) — trading unblocked. Re-point perp_engine when WASM supports it.");
} else {
  log.fail("Config still broken after fix attempt. Check contract WASM for admin methods.");
}

console.log("\n\x1b[32mDone. You can now open positions from the frontend.\x1b[0m\n");
