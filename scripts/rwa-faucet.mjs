#!/usr/bin/env node
/**
 * Minimal testnet RWA faucet.
 *
 * CLI usage:
 *   source deployments/testnet.env
 *   node scripts/rwa-faucet.mjs --asset BENJI --account G... --amount 1000
 *
 * HTTP usage:
 *   source deployments/testnet.env
 *   node scripts/rwa-faucet.mjs --serve --port 8787
 *   curl 'http://localhost:8787/mint?asset=BENJI&account=G...&amount=1000'
 */

import { readFileSync } from "node:fs";
import http from "node:http";
import { spawnSync } from "node:child_process";
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc as SorobanRpc,
} from "@stellar/stellar-sdk";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const dep = JSON.parse(readFileSync(`${ROOT}/deployments/testnet.json`, "utf8"));
const RPC_URL = process.env.STELLAX_RPC_URL ?? dep.rpc_url;
const PASSPHRASE = process.env.STELLAX_NETWORK_PASSPHRASE ?? dep.network_passphrase;
const IDENTITY = process.env.STELLAX_DEPLOYER_IDENTITY || "stellax-deployer";
const DEFAULT_AMOUNT = "1000"; // tokens, human decimal
const MAX_AMOUNT_NATIVE = 10_000_000_000n; // 10,000 tokens at 6 decimals
const server = new SorobanRpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith("http://") });
const inMemoryLimits = new Map();

function arg(name, fallback = undefined) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}
function has(name) { return process.argv.includes(`--${name}`); }
function loadDeployer() {
  const r = spawnSync("stellar", ["keys", "show", IDENTITY], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`stellar keys show ${IDENTITY} failed: ${r.stderr}`);
  return Keypair.fromSecret(r.stdout.trim());
}
function assetContract(asset) {
  const sym = asset.toUpperCase();
  const envId = process.env[`STELLAX_RWA_${sym}`] || process.env[`VITE_RWA_${sym}_CONTRACT_ID`];
  if (envId) return envId;
  const key = sym.toLowerCase();
  return dep.mock_rwa?.[key]?.contract_id ?? "";
}
function parseAmountNative(amount) {
  const [whole, frac = ""] = String(amount).split(".");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(frac) || frac.length > 6) {
    throw new Error("amount must be a positive decimal with at most 6 places");
  }
  const native = BigInt(whole) * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
  if (native <= 0n) throw new Error("amount must be positive");
  if (native > MAX_AMOUNT_NATIVE) throw new Error("amount exceeds faucet max of 10,000 tokens");
  return native;
}
function validateAccount(account) {
  if (!StrKey.isValidEd25519PublicKey(account)) throw new Error("invalid Stellar account");
}
function rateLimit(asset, account) {
  const key = `${asset}:${account}`;
  const now = Date.now();
  const last = inMemoryLimits.get(key) ?? 0;
  if (now - last < 60_000) throw new Error("rate limited; wait 60 seconds");
  inMemoryLimits.set(key, now);
}
async function mint({ asset, account, amount }) {
  const sym = asset.toUpperCase();
  validateAccount(account);
  const contractId = assetContract(sym);
  if (!contractId) throw new Error(`missing contract id for ${sym}`);
  const nativeAmount = parseAmountNative(amount ?? DEFAULT_AMOUNT);
  const kp = loadDeployer();
  const source = await server.getAccount(kp.publicKey());
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(new Contract(contractId).call(
      "mint",
      new Address(account).toScVal(),
      nativeToScVal(nativeAmount, { type: "i128" }),
    ))
    .setTimeout(120)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(kp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(JSON.stringify(sent.errorResult));
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const status = await server.getTransaction(sent.hash);
    if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      return { asset: sym, account, amountNative: nativeAmount.toString(), hash: sent.hash };
    }
    if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) throw new Error(`tx failed ${sent.hash}`);
  }
  throw new Error(`tx timeout ${sent.hash}`);
}

async function serve() {
  const port = Number(arg("port", "8787"));
  http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (url.pathname !== "/mint") {
        res.writeHead(404).end("not found");
        return;
      }
      const asset = url.searchParams.get("asset") ?? "";
      const account = url.searchParams.get("account") ?? "";
      const amount = url.searchParams.get("amount") ?? DEFAULT_AMOUNT;
      rateLimit(asset.toUpperCase(), account);
      const out = await mint({ asset, account, amount });
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(out));
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ error: err.message }));
    }
  }).listen(port, () => console.log(`RWA faucet listening on http://localhost:${port}/mint`));
}

if (has("serve")) {
  void serve();
} else {
  mint({ asset: arg("asset", "BENJI"), account: arg("account"), amount: arg("amount", DEFAULT_AMOUNT) })
    .then((out) => console.log(JSON.stringify(out, null, 2)))
    .catch((err) => { console.error(err); process.exit(1); });
}
