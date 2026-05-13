#!/usr/bin/env node
/**
 * Test script: verify bridge deposits auto-credit to vault.
 *
 * This script:
 * 1. Checks the user's vault balance before
 * 2. Calls bridge_collateral_in to simulate an Axelar deposit
 * 3. Verifies the balance increased correctly
 * 4. Checks the deposit history
 *
 * Usage: node scripts/test-bridge-deposit.mjs [amount_in_6dp]
 */

import {
  Keypair,
  rpc,
  Contract,
  TransactionBuilder,
  Networks,
  Address,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

const RPC_URL = "https://soroban-testnet.stellar.org";
const HORIZON = "https://horizon-testnet.stellar.org";
const BRIDGE = "CDTZX3CTVVHN67ONILVY7PHSQDGZHMKCP3EM4NHATYUYA5J5NYSDZMVL";
const VAULT = "CDDA3QFNHWZDX4IWHHNISPOI3R5KX4OPEUIQC5NA2RAB2HTMOS7YW4IM";
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const KEEPER_SK = process.env.STELLAX_ADMIN_SECRET || "SBPS434YXIGJRXEF6SLP2TX4I5V7F5IRETWBVMORLOSUFZKDQIRJAHY2";
const USER = process.env.TEST_USER || "GCBOM6CQSNLNE7YM4JRKX4IZ6S7CY3HZC3OFTEEA3NHFT56NS3PULAQT";

const amount6dp = BigInt(process.argv[2] || "10000"); // default 0.01 USDC

const server = new rpc.Server(RPC_URL);
const kp = Keypair.fromSecret(KEEPER_SK);

async function simulate(contractId, method, args) {
  const account = await server.getAccount(kp.publicKey());
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${sim.error}`);
  }
  return sim.result?.retval;
}

async function invoke(contractId, method, args) {
  const account = await server.getAccount(kp.publicKey());
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${sim.error}`);
  }
  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(kp);

  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(`Send error: ${JSON.stringify(sent.errorResult)}`);
  }

  let status = await server.getTransaction(sent.hash);
  const start = Date.now();
  while (
    status.status === rpc.Api.GetTransactionStatus.NOT_FOUND &&
    Date.now() - start < 60000
  ) {
    await new Promise((r) => setTimeout(r, 1000));
    status = await server.getTransaction(sent.hash);
  }

  if (status.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`Tx failed: ${status.status}`);
  }

  return sent.hash;
}

async function main() {
  console.log("=== Bridge Deposit Test ===\n");
  console.log("User:", USER);
  console.log("Amount (6dp):", amount6dp.toString());

  // 1. Check balance before
  console.log("\n--- Step 1: Check vault balance ---");
  const beforeRaw = await simulate(VAULT, "get_balance", [
    new Address(USER).toScVal(),
    new Address(USDC).toScVal(),
  ]);
  const before = BigInt(scValToNative(beforeRaw).toString());
  console.log("Balance before:", (before / 10n ** 18n).toString(), "USDC");

  // 2. Credit via bridge
  console.log("\n--- Step 2: Call bridge_collateral_in ---");
  const tokenId = new Uint8Array(32);
  const stellarAmount = amount6dp * 10n; // 6dp -> 7dp conversion

  const amountScVal = xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      hi: xdr.Int64.fromString("0"),
      lo: xdr.Uint64.fromString(stellarAmount.toString()),
    }),
  );

  const hash = await invoke(BRIDGE, "bridge_collateral_in", [
    new Address(kp.publicKey()).toScVal(),
    new Address(USER).toScVal(),
    xdr.ScVal.scvBytes(tokenId),
    amountScVal,
  ]);
  console.log("Tx hash:", hash);
  console.log("Tx URL:", `https://stellar.expert/explorer/testnet/tx/${hash}`);

  // 3. Check balance after
  console.log("\n--- Step 3: Verify balance updated ---");
  const afterRaw = await simulate(VAULT, "get_balance", [
    new Address(USER).toScVal(),
    new Address(USDC).toScVal(),
  ]);
  const after = BigInt(scValToNative(afterRaw).toString());
  console.log("Balance after:", (after / 10n ** 18n).toString(), "USDC");

  const delta = after - before;
  const expectedDelta = stellarAmount * 10n ** 11n; // 7dp -> 18dp

  console.log("\nDelta:", (delta / 10n ** 18n).toString(), "USDC");
  console.log("Expected:", (expectedDelta / 10n ** 18n).toString(), "USDC");

  if (delta === expectedDelta) {
    console.log("\n✅ PASS: Balance updated correctly");
  } else {
    console.log("\n❌ FAIL: Balance delta mismatch");
    process.exit(1);
  }

  // 4. Check Horizon for tx
  console.log("\n--- Step 4: Check Horizon operations ---");
  const opsRes = await fetch(`${HORIZON}/transactions/${hash}/operations`);
  const opsJson = await opsRes.json();
  const invokeOps = (opsJson._embedded?.records ?? []).filter(
    (op) => op.type === "invoke_host_function",
  );
  console.log("Invoke ops in tx:", invokeOps.length);
  for (const op of invokeOps) {
    console.log("  Function:", op.function);
  }

  console.log("\n=== Test Complete ===");
}

main().catch((e) => {
  console.error("\n❌ Test failed:", e.message);
  process.exit(1);
});
