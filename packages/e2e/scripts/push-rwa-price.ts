#!/usr/bin/env tsx
/**
 * Push fresh RWA oracle prices and verify open_position simulates cleanly.
 * Run: cd packages/e2e && npx tsx scripts/push-rwa-price.ts
 */

import {
  Contract,
  Keypair,
  Networks,
  Account,
  TransactionBuilder,
  rpc as SorobanRpc,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { spawnSync } from "node:child_process";

const RPC_URL     = "https://soroban-testnet.stellar.org";
const PASSPHRASE  = Networks.TESTNET;
const ORACLE      = "CCESFJNJ3HS6DH2ZOSGSPMHH2GHE4MWJCWQR5A3RGLZYVZ37E5WBZEXB";
const PERP_ENGINE = "CDK7LFB334FDFEB5VHFAPTDJGDMTAVXTJQDCCHC2SUMEYLR7ZDQEYYYZ";
const SIM_SOURCE  = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const server = new SorobanRpc.Server(RPC_URL);

function sym(s: string) { return xdr.ScVal.scvSymbol(Buffer.from(s, "utf8")); }
function i128(n: bigint) { return nativeToScVal(n, { type: "i128" }); }
function u64(n: bigint)  { return nativeToScVal(n, { type: "u64" }); }
function u32(n: number)  { return xdr.ScVal.scvU32(n); }
function bool(b: boolean) { return xdr.ScVal.scvBool(b); }
function addr(s: string) { return nativeToScVal(s, { type: "address" }); }

function loadDeployerKeypair(): Keypair {
  const r = spawnSync("stellar", ["keys", "show", "stellax-deployer"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`stellar keys show failed: ${r.stderr}`);
  return Keypair.fromSecret(r.stdout.trim());
}

async function simulateCall(contractId: string, method: string, args: xdr.ScVal[]) {
  const account = new Account(SIM_SOURCE, "0");
  const tx = new TransactionBuilder(account, { fee: "100000", networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) throw new Error(`${method}: ${sim.error}`);
  const res = (sim as SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  return res ? scValToNative(res) : undefined;
}

async function invokeOnce(signer: Keypair, contractId: string, method: string, args: xdr.ScVal[]): Promise<void> {
  const contract = new Contract(contractId);
  for (let attempt = 0; attempt < 6; attempt++) {
    const acct = await server.getAccount(signer.publicKey());
    const raw  = new TransactionBuilder(acct, { fee: "100000", networkPassphrase: PASSPHRASE })
      .addOperation(contract.call(method, ...args))
      .setTimeout(60)
      .build();
    const sim = await server.simulateTransaction(raw);
    if (SorobanRpc.Api.isSimulationError(sim)) throw new Error(`simulate(${method}): ${sim.error}`);
    const prep = SorobanRpc.assembleTransaction(raw, sim).build();
    prep.sign(signer);

    let send = await server.sendTransaction(prep);
    for (let i = 0; i < 4 && send.status === "TRY_AGAIN_LATER"; i++) {
      await new Promise(r => setTimeout(r, 1500));
      send = await server.sendTransaction(prep);
    }
    if (send.status === "ERROR") {
      const err = JSON.stringify(send.errorResult ?? {});
      if (err.includes("txBadSeq")) {
        console.log(`  ↻ txBadSeq attempt ${attempt + 1}`);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      throw new Error(`sendTransaction rejected: ${err}`);
    }

    const dead = Date.now() + 60_000;
    while (Date.now() < dead) {
      await new Promise(r => setTimeout(r, 2000));
      const got = await server.getTransaction(send.hash);
      if (got.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        console.log(`  ✓ ${method} confirmed`);
        return;
      }
      if (got.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        const res = (got as SorobanRpc.Api.GetFailedTransactionResponse).resultXdr;
        throw new Error(`${method} failed on-chain: ${res?.toXDR("base64")}`);
      }
    }
    throw new Error(`${method} timed out`);
  }
}

function toFixed18(price: number): bigint {
  return BigInt(Math.round(price * 1e9)) * 10n ** 9n;
}

// Static fallback prices (USD)
const PRICES: Record<string, number> = {
  USDY:  1.12,
  OUSG:  101.5,
  BENJI: 1.053,
};

async function main() {
  const deployer = loadDeployerKeypair();
  console.log("Pushing fresh RWA oracle prices…\n");

  for (const [feed, price] of Object.entries(PRICES)) {
    console.log(`Pushing ${feed} @ $${price}…`);
    try {
      await invokeOnce(deployer, ORACLE, "admin_push_price", [
        sym(feed),
        i128(toFixed18(price)),
        u64(BigInt(Date.now())),
      ]);
    } catch (e) {
      console.error(`  ✗ ${(e as Error).message.slice(0, 200)}`);
    }
    await new Promise(r => setTimeout(r, 1000)); // small gap between txs
  }

  console.log("\nVerifying oracle age…");
  for (const feed of Object.keys(PRICES)) {
    try {
      const data = await simulateCall(ORACLE, "get_price", [sym(feed)]) as {
        price: bigint; write_timestamp: bigint;
      };
      const age = Math.floor(Date.now() / 1000) - Number(data.write_timestamp);
      console.log(`  ${feed}: $${Number(data.price)/1e18} age=${age}s`);
    } catch (e) {
      console.log(`  ${feed}: ERROR — ${(e as Error).message.split("\n")[0]}`);
    }
  }

  console.log("\nSimulating open_position for USDY ($10 long, 2x)…");
  try {
    // size = (10 * 1e18 * 1e18) / (1.12 * 1e18) ≈ 8.928 * 1e18
    const price18 = toFixed18(PRICES.USDY!);
    const size = (10n * 10n**18n * 10n**18n) / price18;
    const dummyUser = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

    const result = await simulateCall(PERP_ENGINE, "open_position", [
      addr(dummyUser),
      u32(101),
      i128(size),
      bool(true),
      u32(2),
      u32(1_000_000_000),
      xdr.ScVal.scvVoid(),
    ]);
    console.log(`  ✓ Simulation OK — result: ${JSON.stringify(result)}`);
  } catch (e) {
    console.log(`  ✗ Still failing: ${(e as Error).message.slice(0, 300)}`);
  }
}

main().catch(console.error);
