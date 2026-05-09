#!/usr/bin/env node
/**
 * Push the latest BENJI / USDY / OUSG NAVs to stellax-oracle once.
 *
 * Demo usage:
 *   set -a && source deployments/testnet.env && set +a
 *   node scripts/push-rwa-navs.mjs
 *
 * Optional overrides:
 *   RWA_FEEDS=BENJI,USDY,OUSG
 *   RWA_NAV_SOURCE_BENJI=https://example.test/benji.json
 *   RWA_NAV_SOURCE_USDY=https://example.test/usdy.json
 *   RWA_NAV_SOURCE_OUSG=https://example.test/ousg.json
 *
 * The endpoint response can contain any of these numeric fields:
 *   nav, price, navPrice, nav_price, navPerShare, nav_per_share
 * or nested objects/arrays containing one of those fields.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
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

const DEFAULT_URLS = {
  BENJI: [
    envMaybe("RWA_NAV_SOURCE_BENJI"),
    envMaybe("RWA_BENJI_NAV_URL"),
    "https://nav.franklintempleton.com/v1/funds/benji/nav",
    "https://api.llama.fi/protocol/franklin-templeton-benji",
  ],
  USDY: [
    envMaybe("RWA_NAV_SOURCE_USDY"),
    envMaybe("RWA_ONDO_NAV_URL"),
    "https://api.coingecko.com/api/v3/simple/price?ids=ondo-us-dollar-yield&vs_currencies=usd",
    "https://api.ondo.finance/v1/nav/usdy",
  ],
  OUSG: [
    envMaybe("RWA_NAV_SOURCE_OUSG"),
    envMaybe("RWA_OUSG_NAV_URL"),
    "https://api.ondo.finance/v1/nav/ousg",
  ],
};

const FALLBACK_NAVS = {
  BENJI: 1.0,
  USDY: 1.053,
  OUSG: 101.5,
};

const server = new SorobanRpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith("http://") });

function env(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function envMaybe(name) {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

function listEnv(name, fallback) {
  const v = process.env[name];
  if (!v) return fallback;
  return v.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
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

function i128(n) {
  return nativeToScVal(BigInt(n), { type: "i128" });
}

function toFixed18(price) {
  if (!Number.isFinite(price) || price <= 0) throw new Error(`invalid price ${price}`);
  return BigInt(Math.round(price * 1e9)) * 1_000_000_000n;
}

function firstFinitePrice(value) {
  const preferred = ["nav", "price", "navPrice", "nav_price", "navPerShare", "nav_per_share"];
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const n = Number(value.replace(/[$,]/g, ""));
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const n = firstFinitePrice(item);
      if (n !== null) return n;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const key of preferred) {
      if (key in value) {
        const n = firstFinitePrice(value[key]);
        if (n !== null) return n;
      }
    }
    for (const nested of Object.values(value)) {
      const n = firstFinitePrice(nested);
      if (n !== null) return n;
    }
  }
  return null;
}

function firstTimestamp(value) {
  const preferred = ["ts", "timestamp", "asOf", "as_of", "date", "navDate", "nav_date"];
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value > 10_000_000_000 ? Math.floor(value) : Math.floor(value * 1000);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const n = firstTimestamp(item);
      if (n !== null) return n;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const key of preferred) {
      if (key in value) {
        const n = firstTimestamp(value[key]);
        if (n !== null) return n;
      }
    }
    for (const nested of Object.values(value)) {
      const n = firstTimestamp(nested);
      if (n !== null) return n;
    }
  }
  return null;
}

async function fetchNav(feed) {
  const urls = (DEFAULT_URLS[feed] ?? []).filter(Boolean);
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          "cache-control": "no-cache",
          pragma: "no-cache",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const price = firstFinitePrice(body);
      if (price === null) throw new Error("no NAV/price field found");
      return {
        feed,
        price,
        price18: toFixed18(price),
        timestampMs: firstTimestamp(body) ?? Date.now(),
        source: url,
        fallback: false,
      };
    } catch (err) {
      console.warn(`⚠️  ${feed} NAV candidate failed: ${url} — ${(err).message}`);
    }
  }

  const price = FALLBACK_NAVS[feed];
  if (!price) throw new Error(`No NAV source or fallback for ${feed}`);
  return {
    feed,
    price,
    price18: toFixed18(price),
    timestampMs: Date.now(),
    source: "fallback",
    fallback: true,
  };
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
  if (sent.status === "ERROR") throw new Error(`send(${method}) error: ${JSON.stringify(sent.errorResult)}`);

  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const status = await server.getTransaction(sent.hash);
    if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) return sent.hash;
    if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) throw new Error(`${method} tx failed: ${sent.hash}`);
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
    const sample = await fetchNav(feed);
    const timestampMs = BigInt(Math.max(sample.timestampMs, Date.now()));
    console.log(`${feed}: $${sample.price.toFixed(feed === "OUSG" ? 4 : 6)} source=${sample.source}${sample.fallback ? " (fallback)" : ""}`);
    console.log(`  fixed18=${sample.price18.toString()} tsMs=${timestampMs}`);
    const hash = await invoke(signer, ORACLE_ID, "admin_push_price", [
      sym(feed),
      i128(sample.price18),
      u64(timestampMs),
    ]);
    console.log(`  ✅ pushed tx=${hash}`);
  }

  console.log("\n✅ RWA NAV push complete. Refresh /vaults or wait for the indexer WebSocket event.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
