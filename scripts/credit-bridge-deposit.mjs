#!/usr/bin/env node
/**
 * credit-bridge-deposit.mjs
 *
 * Manually processes a stuck bridge deposit by calling bridge_collateral_in()
 * on the Stellar bridge contract using the admin key.
 *
 * Use this when:
 *   - Axelar GMP shows "executed" but the Stellar vault balance hasn't updated
 *   - The bridge keeper is not running or missed the event
 *
 * Usage:
 *   source deployments/testnet.env
 *   node scripts/credit-bridge-deposit.mjs <recipient_g_address> <amount_6dec>
 *
 * Example:
 *   node scripts/credit-bridge-deposit.mjs GCBOM6CQSNLNE7YM4JRKX4IZ6S7CY3HZC3OFTEEA3NHFT56NS3PULAQT 10000
 */

import {
  Address, Contract, Keypair, Networks, TransactionBuilder,
  rpc as SorobanRpc, scValToNative, nativeToScVal, xdr,
} from "@stellar/stellar-sdk";
import { spawnSync } from "node:child_process";

const RPC_URL    = "https://soroban-testnet.stellar.org";
const HORIZON    = "https://horizon-testnet.stellar.org";
const PASSPHRASE = Networks.TESTNET;
const FEE        = "5000000";

const DEPLOYER   = "GAVFAXLV54GY7M4WZYIZQGP5NFRAJOUQA2LA4UDDUWVJCOIEPEMKYNQG";
const BRIDGE     = "CDTZX3CTVVHN67ONILVY7PHSQDGZHMKCP3EM4NHATYUYA5J5NYSDZMVL";
const USDC_SAC   = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

