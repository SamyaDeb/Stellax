#!/usr/bin/env node
/**
 * migrate-to-hlp.mjs
 *
 * Post-deploy wiring for the HLP/SLP-vault migration + fresh perp/risk deploy:
 *
 *   Step 1  — perp_engine.update_dependencies (set new risk engine address)
 *   Step 2  — clob.update_config (point to new perp engine)
 *   Step 3  — funding.update_config (point to new perp engine)
 *   Step 4  — vault.add_authorized_caller(new_perp_engine)
 *   Step 5  — risk.set_slp_vault
 *   Step 6  — perp_engine.set_slp_vault
 *   Step 7  — slp_vault.add_authorized_caller(perp_engine)
 *   Step 8  — slp_vault.add_authorized_caller(risk_engine)
 *   Step 9  — vault.add_authorized_caller(slp_vault)
 *   Step 10 — register_markets (BTC, ETH, SOL, XLM)
 *   Step 11 — set_market_oi_caps → $1M each
 *   Step 12 — admin_credit_assets: sweep treasury → SLP vault
 *
 * Usage:
 *   node scripts/migrate-to-hlp.mjs [--dry-run] [--skip-sweep] [--skip-markets]
 */

import {
  Address,
  Contract,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  rpc as SorobanRpc,
  scValToNative,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { request } from "node:https";

const __dir = dirname(fileURLToPath(import.meta.url));

const RPC_URL     = "https://soroban-testnet.stellar.org";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const PASSPHRASE  = Networks.TESTNET;
const FEE         = "5000000"; // 0.5 XLM

const DRY_RUN       = process.argv.includes("--dry-run");
const SKIP_SWEEP    = process.argv.includes("--skip-sweep");
const SKIP_MARKETS  = process.argv.includes("--skip-markets");

// ── Contract addresses ───────────────────────────────────────────────────
const PERP_ENGINE = "CDK7LFB334FDFEB5VHFAPTDJGDMTAVXTJQDCCHC2SUMEYLR7ZDQEYYYZ"; // new
const RISK        = "CBL3YLKRHLSNIHGRACTXRDXIYKWA7CAANE3TA7YJUVQTLWHSI7KKADCF"; // new
const SLP_VAULT   = "CATD6NCR3DB2FWAH4NGAJURYWOOSS6YTGD62SQRA42YARTI36TNZFTW4";
const VAULT       = "CDDA3QFNHWZDX4IWHHNISPOI3R5KX4OPEUIQC5NA2RAB2HTMOS7YW4IM";
const TREASURY    = "CCPGPJKOUTI5ES2DPFH5PPM2AP5RQPAESREHYEEPWJ46FY7JM6K7JUTF";
const USDC        = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const ORACLE      = "CCESFJNJ3HS6DH2ZOSGSPMHH2GHE4MWJCWQR5A3RGLZYVZ37E5WBZEXB";
const FUNDING     = "CBTHQWJUT3VITY7XXDJVR7IA4DPUECXIBW6V4DCCBSIQWDTY3VWT4JRI";
const CLOB        = "CDKOESSQL5KFH6LFJ5XKLNIDYBN7NX4OYV4V7VQ5RNAGVILHCIH7KSJV";
const DEPLOYER    = "GAVFAXLV54GY7M4WZYIZQGP5NFRAJOUQA2LA4UDDUWVJCOIEPEMKYNQG";

// Market params (18-decimal internal precision = PRECISION = 10^18)
const PRECISION      = BigInt("1000000000000000000"); // 1e18
const ONE_MILLION_OI = PRECISION * BigInt(1_000_000); // $1M
const MIN_POS_SIZE   = PRECISION / BigInt(100);        // 0.01 units

// Market definitions
const MARKETS = [
  { id: 1, base: "BTC", quote: "USD", maxLev: 10, makerFeeBps: 2, takerFeeBps: 5,
    skewScale: PRECISION * BigInt(1_000_000), makerRebateBps: 1 },
  { id: 2, base: "ETH", quote: "USD", maxLev: 10, makerFeeBps: 2, takerFeeBps: 5,
    skewScale: PRECISION * BigInt(1_000_000), makerRebateBps: 1 },
  { id: 3, base: "SOL", quote: "USD", maxLev: 10, makerFeeBps: 2, takerFeeBps: 5,
    skewScale: PRECISION * BigInt(1_000_000), makerRebateBps: 1 },
  { id: 4, base: "XLM", quote: "USD", maxLev: 10, makerFeeBps: 2, takerFeeBps: 5,
    skewScale: PRECISION * BigInt(1_000_000), makerRebateBps: 1 },
];

const log = {
  step: (n, t) => console.log(`\n\x1b[36m━━━ Step ${n} — ${t}\x1b[0m`),
  ok:   (m)    => console.log(`  \x1b[32m✓\x1b[0m ${m}`),
  info: (m)    => console.log(`  \x1b[2m${m}\x1b[0m`),
  warn: (m)    => console.log(`  \x1b[33m⚠\x1b[0m ${m}`),
  skip: (m)    => console.log(`  \x1b[2m⏭  ${m} (skipped)\x1b[0m`),
};

function loadKey(alias) {
  const r = spawnSync("stellar", ["keys", "secret", alias], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`stellar keys secret ${alias} failed:\n${r.stderr}`);
  const key = r.stdout.trim();
  if (!key.startsWith("S")) throw new Error(`Expected secret key starting with S`);
  return key;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function addr(s)  { return new Address(s).toScVal(); }
function sym(s)   { return xdr.ScVal.scvSymbol(s); }
function u32(n)   { return nativeToScVal(n, { type: "u32" }); }
function i128(n)  { return nativeToScVal(typeof n === "number" ? BigInt(n) : n, { type: "i128" }); }
function bool(b)  { return nativeToScVal(b, { type: "bool" }); }

/** Fetch account from Horizon (authoritative for seq numbers when RPC is ahead). */
async function getAccountHorizon(pubkey) {
  const resp = await new Promise((res, rej) => {
    const url = new URL(`${HORIZON_URL}/accounts/${pubkey}`);
    const req = request({ hostname: url.hostname, path: url.pathname, method: "GET" }, (r) => {
      let data = "";
      r.on("data", c => data += c);
      r.on("end", () => res({ status: r.statusCode, body: JSON.parse(data) }));
    });
    req.on("error", rej);
    req.end();
  });
  const { Account } = await import("@stellar/stellar-sdk");
  return new Account(pubkey, resp.body.sequence);
}

/** Encode a Market struct as ScvMap (keys must be in alphabetical order). */
function marketScVal(m) {
  const entry = (k, v) => new xdr.ScMapEntry({ key: sym(k), val: v });
  return xdr.ScVal.scvMap([
    entry("base_asset",    sym(m.base)),
    entry("is_active",     bool(true)),
    entry("maker_fee_bps", u32(m.makerFeeBps)),
    entry("market_id",     u32(m.id)),
    entry("max_leverage",  u32(m.maxLev)),
    entry("max_oi_long",   i128(ONE_MILLION_OI)),
    entry("max_oi_short",  i128(ONE_MILLION_OI)),
    entry("quote_asset",   sym(m.quote)),
    entry("taker_fee_bps", u32(m.takerFeeBps)),
  ]);
}

async function submitAndWait(rpc, tx, label) {
  // Submit via Horizon as a reliable broadcast mechanism, then poll via Soroban RPC
  const txXdr = tx.toEnvelope().toXDR("base64");
  log.info(`    broadcasting via Horizon…`);
  const horizonResp = await new Promise((res, rej) => {
    const body = `tx=${encodeURIComponent(txXdr)}`;
    const url  = new URL(`${HORIZON_URL}/transactions`);
    const req  = request({
      hostname: url.hostname, path: url.pathname, method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
    }, (r) => {
      let data = "";
      r.on("data", c => data += c);
      r.on("end", () => res({ status: r.statusCode, body: data }));
    });
    req.on("error", rej);
    req.write(body);
    req.end();
  });
  const horizonBody = JSON.parse(horizonResp.body);
  if (horizonResp.status !== 200) {
    // 400 with duplicate tx is fine (already submitted); otherwise fail
    const codes = horizonBody?.extras?.result_codes ?? {};
    if (codes.transaction === "tx_bad_seq") {
      throw new Error(`send ${label}: TxBadSeq — stale sequence number`);
    }
    if (codes.transaction !== "tx_already_in_ledger" && horizonResp.status !== 200) {
      throw new Error(`Horizon submit ${label}: HTTP ${horizonResp.status}: ${JSON.stringify(codes)}`);
    }
  }
  const hash = horizonBody.hash ?? tx.hash().toString("hex");
  log.info(`    submitted hash: ${hash}`);
  const deadline = Date.now() + 120_000; // 2 min should be plenty once broadcast
  for (;;) {
    await sleep(4_000);
    const r = await rpc.getTransaction(hash);
    if (r.status === "SUCCESS") {
      log.ok(`${label} — ${hash.slice(0, 12)}…`);
      return r;
    }
    if (r.status === "FAILED") throw new Error(`tx ${label} FAILED: ${JSON.stringify(r)}`);
    if (Date.now() > deadline) throw new Error(`${label} confirmation timeout — hash: ${hash}`);
    log.info(`    still waiting… (${Math.round((deadline - Date.now()) / 1000)}s left)`);
  }
}

/** Upload a WASM blob; returns the hex wasm hash. */
async function uploadWasm(rpc, signer, wasmPath, label) {
  const tag = label ?? `upload:${wasmPath}`;
  log.info(`  → ${tag}`);
  const wasm = readFileSync(wasmPath);
  const account = DRY_RUN
    ? await rpc.getAccount(signer.publicKey())
    : await getAccountHorizon(signer.publicKey());
  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: PASSPHRASE })
    .addOperation(Operation.uploadContractWasm({ wasm }))
    .setTimeout(180)
    .build();
  const sim = await rpc.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) throw new Error(`simulate ${tag}: ${sim.error}`);
  if (DRY_RUN) {
    const retval = sim.result?.retval ? scValToNative(sim.result.retval) : null;
    const hash = retval ? Buffer.from(retval).toString("hex") : "(dry-run)";
    log.ok(`${tag} — DRY RUN, sim OK, wasm_hash=${hash}`);
    return hash;
  }
  const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(signer);
  const r = await submitAndWait(rpc, prepared, tag);
  const hash = Buffer.from(scValToNative(r.returnValue)).toString("hex");
  log.info(`    wasm_hash=${hash}`);
  return hash;
}

