#!/usr/bin/env node
/**
 * Bootstrap the stellax-oracle Pyth pull-mode + RWA staleness configuration
 * after a fresh testnet deployment.
 *
 * Steps:
 *   1. set_pyth_config(pyth_contract, max_age_ms)
 *   2. set_pyth_feed_id(symbol, feed_id_bytes32)  — for each PYTH_<SYM>_FEED_ID
 *   3. set_symbol_staleness(symbol, ms)           — for each RWA feed
 *
 * Usage:
 *   set -a && source deployments/testnet.env && set +a
 *   node scripts/oracle-rwa-bootstrap.mjs
 *
 * Required env:
 *   PYTH_SOROBAN_CONTRACT     — Pyth contract address on Soroban testnet
 *   PYTH_MAX_AGE_MS           — default 60_000
 *   PYTH_USDC_FEED_ID         — 32-byte hex (with or without 0x prefix)
 *   PYTH_XLM_FEED_ID          — 32-byte hex (with or without 0x prefix)
 *
 * Optional env:
 *   RWA_FEEDS=BENJI,USDY,OUSG
 *   RWA_STALENESS_MS=120000
 *   STELLAX_SOURCE_IDENTITY=stellax-deployer
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  BASE_FEE,
  Address,
  Contract,
  Keypair,
  TransactionBuilder,
  rpc as SorobanRpc,
  xdr,
} from "@stellar/stellar-sdk";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const DEPLOY_JSON = `${ROOT}/deployments/testnet.json`;
const dep = JSON.parse(readFileSync(DEPLOY_JSON, "utf8"));

const RPC_URL = env("STELLAX_RPC_URL", dep.rpc_url);
const PASSPHRASE = env("STELLAX_NETWORK_PASSPHRASE", dep.network_passphrase);
const ORACLE_ID = env("STELLAX_ORACLE", dep.contracts?.oracle);
const PYTH_CONTRACT = process.env.PYTH_SOROBAN_CONTRACT;
const PYTH_MAX_AGE_MS = Number(process.env.PYTH_MAX_AGE_MS || "60000");
const RWA_FEEDS = listEnv("RWA_FEEDS", ["BENJI", "USDY", "OUSG"]);
const RWA_STALENESS_MS = Number(process.env.RWA_STALENESS_MS || "120000");

// symbol -> env var name producing 32-byte hex feed id.
const PYTH_FEED_MAP = {
  USDC: "PYTH_USDC_FEED_ID",
  XLM: "PYTH_XLM_FEED_ID",
};

const server = new SorobanRpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith("http://") });

function env(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function listEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function loadSigner() {
  const identity = process.env.STELLAX_SOURCE_IDENTITY || "stellax-deployer";
  const r = spawnSync("stellar", ["keys", "show", identity], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`stellar keys show ${identity} failed: ${r.stderr}`);
  const secret = r.stdout.trim();
  if (!/^S[A-Z2-7]{55}$/.test(secret)) throw new Error(`bad secret from identity ${identity}`);
  return Keypair.fromSecret(secret);
}

function sym(s) {
  return xdr.ScVal.scvSymbol(Buffer.from(s, "utf8"));
}
function u64(n) {
  return xdr.ScVal.scvU64(xdr.Uint64.fromString(BigInt(n).toString()));
}
function addr(a) {
  return new Address(a).toScVal();
}
function bytesN32(hex) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length !== 64) throw new Error(`expected 32-byte hex, got ${clean.length / 2} bytes`);
  return xdr.ScVal.scvBytes(Buffer.from(clean, "hex"));
}

async function invoke(signer, contractId, method, args) {
  const account = await server.getAccount(signer.publicKey());
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

  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(`send(${method}) error: ${JSON.stringify(sent.errorResult)}`);
  }
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const status = await server.getTransaction(sent.hash);
    if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) return sent.hash;
    if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`${method} tx failed: ${sent.hash}`);
    }
  }
  throw new Error(`${method} tx timeout: ${sent.hash}`);
}

async function main() {
  const signer = loadSigner();
  console.log(`Signer: ${signer.publicKey()}`);
  console.log(`Oracle: ${ORACLE_ID}`);

  // Step 1: Pyth config (optional — skip if not provided).
  if (PYTH_CONTRACT) {
    console.log(`\n[1/3] set_pyth_config(${PYTH_CONTRACT}, ${PYTH_MAX_AGE_MS}ms)`);
    const h = await invoke(signer, ORACLE_ID, "set_pyth_config", [
      addr(PYTH_CONTRACT),
      u64(PYTH_MAX_AGE_MS),
    ]);
    console.log(`  ✅ tx=${h}`);

    // Step 2: feed id mappings.
    for (const [symbol, envName] of Object.entries(PYTH_FEED_MAP)) {
      const hex = process.env[envName];
      if (!hex) {
        console.log(`  ⏭  ${symbol}: ${envName} not set — skipping`);
        continue;
      }
      console.log(`[2/3] set_pyth_feed_id(${symbol}, ${hex})`);
      const tx = await invoke(signer, ORACLE_ID, "set_pyth_feed_id", [
        sym(symbol),
        bytesN32(hex),
      ]);
      console.log(`  ✅ tx=${tx}`);
    }
  } else {
    console.log("\n[1-2/3] PYTH_SOROBAN_CONTRACT not set — skipping Pyth config");
  }

  // Step 3: RWA staleness overrides.
  console.log(`\n[3/3] set_symbol_staleness for RWA feeds (${RWA_STALENESS_MS}ms)`);
  for (const feed of RWA_FEEDS) {
    const tx = await invoke(signer, ORACLE_ID, "set_symbol_staleness", [
      sym(feed),
      u64(RWA_STALENESS_MS),
    ]);
    console.log(`  ${feed}: ✅ tx=${tx}`);
  }

  console.log("\n✅ Oracle bootstrap complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