const log = {
  step: (t) => console.log(`\n\x1b[36m━━━ ${t}\x1b[0m`),
  ok:   (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`),
  info: (m) => console.log(`  \x1b[2m${m}\x1b[0m`),
  warn: (m) => console.log(`  \x1b[33m⚠\x1b[0m ${m}`),
  fail: (m) => { console.error(`\n\x1b[31m✗ FAIL\x1b[0m  ${m}\n`); process.exit(1); },
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadKey(alias) {
  const r = spawnSync("stellar", ["keys", "secret", alias], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`stellar keys secret ${alias}: ${r.stderr}`);
  return r.stdout.trim();
}

async function invoke(rpc, signer, contractId, method, args, label, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const account = await rpc.getAccount(signer.publicKey());
      const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: PASSPHRASE })
        .addOperation(new Contract(contractId).call(method, ...args)).setTimeout(180).build();
      const sim = await rpc.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(sim)) throw new Error(`sim ${label}: ${sim.error}`);
      const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
      prepared.sign(signer);
      const sendResp = await rpc.sendTransaction(prepared);
      if (sendResp.status === "ERROR") throw new Error(`send ${label}: ${JSON.stringify(sendResp)}`);
      const hash = sendResp.hash;
      log.info(`    hash: ${hash}`);
      const deadline = Date.now() + 300_000;
      for (;;) {
        await sleep(4000);
        const r = await rpc.getTransaction(hash);
        if (r.status === "SUCCESS") { log.ok(label); return r; }
        if (r.status === "FAILED") throw new Error(`${label} FAILED: ${JSON.stringify(r)}`);
        if (Date.now() > deadline) throw new Error(`${label} timeout`);
      }
    } catch (err) {
      if (attempt < retries && (err.message?.includes("ECONNRESET") || err.message?.includes("ECONNREFUSED"))) {
        log.warn(`${label} — network error (${err.message}); retry ${attempt}/${retries} in 5s…`);
        await sleep(5000);
        continue;
      }
      throw err;
    }
  }
}

async function simRead(rpc, contractId, method, args = []) {
  const account = await rpc.getAccount(DEPLOYER);
  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args)).setTimeout(30).build();
  const sim = await rpc.simulateTransaction(tx);
  if ("error" in sim) return null;
  return scValToNative(sim.result?.retval);
}

// ─── Main ────────────────────────────────────────────────────────────────────

const recipient = process.argv[2];
const amount6dec = parseInt(process.argv[3], 10);

if (!recipient || !amount6dec || isNaN(amount6dec) || !/^G[A-Z2-7]{55}$/.test(recipient)) {
  console.error("Usage: node scripts/credit-bridge-deposit.mjs <stellar_g_address> <amount_6dec>");
  process.exit(1);
}

console.log("\x1b[1mStellaX — Manual Bridge Deposit Credit\x1b[0m\n");

const rpc    = new SorobanRpc.Server(RPC_URL);
const secret = loadKey("stellax-deployer");
const signer = Keypair.fromSecret(secret);
log.info(`Signer  : ${signer.publicKey()}`);
log.info(`Bridge  : ${BRIDGE}`);
log.info(`Recipient: ${recipient}`);
log.info(`Amount  : ${amount6dec} (6-dec units = ${(amount6dec / 1e6).toFixed(6)} USDC)`);

// testnet placeholder: 32 zero bytes
const USDC_TOKEN_ID = new Uint8Array(32);
const tokenIdScVal = xdr.ScVal.scvBytes(Buffer.from(USDC_TOKEN_ID));

// ── 1. Verify token registry ───────────────────────────────────────────────

log.step("1. Verify USDC token is in bridge registry");
const localToken = await simRead(rpc, BRIDGE, "get_local_token", [tokenIdScVal]);
if (localToken === null) {
  log.warn("USDC_TOKEN_ID not in registry — registering now...");
  await invoke(rpc, signer, BRIDGE, "register_token", [
    tokenIdScVal,
    new Address(USDC_SAC).toScVal(),
  ], `register_token(USDC)`);
  log.ok("USDC token registered ✓");
} else {
  log.ok(`Local token: ${localToken}`);
}

// ── 2. Check vault balance before ──────────────────────────────────────────

log.step("2. Check vault balance before credit");
const vaultBalance = await simRead(rpc, "CDDA3QFNHWZDX4IWHHNISPOI3R5KX4OPEUIQC5NA2RAB2HTMOS7YW4IM", "balance", [
  new Address(recipient).toScVal(),
]);
const vaultBeforeNum = vaultBalance !== null ? Number(BigInt(vaultBalance) / 10_000_000_000n) / 10_000_000 : 0;
log.info(`  Vault balance (7dp raw): ${vaultBalance ?? "0"}`);
log.info(`  Vault balance (approx USD): ${vaultBeforeNum.toFixed(6)}`);

// ── 3. Call bridge_collateral_in ───────────────────────────────────────────

log.step("3. Calling bridge_collateral_in()");
await invoke(rpc, signer, BRIDGE, "bridge_collateral_in", [
  new Address(signer.publicKey()).toScVal(),  // caller = admin
  new Address(recipient).toScVal(),           // user = recipient
  tokenIdScVal,                               // token_id
  nativeToScVal(BigInt(amount6dec), { type: "i128" }), // amount in 6-dec units
], `bridge_collateral_in(${recipient}, ${amount6dec})`);

// ── 4. Verify credit ──────────────────────────────────────────────────────

log.step("4. Verify vault balance after credit");
const vaultAfter = await simRead(rpc, "CDDA3QFNHWZDX4IWHHNISPOI3R5KX4OPEUIQC5NA2RAB2HTMOS7YW4IM", "balance", [
  new Address(recipient).toScVal(),
]);
const afterNum = vaultAfter !== null ? Number(BigInt(vaultAfter) / 10_000_000_000n) / 10_000_000 : 0;
log.info(`  Vault balance after (approx USD): ${afterNum.toFixed(6)}`);

if (vaultBalance !== null && vaultAfter !== null) {
  const delta = BigInt(vaultAfter) - BigInt(vaultBalance);
  log.ok(`Balance delta: +${(Number(delta) / 1e7 / 1e11).toFixed(6)} USDC ✓`);
}

console.log(`\n\x1b[32mDeposit credited! Check ${recipient} in StellaX dashboard.\x1b[0m\n`);
