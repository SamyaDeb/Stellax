#!/usr/bin/env node
/**
 * smoke-test-hlp.mjs
 *
 * End-to-end HLP P&L flow verification on testnet:
 *   1. Record SLP total_assets baseline
 *   2. Open a BTC long  ($20 notional, 10x leverage)
 *      → open fee credited to SLP  (NAV ↑)
 *   3. Push BTC price +1% via admin_push_price
 *   4. Close the position  → deployer profits → SLP draws down (NAV ↓)
 *   5. Assert:
 *        • deployer_balance_after > deployer_balance_before  (profit received)
 *        • slp_total_assets_after_close < slp_total_assets_after_open  (profit paid)
 *
 * Usage:  node scripts/smoke-test-hlp.mjs
 */

import {
  Address, Contract, Keypair, Networks, TransactionBuilder,
  rpc as SorobanRpc, scValToNative, nativeToScVal, xdr,
} from "@stellar/stellar-sdk";
import { spawnSync } from "node:child_process";
import { request }   from "node:https";

const RPC_URL     = "https://soroban-testnet.stellar.org";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const PASSPHRASE  = Networks.TESTNET;
const FEE         = "5000000";

const DEPLOYER    = "GAVFAXLV54GY7M4WZYIZQGP5NFRAJOUQA2LA4UDDUWVJCOIEPEMKYNQG";
const PERP_ENGINE = "CDK7LFB334FDFEB5VHFAPTDJGDMTAVXTJQDCCHC2SUMEYLR7ZDQEYYYZ";
const ORACLE      = "CCESFJNJ3HS6DH2ZOSGSPMHH2GHE4MWJCWQR5A3RGLZYVZ37E5WBZEXB";
const SLP_VAULT   = "CATD6NCR3DB2FWAH4NGAJURYWOOSS6YTGD62SQRA42YARTI36TNZFTW4";
const VAULT       = "CDDA3QFNHWZDX4IWHHNISPOI3R5KX4OPEUIQC5NA2RAB2HTMOS7YW4IM";
const USDC        = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

const BTC_MARKET_ID = 1;
const LEVERAGE      = 10;
// $20 notional; size (BTC, 18dp) computed from live oracle price
const NOTIONAL_18DP = BigInt("20000000000000000000"); // $20

const log = {
  step: (t)  => console.log(`\n\x1b[36m━━━ ${t}\x1b[0m`),
  ok:   (m)  => console.log(`  \x1b[32m✓\x1b[0m ${m}`),
  info: (m)  => console.log(`  \x1b[2m${m}\x1b[0m`),
  warn: (m)  => console.log(`  \x1b[33m⚠\x1b[0m ${m}`),
  fail: (m)  => { console.error(`\n\x1b[31m✗ FAIL\x1b[0m  ${m}\n`); process.exit(1); },
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function addr(s)  { return new Address(s).toScVal(); }
function sym(s)   { return nativeToScVal(s, { type: "symbol" }); }
function u32(n)   { return nativeToScVal(n, { type: "u32" }); }
function u64(n)   { return nativeToScVal(typeof n === "bigint" ? n : BigInt(n), { type: "u64" }); }
function i128(n)  { return nativeToScVal(typeof n === "bigint" ? n : BigInt(n), { type: "i128" }); }
function bool(b)  { return nativeToScVal(b, { type: "bool" }); }
// Option<Bytes> → None is represented as ScvVoid in Soroban
function optNone() { return xdr.ScVal.scvVoid(); }

function loadKey(alias) {
  const r = spawnSync("stellar", ["keys", "secret", alias], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`stellar keys secret ${alias}: ${r.stderr}`);
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

/** Simulate + assemble + sign + submit, with retry on ECONNRESET. */
async function invoke(rpc, signer, contractId, method, args, label, retries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const account  = await getAccountHorizon(signer.publicKey());
      const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: PASSPHRASE })
        .addOperation(new Contract(contractId).call(method, ...args)).setTimeout(180).build();
      const sim = await rpc.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(sim)) throw new Error(`simulate ${label}: ${sim.error}`);
      const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
      prepared.sign(signer);
      const r = await submitAndWait(rpc, prepared, label);
      return r.returnValue ? scValToNative(r.returnValue) : undefined;
    } catch (err) {
      if (attempt < retries && (err.message?.includes("ECONNRESET") || err.message?.includes("ECONNREFUSED"))) {
        log.warn(`${label} — network error (${err.message}); retry ${attempt}/${retries} in 5s…`);
        await sleep(5_000);
        continue;
      }
      throw err;
    }
  }
}

/** Simulation read with retry on transient network errors. */
async function simRead(rpc, pubkey, contractId, method, args, retries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const account  = await rpc.getAccount(pubkey);
      const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: PASSPHRASE })
        .addOperation(new Contract(contractId).call(method, ...args)).setTimeout(60).build();
      const sim = await rpc.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(sim)) return null;
      return sim.result?.retval ? scValToNative(sim.result.retval) : null;
    } catch (err) {
      if (attempt < retries && (err.message?.includes("ECONNRESET") || err.message?.includes("ECONNREFUSED"))) {
        await sleep(3_000); continue;
      }
      throw err;
    }
  }
}

