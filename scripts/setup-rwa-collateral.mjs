#!/usr/bin/env node
/**
 * Register deployed mock RWA issuer contracts as vault collateral.
 *
 * Usage:
 *   source deployments/testnet.env
 *   node scripts/setup-rwa-collateral.mjs
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const DEPLOY_JSON = `${ROOT}/deployments/testnet.json`;
const dep = JSON.parse(readFileSync(DEPLOY_JSON, "utf8"));

const RPC_URL = process.env.STELLAX_RPC_URL ?? dep.rpc_url;
const PASSPHRASE = process.env.STELLAX_NETWORK_PASSPHRASE ?? dep.network_passphrase;
const VAULT_ID = process.env.STELLAX_VAULT ?? dep.contracts?.vault;
const IDENTITY = process.env.STELLAX_DEPLOYER_IDENTITY || "stellax-deployer";

const ASSETS = [
  { key: "benji", symbol: "BENJI", haircutBps: 700 },
  { key: "usdy", symbol: "USDY", haircutBps: 500 },
  { key: "ousg", symbol: "OUSG", haircutBps: 800 },
];

function loadDeployer() {
  const r = spawnSync("stellar", ["keys", "show", IDENTITY], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`stellar keys show ${IDENTITY} failed: ${r.stderr}`);
  const secret = r.stdout.trim();
  if (!/^S[A-Z2-7]{55}$/.test(secret)) throw new Error(`bad secret from ${IDENTITY}`);
  return Keypair.fromSecret(secret);
}

const server = new SorobanRpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith("http://") });

function sym(s) { return xdr.ScVal.scvSymbol(Buffer.from(s, "utf8")); }
function u32(n) { return xdr.ScVal.scvU32(n); }
function i128(n) { return nativeToScVal(BigInt(n), { type: "i128" }); }
function boolV(b) { return xdr.ScVal.scvBool(b); }
function addr(s) { return new Address(s).toScVal(); }
function mapEntry(key, val) { return new xdr.ScMapEntry({ key, val }); }
function structMap(entries) {
  const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return xdr.ScVal.scvMap(sorted.map(([k, v]) => mapEntry(sym(k), v)));
}

async function invoke(signer, contractId, method, args) {
  const account = await server.getAccount(signer.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(120)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`simulate ${method} failed: ${sim.error}`);
  }
  const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(signer);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(`send ${method} failed: ${JSON.stringify(sent.errorResult)}`);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const status = await server.getTransaction(sent.hash);
    if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      console.log(`  ✅ ${method} tx ${sent.hash}`);
      return status;
    }
    if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`${method} failed in tx ${sent.hash}`);
    }
  }
  throw new Error(`${method} timed out in tx ${sent.hash}`);
}

async function main() {
  if (!VAULT_ID) throw new Error("Missing STELLAX_VAULT / deployments.testnet.json contracts.vault");
  const signer = loadDeployer();
  console.log(`Vault: ${VAULT_ID}`);
  console.log(`Admin: ${signer.publicKey()}`);

  for (const asset of ASSETS) {
    const meta = dep.mock_rwa?.[asset.key];
    const contractId = process.env[`STELLAX_RWA_${asset.symbol}`] ?? meta?.contract_id;
    if (!contractId) throw new Error(`Missing contract id for ${asset.symbol}; run scripts/deploy-rwa-issuers.mjs first`);
    const decimals = meta?.decimals ?? 6;
    const capNative = BigInt(meta?.max_deposit_cap_native ?? 500_000_000_000);
    const capInternal = capNative * 10n ** BigInt(18 - decimals);
    console.log(`Registering ${asset.symbol} collateral: ${contractId}`);
    const collateral = structMap([
      ["token_address", addr(contractId)],
      ["asset_symbol", sym(asset.symbol)],
      ["decimals", u32(decimals)],
      ["haircut_bps", u32(asset.haircutBps)],
      ["max_deposit_cap", i128(capInternal)],
      ["is_active", boolV(true)],
    ]);
    await invoke(signer, VAULT_ID, "update_collateral_config", [collateral]);
  }
  console.log("✅ RWA collateral registration complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
