#!/usr/bin/env node
/**
 * One-shot oracle price bootstrap for testnet.
 *
 * Fetches BTC / ETH / XLM / SOL spot prices from CoinGecko and pushes them
 * to stellax-oracle via `admin_push_price`.  Designed to unblock perp trading
 * when the oracle's stored package_timestamp has drifted into the future and
 * the keeper's RedStone pusher is silently bouncing with #11
 * (NonMonotonicTimestamp).
 *
 * For each asset the script:
 *   1. Calls `oracle.get_price(asset)` to read the stored package_timestamp.
 *      If the oracle returns an error (price stale / missing) it falls back to
 *      a 24-hour-ahead value that safely beats any realistic stuck timestamp.
 *   2. Calls `admin_push_price(asset, price_18dp, pkg_ts + 1)`.
 *   3. Prints the tx hash and estimated USD price.
 *
 * Usage:
 *   set -a && source deployments/testnet.env && set +a
 *   node scripts/push-oracle-prices.mjs
 *
 * Optional env overrides:
 *   PUSH_ORACLE_ASSETS=BTC,ETH,XLM,SOL
 *   STELLAX_SOURCE_IDENTITY=stellax-deployer   (default)
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

// ─── Config ────────────────────────────────────────────────────────────────────

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const DEPLOY_JSON = `${ROOT}/deployments/testnet.json`;
const dep = JSON.parse(readFileSync(DEPLOY_JSON, "utf8"));

const RPC_URL = env("STELLAX_RPC_URL", dep.rpc_url);
const PASSPHRASE = env("STELLAX_NETWORK_PASSPHRASE", dep.network_passphrase);
const ORACLE_ID = env("STELLAX_ORACLE", dep.contracts?.oracle);
const ASSETS = listEnv("PUSH_ORACLE_ASSETS", ["BTC", "ETH", "XLM", "SOL"]);

/** CoinGecko simple/price IDs per asset symbol. */
const COINGECKO_IDS = {
  BTC: "bitcoin",
  ETH: "ethereum",
  XLM: "stellar",
  SOL: "solana",
};

/** Static fallback prices (USD) used only when CoinGecko is unreachable. */
const STATIC_FALLBACK = {
  BTC: 65_000,
  ETH: 3_000,
  XLM: 0.12,
  SOL: 145,
};

const FETCH_TIMEOUT_MS = 10_000;

const server = new SorobanRpc.Server(RPC_URL, {
  allowHttp: RPC_URL.startsWith("http://"),
});

// ─── Helpers ───────────────────────────────────────────────────────────────────

function env(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function listEnv(name, fallback) {
  const v = process.env[name];
  if (!v) return fallback;
  return v
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
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
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`invalid price: ${price}`);
  }
  return BigInt(Math.round(price * 1e9)) * 1_000_000_000n;
}

function loadSigner() {
  const identity = process.env.STELLAX_SOURCE_IDENTITY ?? "stellax-deployer";
  const r = spawnSync("stellar", ["keys", "show", identity], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`stellar keys show ${identity} failed:\n${r.stderr}`);
  }
  const secret = r.stdout.trim();
  if (!/^S[A-Z2-7]{55}$/.test(secret)) {
    throw new Error(`bad secret key from identity '${identity}'`);
  }
  return Keypair.fromSecret(secret);
}

/**
 * Submit a Soroban contract call and wait for confirmation.
 */
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
    throw new Error(
      `send(${method}) error: ${JSON.stringify(sent.errorResult)}`,
    );
  }

  for (let i = 0; i < 60; i++) {
    await sleep(2_000);
    const status = await server.getTransaction(sent.hash);
    if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      return sent.hash;
    }
    if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`${method} tx FAILED: ${sent.hash}`);
    }
  }
  throw new Error(`${method} tx timed out: ${sent.hash}`);
}

/**
 * Simulate a read-only contract call and return the decoded return value.
 */
async function simulate(contractId, method, args) {
  const account = await server.getAccount(
    Keypair.random().publicKey(), // use throwaway account for reads
  ).catch(async () => {
    // If random account doesn't exist on testnet, use a known funded one.
    // Fall back to loading a real account.
    return null;
  });

  // Build with a dummy account if we can't get a real one — simulation
  // doesn't require a real funded account for read calls.
  const { Account, TransactionBuilder: TB, Contract: C, scValToNative } = await import("@stellar/stellar-sdk");
  const dummyAccount = new Account(
    "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
    "0",
  );
  const contract = new C(contractId);
  const tx = new TB(dummyAccount, {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`simulate(${method}) failed: ${sim.error}`);
  }
  const retVal = sim.result?.retval;
  return retVal ? scValToNative(retVal) : undefined;
}