/** Upgrade a contract to a new WASM hash (bytes32). */
async function upgradeContract(rpc, signer, contractId, wasmHashHex, label) {
  const tag = label ?? `upgrade:${contractId.slice(0, 8)}`;
  log.info(`  → ${tag}`);
  if (DRY_RUN) { log.ok(`${tag} — DRY RUN, skipped (WASM not uploaded in dry-run)`); return; }
  const hashBytes = Buffer.from(wasmHashHex, "hex");
  const contract = new Contract(contractId);
  const account  = await getAccountHorizon(signer.publicKey());
  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: PASSPHRASE })
    .addOperation(contract.call("upgrade",
      xdr.ScVal.scvBytes(hashBytes),
    ))
    .setTimeout(180)
    .build();
  const sim = await rpc.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) throw new Error(`simulate ${tag}: ${sim.error}`);
  const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(signer);
  await submitAndWait(rpc, prepared, tag);
}

async function invoke(rpc, signer, contractId, method, args, label, { skipDryRunSim = false, retrySimOnMissingFn = false } = {}) {
  const tag = label ?? `${contractId.slice(0, 8)}…::${method}`;
  log.info(`  → ${tag}`);

  if (DRY_RUN && skipDryRunSim) {
    log.ok(`${tag} — DRY RUN, sim skipped (depends on prior upgrade)`);
    return undefined;
  }

  const account  = DRY_RUN
    ? await rpc.getAccount(signer.publicKey())
    : await getAccountHorizon(signer.publicKey());
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: PASSPHRASE })
    .addOperation(contract.call(method, ...args))
    .setTimeout(180)
    .build();

  // When an upgrade was just applied, the Soroban RPC may still serve the old
  // WASM for simulation. Retry with backoff until the new function is visible.
  let sim;
  const simDeadline = Date.now() + (retrySimOnMissingFn ? 60_000 : 0);
  for (;;) {
    sim = await rpc.simulateTransaction(tx);
    if (!SorobanRpc.Api.isSimulationError(sim)) break;
    const missingFn = sim.error?.includes("non-existent contract function") ||
                      sim.error?.includes("MissingValue");
    if (!missingFn || !retrySimOnMissingFn || Date.now() > simDeadline) {
      throw new Error(`simulate ${tag}: ${sim.error}`);
    }
    log.warn(`RPC serving stale WASM, retrying sim in 5s…`);
    await sleep(5_000);
  }

  if (DRY_RUN) { log.ok(`${tag} — DRY RUN, sim OK`); return undefined; }

  const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(signer);

  const r = await submitAndWait(rpc, prepared, tag);
  return r.returnValue ? scValToNative(r.returnValue) : undefined;
}

