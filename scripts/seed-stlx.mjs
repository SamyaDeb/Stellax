#!/usr/bin/env node
/**
 * seed-stlx.mjs
 *
 * 1. Creates STLX classic trustline on the distributor account
 * 2. Issuer (deployer) classic-sends 10M STLX to the distributor
 *
 * After this, the SAC at CBH3... can be used as a normal Soroban token
 * contract for the staking engine (distributor holds the balance).
 */
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { spawnSync } from "node:child_process";

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const PASSPHRASE = Networks.TESTNET;
const STLX_ISSUER = "GAVFAXLV54GY7M4WZYIZQGP5NFRAJOUQA2LA4UDDUWVJCOIEPEMKYNQG";
const DISTRIBUTOR = "GBHRWM4KXE7NZYZQJSQKWLV7ETIJ2MHNCFIV6L6P2MZKMYQGY647C2Z7";
const STLX = new Asset("STLX", STLX_ISSUER);
const AMOUNT = "10000000"; // 10M STLX (classic asset amounts are whole units)

function loadSecret(alias) {
  const r = spawnSync("stellar", ["keys", "secret", alias], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    console.error(r.stderr);
    throw new Error(`stellar keys secret ${alias} failed`);
  }
  return r.stdout.trim();
}

async function main() {
  const server = new Horizon.Server(HORIZON_URL);
  const issuerKp = Keypair.fromSecret(loadSecret("stellax-deployer"));
  const distKp = Keypair.fromSecret(loadSecret("stellax-stlx-distributor"));

  // 1. Distributor creates trustline to STLX
  const distAcct = await server.loadAccount(DISTRIBUTOR);
  const tlTx = new TransactionBuilder(distAcct, {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(Operation.changeTrust({ asset: STLX }))
    .setTimeout(30)
    .build();
  tlTx.sign(distKp);
  const tlRes = await server.submitTransaction(tlTx);
  console.log("trustline hash:", tlRes.hash);

  // 2. Issuer pays 10M STLX to distributor
  const issAcct = await server.loadAccount(STLX_ISSUER);
  const payTx = new TransactionBuilder(issAcct, {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination: DISTRIBUTOR,
        asset: STLX,
        amount: AMOUNT,
      })
    )
    .setTimeout(30)
    .build();
  payTx.sign(issuerKp);
  const payRes = await server.submitTransaction(payTx);
  console.log("payment hash:", payRes.hash);
  console.log("DONE: 10M STLX now held by distributor", DISTRIBUTOR);
}

main().catch((e) => {
  console.error(e?.response?.data ?? e);
  process.exit(1);
});