async function main() {
  console.log("\x1b[1mStellaX — HLP Smoke Test\x1b[0m\n");
  const rpc    = new SorobanRpc.Server(RPC_URL);
  const signer = Keypair.fromSecret(loadKey("stellax-deployer"));

  // ── 1. Baseline ─────────────────────────────────────────────────────────
  log.step("1. Read baseline state");
  const [navBefore, btcPriceData, vaultBal0] = await Promise.all([
    simRead(rpc, DEPLOYER, SLP_VAULT, "total_assets", []),
    simRead(rpc, DEPLOYER, ORACLE,    "get_price",    [sym("BTC")]),
    simRead(rpc, DEPLOYER, VAULT,     "get_balance",  [addr(DEPLOYER), addr(USDC)]),
  ]);
  log.info(`SLP total_assets (before): ${navBefore}  (~${Number(navBefore ?? 0n) / 1e18} USDC)`);
  log.info(`Deployer vault balance:    ${vaultBal0}  (~${Number(vaultBal0 ?? 0n) / 1e18} USDC)`);
  log.info(`BTC oracle price:          ~$${Number(btcPriceData?.price ?? 0n) / 1e18}`);

  if (!navBefore || navBefore <= 0n) log.fail("SLP has no assets — seed it first");
  if (!btcPriceData?.price)          log.fail("BTC oracle price not available");

  const btcP0 = btcPriceData.price;  // 18dp
  const P18   = 10n ** 18n;
  // size (BTC, 18dp) s.t. notional = size * price / 1e18 = NOTIONAL_18DP
  const btcSize    = NOTIONAL_18DP * P18 / btcP0;
  const MARGIN_18DP = NOTIONAL_18DP / BigInt(LEVERAGE); // $2
  log.info(`BTC size: ${btcSize}  (~${Number(btcSize) / 1e18} BTC)`);
  log.info(`Margin:   ${MARGIN_18DP}  (~${Number(MARGIN_18DP) / 1e18} USDC)`);
  if (!vaultBal0 || vaultBal0 < MARGIN_18DP)
    log.fail(`Need ≥${Number(MARGIN_18DP)/1e18} USDC in vault, have ${Number(vaultBal0 ?? 0n)/1e18}`);

  // ── 2. Open BTC long ─────────────────────────────────────────────────────
  log.step("2. Open BTC long ($20 notional, 10x)");
  // open_position(user, market_id, size, is_long, leverage, max_slippage_bps, price_payload)
  const posId = await invoke(rpc, signer, PERP_ENGINE, "open_position", [
    addr(DEPLOYER),
    u32(BTC_MARKET_ID),
    i128(btcSize),
    bool(true),
    u32(LEVERAGE),
    u32(500),   // 5% slippage tolerance
    optNone(),
  ], "open_position(BTC long)");
  log.info(`position_id: ${posId}`);

  const navAfterOpen = await simRead(rpc, DEPLOYER, SLP_VAULT, "total_assets", []);
  log.info(`SLP total_assets (after open): ~${Number(navAfterOpen ?? 0n) / 1e18} USDC`);
  if (!navAfterOpen || navAfterOpen <= (navBefore ?? 0n))
    log.fail(`Open fee not credited to SLP. before=${navBefore} after=${navAfterOpen}`);
  log.ok(`Open fee → SLP: +${Number((navAfterOpen ?? 0n) - (navBefore ?? 0n)) / 1e18} USDC`);

  // ── 3. Push BTC price +1% ─────────────────────────────────────────────────
  log.step("3. Push BTC +1%");
  const btcP1 = btcP0 * 101n / 100n;
  // Must use a package_timestamp strictly greater than the last push
  const pkgTs = btcPriceData.package_timestamp + 1n;
  // admin_push_price(asset, price, package_timestamp_ms)
  await invoke(rpc, signer, ORACLE, "admin_push_price", [
    sym("BTC"), i128(btcP1), u64(pkgTs),
  ], `admin_push_price(BTC @ $${Number(btcP1) / 1e18})`);

  // ── 4. Close position → profit ───────────────────────────────────────────
  log.step("4. Close BTC long (expect profit → SLP pays out)");
  // close_position(user, position_id: u64, price_payload: Option<Bytes>)
  await invoke(rpc, signer, PERP_ENGINE, "close_position", [
    addr(DEPLOYER),
    u64(typeof posId === "bigint" ? posId : BigInt(posId ?? 1)),
    optNone(),
  ], "close_position");

  // ── 5. Verify ────────────────────────────────────────────────────────────
  log.step("5. Verify HLP P&L flow");
  const [navAfterClose, vaultBal1] = await Promise.all([
    simRead(rpc, DEPLOYER, SLP_VAULT, "total_assets", []),
    simRead(rpc, DEPLOYER, VAULT,     "get_balance",  [addr(DEPLOYER), addr(USDC)]),
  ]);
  log.info(`SLP total_assets (after close): ~${Number(navAfterClose ?? 0n) / 1e18} USDC`);
  log.info(`Deployer vault balance (after): ~${Number(vaultBal1 ?? 0n) / 1e18} USDC`);

  const profit = (vaultBal1 ?? 0n) - (vaultBal0 ?? 0n);
  const slpNet = (navAfterClose ?? 0n) - (navAfterOpen ?? 0n);
  log.info(`Deployer net P&L:     ${profit >= 0n ? "+" : ""}${Number(profit) / 1e18} USDC`);
  log.info(`SLP net (open→close): ${Number(slpNet) / 1e18} USDC`);

  if (profit <= 0n)
    log.fail(`Deployer did not profit. P&L=${Number(profit)/1e18} USDC`);
  if ((navAfterClose ?? 0n) >= (navAfterOpen ?? 0n))
    log.fail(`SLP NAV did not decrease. afterOpen=${navAfterOpen} afterClose=${navAfterClose}`);

  log.ok(`Deployer profit:   +${Number(profit) / 1e18} USDC`);
  log.ok(`SLP drawdown:       ${Number(slpNet) / 1e18} USDC`);
  console.log("\n\x1b[32m✅  HLP smoke test passed — full P&L flow verified.\x1b[0m\n");
}

main().catch(e => { console.error("\n\x1b[31m✗ Smoke test error:\x1b[0m", e.message); process.exit(1); });