/**
 * Get the stored package_timestamp for an oracle asset.
 * Returns null if get_price throws (stale / missing price).
 */
async function getStoredPkgTs(asset) {
  try {
    const data = await simulate(ORACLE_ID, "get_price", [sym(asset)]);
    // PriceData is { price: bigint, package_timestamp: bigint, write_timestamp: bigint }
    const pts = data?.package_timestamp;
    if (typeof pts === "bigint" && pts > 0n) {
      return pts;
    }
    return null;
  } catch {
    // Oracle returned error (OraclePriceTooOld #28, or price missing).
    // Caller will use fallback.
    return null;
  }
}

/**
 * Fetch USD spot prices for all assets from CoinGecko in one batch call.
 */
async function fetchCoinGeckoPrices(assets) {
  const ids = assets
    .map((a) => COINGECKO_IDS[a])
    .filter(Boolean);

  if (ids.length === 0) return {};

  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    if (!resp.ok) {
      throw new Error(`CoinGecko returned HTTP ${resp.status}`);
    }
    const raw = await resp.json();
    const out = {};
    for (const asset of assets) {
      const id = COINGECKO_IDS[asset];
      const price = id ? raw[id]?.usd : undefined;
      if (Number.isFinite(price) && price > 0) {
        out[asset] = price;
      }
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const signer = loadSigner();
  console.log(`Signer : ${signer.publicKey()}`);
  console.log(`Oracle : ${ORACLE_ID}`);
  console.log(`Assets : ${ASSETS.join(", ")}`);
  console.log(`Network: ${PASSPHRASE}`);
  console.log();

  // Step 1: fetch prices from CoinGecko.
  process.stdout.write("Fetching CoinGecko prices... ");
  let prices;
  try {
    prices = await fetchCoinGeckoPrices(ASSETS);
    console.log("OK");
  } catch (err) {
    console.log(`FAILED (${err.message}); will use static fallbacks`);
    prices = {};
  }

  // Merge static fallbacks for any missing assets.
  for (const asset of ASSETS) {
    if (prices[asset] === undefined) {
      const fb = STATIC_FALLBACK[asset];
      if (fb !== undefined) {
        console.log(`  ${asset}: using static fallback $${fb}`);
        prices[asset] = fb;
      }
    }
  }

  console.log();

  // Step 2: push each asset.
  let failures = 0;
  for (const asset of ASSETS) {
    const priceUsd = prices[asset];
    if (priceUsd === undefined) {
      console.error(`  ${asset}: NO PRICE — skipping`);
      failures++;
      continue;
    }

    process.stdout.write(`  ${asset}: $${priceUsd.toFixed(asset === "XLM" ? 6 : 2)}`);

    // Determine initial pkg_ts: read stored value from oracle, then +1.
    const storedPkgTs = await getStoredPkgTs(asset);
    let pkgTs;
    if (storedPkgTs !== null) {
      pkgTs = storedPkgTs + 1n;
      process.stdout.write(
        `  stored_pkg_ts=${storedPkgTs} → pushing pkg_ts=${pkgTs}`,
      );
    } else {
      // Oracle threw (stale or missing). Use 24h-ahead fallback.
      pkgTs = BigInt(Date.now()) + 86_400_000n;
      process.stdout.write(
        `  oracle stale/missing → fallback pkg_ts=${pkgTs}`,
      );
    }

    try {
      const price18 = toFixed18(priceUsd);
      const hash = await invoke(signer, ORACLE_ID, "admin_push_price", [
        sym(asset),
        i128(price18),
        u64(pkgTs),
      ]);
      console.log(`\n    ✓ tx=${hash}`);
    } catch (err) {
      console.log(`\n    ✗ FAILED: ${err.message}`);
      failures++;
    }
  }

  console.log();
  if (failures === 0) {
    console.log(
      "✓ All prices pushed. The perp engine should now accept open_position calls.",
    );
    console.log("  Restart the keeper so AdminOraclePusher picks up from the new baselines.");
  } else {
    console.error(`✗ ${failures}/${ASSETS.length} assets failed.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message ?? err);
  process.exit(1);
});
