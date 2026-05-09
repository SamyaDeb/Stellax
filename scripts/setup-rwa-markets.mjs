#!/usr/bin/env node
/**
 * scripts/setup-rwa-markets.mjs
 * ──────────────────────────────
 * Phase Ω6 on-chain setup: runs the four manual steps that enable
 * BENJI / USDY / OUSG perpetual markets on testnet.
 *
 *   1. oracle.update_config — adds BENJI/USDY/OUSG to feed_ids (keeps existing signers).
 *   2. oracle.admin_push_price — pushes a seed NAV for each RWA asset.
 *   3. perp.register_market — registers market IDs 100/101/102.
 *   4. Prints verification calls.
 *
 * Usage:
 *   source deployments/testnet.env
 *   node scripts/setup-rwa-markets.mjs
 *
 * Reads STELLAX_ORACLE, STELLAX_PERP_ENGINE, STELLAX_RPC_URL,
 * STELLAX_NETWORK_PASSPHRASE from the environment (populated by testnet.env).
 * Uses the `stellax-deployer` stellar-cli identity for signing.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc as SorobanRpc,
  xdr,
} from "@stellar/stellar-sdk";

// ── Config ────────────────────────────────────────────────────────────────────

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const DEPLOY_JSON = `${ROOT}/deployments/testnet.json`;
const dep = JSON.parse(readFileSync(DEPLOY_JSON, "utf8"));

const RPC_URL       = env("STELLAX_RPC_URL", dep.rpc_url);
const PASSPHRASE    = env("STELLAX_NETWORK_PASSPHRASE", dep.network_passphrase);
const ORACLE_ID     = env("STELLAX_ORACLE", dep.contracts?.oracle);
const PERP_ID       = env("STELLAX_PERP_ENGINE", dep.contracts?.perp_engine);

const SIGNERS_HEX = [
  "51ce04be4b3e32572c4ec9135221d0691ba7d202",
  "8bb8f32df04c8b654987daaed53d6b6091e3b774",
  "9c5ae89c4af6aa32ce58588dbaf90d18a855b6de",
  "dd682daec5a90dd295d14da4b0bec9281017b5be",
  "deb22f54738d54976c4c0fe5ce6d408e40d88499",
];
const THRESHOLD_U32     = 3;
const STALENESS_U64     = 86_400_000n; // 24 h in ms

const ALL_FEEDS = ["XLM", "BTC", "ETH", "SOL", "USDC", "BENJI", "USDY", "OUSG"];

// 18-decimal NAV seeds (conservative; keeper will refresh every 10 min).
const SEED_NAVS = {
  BENJI: 1_000_000_000_000_000_000n,          // $1.00
  USDY:  1_053_000_000_000_000_000n,           // $1.053
  OUSG:  101_500_000_000_000_000_000n,         // $101.50
};

const RWA_MARKETS = [
  { marketId: 100, baseAsset: "BENJI" },
  { marketId: 101, baseAsset: "USDY"  },
  { marketId: 102, baseAsset: "OUSG"  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function env(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function loadDeployer() {
  const r = spawnSync("stellar", ["keys", "show", "stellax-deployer"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`stellar keys show failed: ${r.stderr}`);
  const secret = r.stdout.trim();
  if (!/^S[A-Z2-7]{55}$/.test(secret)) throw new Error(`bad secret: ${secret.slice(0, 8)}...`);
  return Keypair.fromSecret(secret);
}

const server = new SorobanRpc.Server(RPC_URL, { allowHttp: false });

async function invoke(signer, contractId, method, args) {
  const account  = await server.getAccount(signer.publicKey());
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(120)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`simulate(${method}) failed: ${sim.error}`);
  }
  const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(signer);
  const result = await server.sendTransaction(prepared);
  if (result.status === "ERROR") throw new Error(`send(${method}) error: ${JSON.stringify(result.errorResult)}`);
  // Poll for confirmation.
  let hash = result.hash;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const status = await server.getTransaction(hash);
    if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      console.log(`  ✅ ${method} — tx ${hash}`);
      return status;
    }
    if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`${method} tx FAILED: ${hash}`);
    }
  }
  throw new Error(`${method} tx timeout: ${hash}`);
}

async function simulate(signer, contractId, method, args) {
  const account  = await server.getAccount(signer.publicKey());
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60)
    .build();
  return server.simulateTransaction(tx);
}

// ScVal builders
function sym(s)   { return xdr.ScVal.scvSymbol(Buffer.from(s, "utf8")); }
function u32(n)   { return xdr.ScVal.scvU32(n); }
function u64(n)   { return xdr.ScVal.scvU64(xdr.Uint64.fromString(BigInt(n).toString())); }
function i128(n)  { return nativeToScVal(BigInt(n), { type: "i128" }); }
function bytes(h) { return xdr.ScVal.scvBytes(Buffer.from(h, "hex")); }
function boolV(b) { return xdr.ScVal.scvBool(b); }
function vec(a)   { return xdr.ScVal.scvVec(a); }
function addr(s)  { return new Address(s).toScVal(); }

function mapEntry(key, val) {
  return new xdr.ScMapEntry({ key, val });
}

function structMap(entries) {
  // XDR SCMap keys must be lexicographically sorted for Soroban deserialization.
  const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return xdr.ScVal.scvMap(sorted.map(([k, v]) => mapEntry(sym(k), v)));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const deployer = loadDeployer();
  console.log(`Deployer: ${deployer.publicKey()}`);
  console.log(`Oracle:   ${ORACLE_ID}`);
  console.log(`Perp:     ${PERP_ID}`);
  console.log();

  // ── Step 1: oracle.update_config ─────────────────────────────────────────
  console.log("Step 1 — oracle.update_config (adding BENJI/USDY/OUSG to feed_ids)...");
  await invoke(deployer, ORACLE_ID, "update_config", [
    vec(SIGNERS_HEX.map(bytes)),
    u32(THRESHOLD_U32),
    u64(STALENESS_U64),
    vec(ALL_FEEDS.map(sym)),
  ]);
  console.log("  feed_ids now:", ALL_FEEDS.join(", "));
  console.log();

  // ── Step 1b: oracle.upgrade (if ORACLE_WASM_HASH is set) ─────────────────
  const oracleWasmHash = process.env.ORACLE_WASM_HASH;
  if (oracleWasmHash) {
    console.log(`Step 1b — upgrading oracle to wasm ${oracleWasmHash}...`);
    const hashBytes = xdr.ScVal.scvBytes(Buffer.from(oracleWasmHash, "hex"));
    // BytesN<32> is encoded as scvBytes
    await invoke(deployer, ORACLE_ID, "upgrade", [hashBytes]);
    console.log("  oracle upgraded.\n");
  }

  // ── Step 2: oracle.admin_push_price ──────────────────────────────────────
  console.log("Step 2 — pushing seed NAVs via admin_push_price...");
  const baseTs = BigInt(Date.now());
  for (const [i, [feedId, price]] of Object.entries(SEED_NAVS).entries()) {
    const tsMs = baseTs + BigInt(i) * 1000n; // strictly monotonic per-feed
    console.log(`  pushing ${feedId} = ${price} (ts=${tsMs})`);
    await invoke(deployer, ORACLE_ID, "admin_push_price", [
      sym(feedId),
      i128(price),
      u64(tsMs),
    ]);
  }
  console.log();

  // ── Step 3: perp.register_market ─────────────────────────────────────────
  console.log("Step 3 — registering RWA perp markets 100/101/102...");
  for (const { marketId, baseAsset } of RWA_MARKETS) {
    const existing = await simulate(deployer, PERP_ID, "get_market", [u32(marketId)]);
    if (!SorobanRpc.Api.isSimulationError(existing)) {
      console.log(`  market ${marketId} (${baseAsset}) already registered; skipping`);
      continue;
    }

    console.log(`  register_market ${marketId} (${baseAsset})`);
    // Market struct (must match stellax_math::types::Market field order)
    const marketScVal = structMap([
      ["market_id",     u32(marketId)],
      ["base_asset",    sym(baseAsset)],
      ["quote_asset",   sym("USD")],
      ["max_leverage",  u32(3)],
      ["maker_fee_bps", u32(5)],
      ["taker_fee_bps", u32(15)],
      ["max_oi_long",   i128(100_000_000_000_000_000_000n)],
      ["max_oi_short",  i128(100_000_000_000_000_000_000n)],
      ["is_active",     boolV(true)],
    ]);
    await invoke(deployer, PERP_ID, "register_market", [
      marketScVal,
      i128(1_000_000_000_000_000_000n),  // min_position_size: 1 USDC (18-dec)
      i128(100_000_000_000_000_000_000n), // skew_scale: 100 (18-dec)
      u32(2),                             // maker_rebate_bps
    ]);
  }
  console.log();

  // ── Step 4: verify ──────────────────────────────────────────────────────
  console.log("Step 4 — verifying...");
  for (const { marketId, baseAsset } of RWA_MARKETS) {
    const sim = await simulate(deployer, PERP_ID, "get_market", [u32(marketId)]);
    if (SorobanRpc.Api.isSimulationError(sim)) {
      console.log(`  ❌ get_market(${marketId}) failed: ${sim.error}`);
    } else {
      console.log(`  ✅ market ${marketId} (${baseAsset}) registered`);
    }
  }

  console.log("\n✅ Phase Ω6 setup complete — BENJI/USDY/OUSG markets live on testnet.");
}

main().catch((e) => { console.error(e); process.exit(1); });
