#!/usr/bin/env node

/**
 * StellaX testnet preflight.
 *
 * Offline by default: validates deployment manifests and prints the exact
 * operator checks to run before a demo. Pass `--check-services` to also probe
 * the local indexer and RWA faucet endpoints.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const envPath = resolve(root, "deployments/testnet.env");
const jsonPath = resolve(root, "deployments/testnet.json");
const checkServices = process.argv.includes("--check-services");

const errors = [];
const warnings = [];

const CONTRACT_RE = /^C[A-Z2-7]{55}$/;
const ACCOUNT_RE = /^G[A-Z2-7]{55}$/;

function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function requireValue(env, key) {
  const value = env[key];
  if (!value) errors.push(`missing ${key}`);
  return value ?? "";
}

function requireContract(env, key) {
  const value = requireValue(env, key);
  if (value && !CONTRACT_RE.test(value)) errors.push(`${key} is not a Stellar contract id: ${value}`);
  return value;
}

function requireAccount(env, key) {
  const value = requireValue(env, key);
  if (value && !ACCOUNT_RE.test(value)) errors.push(`${key} is not a Stellar account id: ${value}`);
  return value;
}

function compare(label, left, right) {
  if (!left || !right) return;
  if (left !== right) errors.push(`${label} mismatch: env=${left}, json=${right}`);
}

async function probe(url, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      errors.push(`${label} responded HTTP ${res.status}: ${url}`);
      return;
    }
    console.log(`  ✓ ${label}: ${url}`);
  } catch (err) {
    errors.push(`${label} unavailable: ${url} (${err instanceof Error ? err.message : String(err)})`);
  } finally {
    clearTimeout(timeout);
  }
}

const env = parseEnv(readFileSync(envPath, "utf8"));
const deployment = JSON.parse(readFileSync(jsonPath, "utf8"));

console.log("StellaX testnet preflight");
console.log(`  env:  ${envPath}`);
console.log(`  json: ${jsonPath}`);

if (requireValue(env, "STELLAX_NETWORK") !== "testnet") {
  errors.push(`STELLAX_NETWORK must be testnet, got ${env.STELLAX_NETWORK ?? "<unset>"}`);
}
if (requireValue(env, "STELLAX_NETWORK_PASSPHRASE") !== "Test SDF Network ; September 2015") {
  errors.push("STELLAX_NETWORK_PASSPHRASE must be the Stellar testnet passphrase");
}
try {
  const rpc = new URL(requireValue(env, "STELLAX_RPC_URL"));
  if (!rpc.protocol.startsWith("http")) errors.push(`STELLAX_RPC_URL must be http(s): ${rpc}`);
} catch {
  errors.push(`STELLAX_RPC_URL is not a valid URL: ${env.STELLAX_RPC_URL ?? "<unset>"}`);
}

const deployer = requireAccount(env, "STELLAX_DEPLOYER");
compare("deployer", deployer, deployment.deployer);

const contracts = {
  oracle: requireContract(env, "STELLAX_ORACLE"),
  vault: requireContract(env, "STELLAX_VAULT"),
  funding: requireContract(env, "STELLAX_FUNDING"),
  risk: requireContract(env, "STELLAX_RISK"),
  perp_engine: requireContract(env, "STELLAX_PERP_ENGINE"),
  options: requireContract(env, "STELLAX_OPTIONS"),
  structured: requireContract(env, "STELLAX_STRUCTURED"),
  treasury: requireContract(env, "STELLAX_TREASURY"),
  bridge: requireContract(env, "STELLAX_BRIDGE"),
  clob: requireContract(env, "STELLAX_CLOB"),
  staking: requireContract(env, "STELLAX_STAKING"),
  referrals: requireContract(env, "STELLAX_REFERRALS"),
};

for (const [key, value] of Object.entries(contracts)) {
  compare(`contracts.${key}`, value, deployment.contracts?.[key]);
}

const rwa = {
  benji: requireContract(env, "STELLAX_RWA_BENJI"),
  usdy: requireContract(env, "STELLAX_RWA_USDY"),
  ousg: requireContract(env, "STELLAX_RWA_OUSG"),
};
compare("mock_rwa.benji", rwa.benji, deployment.mock_rwa?.benji?.contract_id);
compare("mock_rwa.usdy", rwa.usdy, deployment.mock_rwa?.usdy?.contract_id);
compare("mock_rwa.ousg", rwa.ousg, deployment.mock_rwa?.ousg?.contract_id);

compare("VITE_RWA_BENJI_CONTRACT_ID", requireContract(env, "VITE_RWA_BENJI_CONTRACT_ID"), rwa.benji);
compare("VITE_RWA_USDY_CONTRACT_ID", requireContract(env, "VITE_RWA_USDY_CONTRACT_ID"), rwa.usdy);
compare("VITE_RWA_OUSG_CONTRACT_ID", requireContract(env, "VITE_RWA_OUSG_CONTRACT_ID"), rwa.ousg);

const faucetUrl = requireValue(env, "VITE_RWA_FAUCET_URL");
try {
  const parsed = new URL(faucetUrl);
  if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
    warnings.push("VITE_RWA_FAUCET_URL points to localhost; start the faucet before browser demo");
  }
} catch {
  errors.push(`VITE_RWA_FAUCET_URL is not a valid URL: ${faucetUrl}`);
}

const feeds = deployment.mock_rwa?.oracle_feeds ?? [];
for (const feed of ["BENJI", "USDY", "OUSG"]) {
  if (!feeds.includes(feed)) warnings.push(`mock_rwa.oracle_feeds does not list ${feed}`);
}

if (checkServices) {
  const indexerBase = process.env.VITE_INDEXER_URL ?? "http://localhost:4001";
  await probe(`${indexerBase.replace(/\/$/, "")}/health`, "indexer health");
  await probe(`${indexerBase.replace(/\/$/, "")}/prices/BENJI/candles?interval=900&limit=1`, "BENJI indexer candles");
  const faucetProbe = new URL(faucetUrl);
  faucetProbe.searchParams.set("asset", "BENJI");
  faucetProbe.searchParams.set("account", deployer);
  faucetProbe.searchParams.set("amount", "0");
  warnings.push(`faucet was not probed with a mint request; use browser or rwa-faucet smoke to avoid mutating unintentionally (${faucetProbe})`);
}

if (warnings.length > 0) {
  console.log("\nWarnings:");
  for (const warning of warnings) console.log(`  - ${warning}`);
}

if (errors.length > 0) {
  console.error("\nPreflight failed:");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log("\nPreflight passed.");
console.log("\nNext operator checks:");
console.log("  1. Verify oracle config with: stellar contract invoke --id \"$STELLAX_ORACLE\" --source stellax-deployer --network testnet -- config");
console.log("  2. Verify core versions with: stellar contract invoke --id \"$STELLAX_VAULT\" --source stellax-deployer --network testnet -- version");
console.log("  3. Run: make demo-smoke");
console.log("  4. Run once before demo: make demo-e2e-write");
console.log("  5. Start indexer, keeper, faucet, and frontend; verify RWA chart shows indexed oracle history.");