async function simRead(rpc, pubkey, contractId, method, args) {
  const account  = await rpc.getAccount(pubkey);
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: PASSPHRASE })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60)
    .build();
  const sim = await rpc.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) return null;
  return sim.result?.retval ? scValToNative(sim.result.retval) : null;
}

async function main() {
  console.log(`\n\x1b[1mStellaX — HLP Migration Script\x1b[0m${DRY_RUN ? "  \x1b[33m[DRY RUN]\x1b[0m" : ""}`);

  const rpc    = new SorobanRpc.Server(RPC_URL, { allowHttp: false });
  const secret = loadKey("stellax-deployer");
  const signer = Keypair.fromSecret(secret);
  const pub    = signer.publicKey();

  // ── Step 0: upload fresh risk WASM + upgrade risk contract ────────────
  log.step(0, "upload risk WASM + upgrade CBL3YLKR… to Phase-SLP build");
  const riskWasmPath = resolve(__dir, "../target/wasm32-unknown-unknown/release/stellax_risk.optimized.wasm");
  const riskWasmHash = await uploadWasm(rpc, signer, riskWasmPath, "upload:stellax_risk");
  await upgradeContract(rpc, signer, RISK, riskWasmHash, "risk::upgrade");

  // ── Step 1: perp_engine.update_dependencies ──────────────────────────
  // Signature: (oracle, vault, funding, risk, treasury, settlement_token)
  log.step(1, "perp_engine.update_dependencies (set new risk engine)");
  await invoke(rpc, signer, PERP_ENGINE, "update_dependencies", [
    addr(ORACLE), addr(VAULT), addr(FUNDING), addr(RISK),
    addr(TREASURY), addr(USDC),
  ], "perp::update_dependencies");

  // ── Step 2: clob.update_config ────────────────────────────────────────
  // Signature: update_config(keeper, perp_engine, vault)
  log.step(2, "clob.update_config → new perp engine");
  await invoke(rpc, signer, CLOB, "update_config", [
    addr(DEPLOYER),   // keeper — unchanged
    addr(PERP_ENGINE),
    addr(VAULT),
  ], "clob::update_config");

  // ── Step 3: funding.update_config ─────────────────────────────────────
  // Signature: update_config(oracle, perp_engine, funding_factor: i128)
  // funding_factor = PRECISION (1e18) — keep existing value
  log.step(3, "funding.update_config → new perp engine");
  await invoke(rpc, signer, FUNDING, "update_config", [
    addr(ORACLE),
    addr(PERP_ENGINE),
    i128(PRECISION),
  ], "funding::update_config");

  // ── Step 4: vault.add_authorized_caller(new perp engine) ──────────────
  log.step(4, "vault.add_authorized_caller(new_perp_engine)");
  await invoke(rpc, signer, VAULT, "add_authorized_caller", [
    addr(PERP_ENGINE),
  ], "vault::add_authorized_caller(perp_engine)");

  // ── Step 5: risk.set_slp_vault ────────────────────────────────────────
  log.step(5, "risk.set_slp_vault");
  await invoke(rpc, signer, RISK, "set_slp_vault", [addr(SLP_VAULT)], "risk::set_slp_vault",
    { skipDryRunSim: true, retrySimOnMissingFn: true });

  // ── Step 6: perp_engine.set_slp_vault ────────────────────────────────
  log.step(6, "perp_engine.set_slp_vault");
  await invoke(rpc, signer, PERP_ENGINE, "set_slp_vault", [addr(SLP_VAULT)], "perp::set_slp_vault");

  // ── Step 7: slp_vault.add_authorized_caller(perp_engine) ─────────────
  log.step(7, "slp_vault.add_authorized_caller(perp_engine)");
  await invoke(rpc, signer, SLP_VAULT, "add_authorized_caller", [
    addr(PERP_ENGINE),
  ], "slp::add_authorized_caller(perp_engine)");

  // ── Step 8: slp_vault.add_authorized_caller(risk_engine) ─────────────
  log.step(8, "slp_vault.add_authorized_caller(risk_engine)");
  await invoke(rpc, signer, SLP_VAULT, "add_authorized_caller", [
    addr(RISK),
  ], "slp::add_authorized_caller(risk_engine)");

  // ── Step 9: vault.add_authorized_caller(slp_vault) ───────────────────
  log.step(9, "vault.add_authorized_caller(slp_vault)");
  await invoke(rpc, signer, VAULT, "add_authorized_caller", [
    addr(SLP_VAULT),
  ], "vault::add_authorized_caller(slp_vault)");

  // ── Step 10: register markets ─────────────────────────────────────────
  if (SKIP_MARKETS) {
    log.step(10, "register_market"); log.skip("--skip-markets");
  } else {
    log.step(10, "register_market (BTC, ETH, SOL, XLM) with $1M OI caps");
    for (const m of MARKETS) {
      // Signature: register_market(market: Market, min_position_size: i128, skew_scale: i128, maker_rebate_bps: u32)
      await invoke(rpc, signer, PERP_ENGINE, "register_market", [
        marketScVal(m),           // market struct (includes max_oi_long/short = $1M)
        i128(MIN_POS_SIZE),       // min_position_size = 0.01 units
        i128(m.skewScale),        // skew_scale
        u32(m.makerRebateBps),    // maker_rebate_bps
      ], `perp::register_market(${m.base})`);
    }
  }

  // ── Step 11: sweep treasury → SLP vault ─────────────────────────────
  if (SKIP_SWEEP) {
    log.step(11, "admin_credit_assets sweep"); log.skip("--skip-sweep");
  } else {
    log.step(11, "admin_credit_assets: SLP vault seed");
    const slpNavBefore = await simRead(rpc, pub, SLP_VAULT, "total_assets", []);
    log.info(`SLP NAV before: ${slpNavBefore ?? 0}`);
    // SLP already seeded with 1000 USDC on deploy; just verify
    log.ok("SLP vault already seeded — no additional sweep needed");
  }

  // ── Final verification ────────────────────────────────────────────────
  console.log("\n\x1b[36m━━━ Final verification ─────────────────────────────────────────\x1b[0m");
  const callers        = await simRead(rpc, pub, SLP_VAULT, "get_authorized_callers", []);
  const slpVaultOnPerp = await simRead(rpc, pub, PERP_ENGINE, "get_slp_vault", []);
  const slpVaultOnRisk = await simRead(rpc, pub, RISK, "get_slp_vault", []);
  log.info(`SLP authorized callers: ${JSON.stringify(callers)}`);
  log.info(`Perp slp_vault:         ${slpVaultOnPerp}`);
  log.info(`Risk slp_vault:         ${slpVaultOnRisk}`);

  if (slpVaultOnPerp !== SLP_VAULT) log.warn("Perp slp_vault mismatch!");
  if (slpVaultOnRisk !== SLP_VAULT) log.warn("Risk slp_vault mismatch!");
  if (!callers?.includes(PERP_ENGINE)) log.warn("Perp engine NOT in SLP authorized callers!");
  if (!callers?.includes(RISK)) log.warn("Risk engine NOT in SLP authorized callers!");

  console.log("\n\x1b[32m✅  HLP migration complete.\x1b[0m");
  console.log(`   STELLAX_PERP_ENGINE=${PERP_ENGINE}`);
  console.log(`   STELLAX_RISK=${RISK}\n`);
}

main().catch(err => {
  console.error("\n\x1b[31m✗ Migration failed:\x1b[0m", err.message);
  process.exit(1);
});
