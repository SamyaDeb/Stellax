import {
  Address, Contract, Keypair, Networks,
  TransactionBuilder, rpc as SorobanRpc, scValToNative, nativeToScVal, xdr,
} from "@stellar/stellar-sdk";
import { spawnSync } from "node:child_process";
import { request } from "node:https";

const RPC_URL     = "https://soroban-testnet.stellar.org";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const PASSPHRASE  = Networks.TESTNET;
const FEE         = "5000000";
const PERP_ENGINE = "CDK7LFB334FDFEB5VHFAPTDJGDMTAVXTJQDCCHC2SUMEYLR7ZDQEYYYZ";
const ORACLE      = "CCESFJNJ3HS6DH2ZOSGSPMHH2GHE4MWJCWQR5A3RGLZYVZ37E5WBZEXB";
const DEPLOYER    = "GAVFAXLV54GY7M4WZYIZQGP5NFRAJOUQA2LA4UDDUWVJCOIEPEMKYNQG";

function loadKey(alias) {
  const r = spawnSync("stellar", ["keys", "secret", alias], { encoding: "utf8" });
  return r.stdout.trim();
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const addr = s => new Address(s).toScVal();
const u64  = n => nativeToScVal(typeof n === "bigint" ? n : BigInt(n), { type: "u64" });
const i128 = n => nativeToScVal(typeof n === "bigint" ? n : BigInt(n), { type: "i128" });
const sym  = s => nativeToScVal(s, { type: "symbol" });
const none = () => xdr.ScVal.scvVoid();

async function getAccountHorizon(pubkey) {
  return new Promise((res, rej) => {
    const req = request({ hostname: "horizon-testnet.stellar.org", path: `/accounts/${pubkey}`, method: "GET" }, (r) => {
      let data = ""; r.on("data", c => data += c);
      r.on("end", async () => { const { Account } = await import("@stellar/stellar-sdk"); res(new Account(pubkey, JSON.parse(data).sequence)); });
    });
    req.on("error", rej); req.end();
  });
}

async function submitAndWait(rpc, tx, label) {
  const body = `tx=${encodeURIComponent(tx.toEnvelope().toXDR("base64"))}`;
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
  for (const deadline = Date.now() + 120_000;;) {
    await sleep(4000);
    const r = await rpc.getTransaction(hash);
    if (r.status === "SUCCESS") { console.log("  ✓", label); return r; }
    if (r.status === "FAILED") throw new Error(`${label} FAILED: ${JSON.stringify(r.resultXdr)}`);
    if (Date.now() > deadline) throw new Error(`${label} timeout`);
    process.stdout.write("  …\n");
  }
}

async function invoke(rpc, signer, contractId, method, args, label) {
  const account = await getAccountHorizon(signer.publicKey());
  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args)).setTimeout(180).build();
  const sim = await rpc.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) throw new Error(`simulate ${label}: ${sim.error}`);
  const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(signer);
  return submitAndWait(rpc, prepared, label);
}

async function simRead(rpc, contractId, method, args) {
  const acct = await rpc.getAccount(DEPLOYER);
  const tx = new TransactionBuilder(acct, { fee: FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args)).setTimeout(60).build();
  const sim = await rpc.simulateTransaction(tx);
  if (sim.error) return null;
  return sim.result?.retval ? scValToNative(sim.result.retval) : null;
}

const rpc    = new SorobanRpc.Server(RPC_URL);
const signer = Keypair.fromSecret(loadKey("stellax-deployer"));

// 1. Read current BTC price and push a fresh one
console.log("Step 1: Push fresh BTC oracle price");
const priceData = await simRead(rpc, ORACLE, "get_price", [sym("BTC")]);
console.log("  current price:", Number(priceData?.price ?? 0n) / 1e18, "pkg_ts:", priceData?.package_timestamp?.toString());
const freshTs = (priceData?.package_timestamp ?? BigInt(Date.now())) + 1n;
const btcPrice = priceData?.price ?? 81207000000000000000000n;
await invoke(rpc, signer, ORACLE, "admin_push_price", [sym("BTC"), i128(btcPrice), u64(freshTs)], "admin_push_price(BTC)");

// 2. Close position 1
console.log("\nStep 2: Close position 1");
await invoke(rpc, signer, PERP_ENGINE, "close_position", [addr(DEPLOYER), u64(1n), none()], "close_position(1)");

console.log("\n✅ Position 1 closed.");
