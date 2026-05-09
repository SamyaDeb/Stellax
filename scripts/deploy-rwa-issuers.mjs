#!/usr/bin/env node
/**
 * Deploy StellaX mock RWA issuer contracts on testnet.
 *
 * Usage:
 *   source deployments/testnet.env
 *   stellar contract build --package stellax-rwa-issuer
 *   stellar contract optimize --wasm target/wasm32v1-none/release/stellax_rwa_issuer.wasm
 *   node scripts/deploy-rwa-issuers.mjs
 *
 * The script is idempotent: existing non-empty contract IDs in
 * deployments/testnet.json are kept unless --force is passed.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const DEPLOY_JSON = `${ROOT}/deployments/testnet.json`;
const DEPLOY_ENV = `${ROOT}/deployments/testnet.env`;
const WASM = `${ROOT}/target/wasm32v1-none/release/stellax_rwa_issuer.optimized.wasm`;
const NETWORK = process.env.STELLAX_NETWORK || "testnet";
const IDENTITY = process.env.STELLAX_DEPLOYER_IDENTITY || "stellax-deployer";
const ADMIN = process.env.STELLAX_DEPLOYER || run("stellar", ["keys", "public-key", IDENTITY]).trim();
const FORCE = process.argv.includes("--force");

const ASSETS = [
  {
    key: "benji",
    env: "STELLAX_RWA_BENJI",
    symbol: "BENJI",
    name: "Mock Franklin BENJI",
    issuer: "Franklin Templeton (mock)",
    decimals: 6,
    apy_bps: 500,
    auth_required: false,
    haircut_bps: 700,
    max_deposit_cap_native: 500_000_000_000,
  },
  {
    key: "usdy",
    env: "STELLAX_RWA_USDY",
    symbol: "USDY",
    name: "Mock Ondo USDY",
    issuer: "Ondo Finance (mock)",
    decimals: 6,
    apy_bps: 505,
    auth_required: false,
    haircut_bps: 500,
    max_deposit_cap_native: 500_000_000_000,
  },
  {
    key: "ousg",
    env: "STELLAX_RWA_OUSG",
    symbol: "OUSG",
    name: "Mock Ondo OUSG",
    issuer: "Ondo Finance (mock)",
    decimals: 6,
    apy_bps: 450,
    auth_required: false,
    haircut_bps: 800,
    max_deposit_cap_native: 500_000_000_000,
  },
];

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", cwd: ROOT, ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  }
  return r.stdout;
}

function deploy(asset) {
  console.log(`Deploying ${asset.symbol} RWA issuer...`);
  const out = run("stellar", [
    "contract", "deploy",
    "--wasm", WASM,
    "--source", IDENTITY,
    "--network", NETWORK,
    "--",
    "--admin", ADMIN,
    "--name", asset.name,
    "--symbol", asset.symbol,
    "--decimals", String(asset.decimals),
    "--apy_bps", String(asset.apy_bps),
    "--auth_required", String(asset.auth_required),
  ]).trim();
  const id = out.split(/\s+/).find((s) => /^C[A-Z2-7]{55}$/.test(s));
  if (!id) throw new Error(`could not parse contract id from deploy output: ${out}`);
  console.log(`  ${asset.symbol}: ${id}`);
  return id;
}

function upsertEnv(lines) {
  let text = existsSync(DEPLOY_ENV) ? readFileSync(DEPLOY_ENV, "utf8") : "";
  for (const [key, value] of Object.entries(lines)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    text = re.test(text) ? text.replace(re, line) : `${text.trimEnd()}\n${line}\n`;
  }
  writeFileSync(DEPLOY_ENV, text.endsWith("\n") ? text : `${text}\n`);
}

if (!existsSync(WASM)) {
  throw new Error(`Missing ${WASM}. Run: stellar contract build --package stellax-rwa-issuer && stellar contract optimize --wasm target/wasm32v1-none/release/stellax_rwa_issuer.wasm`);
}

const dep = JSON.parse(readFileSync(DEPLOY_JSON, "utf8"));
dep.mock_rwa ??= {};
dep.wasm_hashes ??= {};
const wasmHash = createHash("sha256").update(readFileSync(WASM)).digest("hex");
dep.wasm_hashes.stellax_rwa_issuer = wasmHash;

const envLines = {};
for (const asset of ASSETS) {
  const current = dep.mock_rwa?.[asset.key]?.contract_id;
  const contractId = !FORCE && current ? current : deploy(asset);
  dep.mock_rwa[asset.key] = {
    ...(dep.mock_rwa[asset.key] ?? {}),
    contract_id: contractId,
    symbol: asset.symbol,
    decimals: asset.decimals,
    apy_bps: asset.apy_bps,
    auth_required: asset.auth_required,
    haircut_bps: asset.haircut_bps,
    max_deposit_cap_native: asset.max_deposit_cap_native,
    issuer: asset.issuer,
  };
  envLines[asset.env] = contractId;
  envLines[`VITE_RWA_${asset.symbol}_CONTRACT_ID`] = contractId;
}
dep.mock_rwa.oracle_feeds = ["BENJI", "USDY", "OUSG"];

writeFileSync(DEPLOY_JSON, `${JSON.stringify(dep, null, 2)}\n`);
upsertEnv(envLines);
console.log(`Updated ${DEPLOY_JSON}`);
console.log(`Updated ${DEPLOY_ENV}`);
console.log(`RWA issuer WASM sha256: ${wasmHash}`);
