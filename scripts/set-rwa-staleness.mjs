#!/usr/bin/env node
/**
 * Configure per-symbol staleness overrides on stellax-oracle.
 *
 * Default targets: BENJI / USDY / OUSG -> 120_000ms (2 minutes)
 * with the keeper pushing every ~15s + force every 60s.
 *
 * Usage:
 *   set -a && source deployments/testnet.env && set +a
 *   node scripts/set-rwa-staleness.mjs
 *
 * Env overrides:
 *   RWA_FEEDS=BENJI,USDY,OUSG
 *   RWA_STALENESS_MS=120000
 *   RWA_STALENESS_BENJI=300000  (per-feed override)
 *   RWA_STALENESS_USDY=180000
 *   RWA_STALENESS_OUSG=600000
 *   STELLAX_SOURCE_IDENTITY=stellax-deployer
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  BASE_FEE,
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
const FEEDS = listEnv("RWA_FEEDS", ["BENJI", "USDY", "OUSG"]);
const DEFAULT_STALENESS_MS = Number(env("RWA_STALENESS_MS", "120000"));

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

function feedStalenessMs(feed) {
  const perFeed = process.env[`RWA_STALENESS_${feed}`];
  if (perFeed && Number.isFinite(Number(perFeed)) && Number(perFeed) > 0) {
    return Number(perFeed);
  }
  return DEFAULT_STALENESS_MS;
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
  console.log(`Feeds:  ${FEEDS.join(", ")}`);
  console.log();

  for (const feed of FEEDS) {
    const ms = feedStalenessMs(feed);
    console.log(`${feed}: setting staleness override = ${ms}ms`);
    const hash = await invoke(signer, ORACLE_ID, "set_symbol_staleness", [
      sym(feed),
      u64(ms),
    ]);
    console.log(`  ✅ tx=${hash}`);
  }

  console.log("\n✅ RWA staleness overrides configured.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
