import {
  Address, Contract, Keypair, Networks, Operation,
  TransactionBuilder, rpc as SorobanRpc, scValToNative, xdr,
} from "@stellar/stellar-sdk";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { request } from "node:https";

const RPC_URL     = "https://soroban-testnet.stellar.org";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const PASSPHRASE  = Networks.TESTNET;
const FEE         = "5000000";

const PERP_ENGINE = "CDK7LFB334FDFEB5VHFAPTDJGDMTAVXTJQDCCHC2SUMEYLR7ZDQEYYYZ";
const WASM_PATH   = "target/wasm32-unknown-unknown/release/stellax_perp_engine.optimized.wasm";

function loadKey(alias) {
  const r = spawnSync("stellar", ["keys", "secret", alias], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`stellar keys secret ${alias}: ${r.stderr}`);
  return r.stdout.trim();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
  console.log("  hash:", hash);
  const deadline = Date.now() + 120_000;
  for (;;) {
    await sleep(4000);
    const r = await rpc.getTransaction(hash);
    if (r.status === "SUCCESS") { console.log("  ✓", label); return r; }
    if (r.status === "FAILED") throw new Error(`${label} FAILED: ${JSON.stringify(r)}`);
    if (Date.now() > deadline) throw new Error(`${label} timeout`);
    process.stdout.write("  …waiting\n");
  }
}

async function main() {
  const rpc    = new SorobanRpc.Server(RPC_URL);
  const signer = Keypair.fromSecret(loadKey("stellax-deployer"));

  // Step 1: Upload WASM
  console.log("\n── Step 1: Upload perp engine WASM");
  const wasm = readFileSync(WASM_PATH);
  console.log("  size:", wasm.length, "bytes");
  const account1 = await getAccountHorizon(signer.publicKey());
  const uploadTx = new TransactionBuilder(account1, { fee: FEE, networkPassphrase: PASSPHRASE })
    .addOperation(Operation.uploadContractWasm({ wasm })).setTimeout(180).build();
  const simUpload = await rpc.simulateTransaction(uploadTx);
  if (SorobanRpc.Api.isSimulationError(simUpload)) throw new Error("upload sim: " + simUpload.error);
  const wasmHash = simUpload.result?.retval ? Buffer.from(scValToNative(simUpload.result.retval)).toString("hex") : null;
  console.log("  expected wasm_hash:", wasmHash);
  const prepUpload = SorobanRpc.assembleTransaction(uploadTx, simUpload).build();
  prepUpload.sign(signer);
  const uploadResult = await submitAndWait(rpc, prepUpload, "upload perp engine WASM");
  const confirmedHash = uploadResult.returnValue ? Buffer.from(scValToNative(uploadResult.returnValue)).toString("hex") : wasmHash;
  console.log("  confirmed hash:", confirmedHash);

  // Step 2: Upgrade
  console.log(`\n── Step 2: perp_engine.upgrade(${confirmedHash})`);
  const hashBytes = xdr.ScVal.scvBytes(Buffer.from(confirmedHash, "hex"));
  const account2 = await getAccountHorizon(signer.publicKey());
  const upgTx = new TransactionBuilder(account2, { fee: FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(PERP_ENGINE).call("upgrade", hashBytes)).setTimeout(180).build();
  const simUpg = await rpc.simulateTransaction(upgTx);
  if (SorobanRpc.Api.isSimulationError(simUpg)) throw new Error("upgrade sim: " + simUpg.error);
  const prepUpg = SorobanRpc.assembleTransaction(upgTx, simUpg).build();
  prepUpg.sign(signer);
  await submitAndWait(rpc, prepUpg, "perp_engine.upgrade");

  console.log(`\n✅ Perp engine upgraded to ${confirmedHash}`);
}

main().catch(e => { console.error("\n✗ Error:", e.message); process.exit(1); });
