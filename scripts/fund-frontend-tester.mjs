#!/usr/bin/env node
/**
 * fund-frontend-tester.mjs
 *
 * Funds a Stellar testnet account with USDC for frontend e2e testing.
 *
 * What it does:
 *   1. Establishes a USDC trustline on the target account (signed by target key)
 *   2. Deployer buys USDC from the testnet DEX with XLM
 *   3. Deployer sends 1,000 USDC to the target account
 *
 * Usage:
 *   USER_SECRET=SXXXXXXXXX node scripts/fund-frontend-tester.mjs
 *
 * USER_SECRET is the secret key of the account you want to fund.
 * You can export it from Freighter: Settings → Security → Show secret key.
 *
 * Alternatively pass as a positional argument:
 *   node scripts/fund-frontend-tester.mjs SXXXXXXXXX
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

// ── Config ────────────────────────────────────────────────────────────────────

const HORIZON_URL  = "https://horizon-testnet.stellar.org";
const PASSPHRASE   = Networks.TESTNET;
const USDC_ISSUER  = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC_ASSET   = new Asset("USDC", USDC_ISSUER);
const XLM_ASSET    = Asset.native();
const FUND_AMOUNT  = 1000; // USDC to send to the target account

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadDeployerKey() {
  const r = spawnSync("stellar", ["keys", "show", "stellax-deployer"], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(
      `Could not load stellax-deployer key.\n` +
      `Make sure you have the stellar CLI installed and the identity exists.\n` +
      `Error: ${r.stderr?.trim()}`,
    );
  }
  const secret = r.stdout.trim();
  if (!/^S[A-Z2-7]{55}$/.test(secret)) {
    throw new Error(`Unexpected key format: ${secret.slice(0, 8)}…`);
  }
  return Keypair.fromSecret(secret);
}

function getUserKey() {
  const secret = process.env.USER_SECRET ?? process.argv[2];
  if (!secret) {
    console.error("\n❌  Missing USER_SECRET.\n");
    console.error("Usage:");
    console.error("  USER_SECRET=SXXXXXXXXX node scripts/fund-frontend-tester.mjs\n");
    console.error("How to get your secret key from Freighter:");
    console.error("  Freighter → Settings → Security → Show secret key\n");
    process.exit(1);
  }
  if (!/^S[A-Z2-7]{55}$/.test(secret.trim())) {
    console.error(`❌  Invalid secret key format. Expected S + 55 base32 chars.`);
    process.exit(1);
  }
  return Keypair.fromSecret(secret.trim());
}

async function submitTx(server, tx, label) {
  try {
    const result = await server.submitTransaction(tx);
    console.log(`  ✓ ${label}`);
    console.log(`    tx: https://stellar.expert/explorer/testnet/tx/${result.hash}`);
    return result;
  } catch (err) {
    const codes = err?.response?.data?.extras?.result_codes;
    if (codes) {
      const msg = JSON.stringify(codes);
      // Ignore "already exists" errors (trustline, payment already done, etc.)
      if (msg.includes("op_already_exists") || msg.includes("CHANGE_TRUST_ALREADY_EXIST")) {
        console.log(`  ✓ ${label} (already done — skipping)`);
        return null;
      }
    }
    throw new Error(
      `Transaction "${label}" failed:\n  ${JSON.stringify(codes ?? err?.message ?? String(err))}`,
    );
  }
}

async function getBalance(server, pubkey, assetCode, issuer) {
  const account = await server.loadAccount(pubkey);
  for (const b of account.balances) {
    if (b.asset_type === "native" && assetCode === "XLM") return b.balance;
    if (b.asset_code === assetCode && b.asset_issuer === issuer) return b.balance;
  }
  return "0";
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n🚀  StellaX testnet USDC funder\n");

  const server   = new Horizon.Server(HORIZON_URL, { allowHttp: false });
  const userKp   = getUserKey();
  const deployerKp = loadDeployerKey();

  const userAddr     = userKp.publicKey();
  const deployerAddr = deployerKp.publicKey();

  console.log(`  Target account : ${userAddr}`);
  console.log(`  Deployer       : ${deployerAddr}`);
  console.log(`  USDC to send   : ${FUND_AMOUNT} USDC\n`);

  // ── 1. Establish USDC trustline on target account ─────────────────────────
  console.log("Step 1/3 — Establishing USDC trustline on target account…");
  {
    const account = await server.loadAccount(userAddr);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(Operation.changeTrust({ asset: USDC_ASSET }))
      .setTimeout(120)
      .build();
    tx.sign(userKp);
    await submitTx(server, tx, "USDC trustline established");
  }

  // ── 2. Deployer buys USDC from DEX (to have enough to send) ───────────────
  console.log("\nStep 2/3 — Deployer buying USDC from testnet DEX…");
  {
    const deployerAccount = await server.loadAccount(deployerAddr);
    const deployerUsdc = parseFloat(await getBalance(server, deployerAddr, "USDC", USDC_ISSUER));
    const needed = FUND_AMOUNT - deployerUsdc;

    if (needed <= 0) {
      console.log(`  ✓ Deployer already has enough USDC (${deployerUsdc.toFixed(2)})`);
    } else {
      // Buy exactly what we need; allow up to 1.2 XLM per USDC as sendMax.
      const buyAmount  = Math.ceil(needed + 1); // +1 for rounding safety
      const sendMaxXlm = (buyAmount * 12).toFixed(7); // generous sendMax
      const destAmount = buyAmount.toFixed(7);

      console.log(`  Deployer has ${deployerUsdc.toFixed(2)} USDC, buying ${buyAmount} more…`);

      const tx = new TransactionBuilder(deployerAccount, {
        fee: BASE_FEE,
        networkPassphrase: PASSPHRASE,
      })
        .addOperation(
          Operation.pathPaymentStrictReceive({
            sendAsset: XLM_ASSET,
            sendMax: sendMaxXlm,
            destination: deployerAddr,
            destAsset: USDC_ASSET,
            destAmount: destAmount,
            path: [],
          }),
        )
        .setTimeout(120)
        .build();
      tx.sign(deployerKp);
      await submitTx(server, tx, `Bought ${buyAmount} USDC from DEX`);
    }
  }

  // ── 3. Deployer sends USDC to target account ──────────────────────────────
  console.log("\nStep 3/3 — Sending USDC to target account…");
  {
    const deployerAccount = await server.loadAccount(deployerAddr);
    const tx = new TransactionBuilder(deployerAccount, {
      fee: BASE_FEE,
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(
        Operation.payment({
          destination: userAddr,
          asset: USDC_ASSET,
          amount: FUND_AMOUNT.toFixed(7),
        }),
      )
      .setTimeout(120)
      .build();
    tx.sign(deployerKp);
    await submitTx(server, tx, `Sent ${FUND_AMOUNT} USDC to ${userAddr.slice(0, 8)}…`);
  }

  // ── Done — print balances ─────────────────────────────────────────────────
  console.log("\n✅  Done! Final balances:\n");
  const xlm  = await getBalance(server, userAddr, "XLM");
  const usdc = await getBalance(server, userAddr, "USDC", USDC_ISSUER);
  console.log(`  ${userAddr}`);
  console.log(`    XLM  : ${parseFloat(xlm).toFixed(4)}`);
  console.log(`    USDC : ${parseFloat(usdc).toFixed(4)}`);
  console.log(
    `\n  🔗 View on Stellar Expert:\n` +
    `     https://stellar.expert/explorer/testnet/account/${userAddr}\n`,
  );
}

main().catch((err) => {
  console.error("\n❌ ", err.message ?? err);
  process.exit(1);
});
