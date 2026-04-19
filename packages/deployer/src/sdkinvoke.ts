// ── JS-SDK contract invoke (bypasses stellar-cli JSON→ScVal for enum UDTs) ────
//
// stellar-cli v23.4.1 panics with "not yet implemented: UdtEnumV0" when it
// tries to serialise a Rust enum contracttype from JSON. We work around this
// for any call that has enum args by building ScVals ourselves and submitting
// the transaction via @stellar/stellar-sdk + SorobanRpc directly.

import {
  Contract,
  rpc as SorobanRpc,
  TransactionBuilder,
  xdr,
  Address,
  Keypair,
  BASE_FEE,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { spawnSync } from "node:child_process";

// ── Secret-key resolution ─────────────────────────────────────────────────────

/** Read the S... secret key for a stellar-cli identity via `stellar keys show`. */
function loadSecretKey(identity: string): string {
  const r = spawnSync("stellar", ["keys", "show", identity], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`stellar keys show ${identity} failed: ${r.stderr}`);
  }
  const key = r.stdout.trim();
  if (!/^S[A-Z2-7]{55}$/.test(key)) {
    throw new Error(`unexpected secret key format for ${identity}: ${key}`);
  }
  return key;
}

// ── ScVal builder helpers ─────────────────────────────────────────────────────

export function addrVal(s: string): xdr.ScVal {
  return new Address(s).toScVal();
}

export function u32Val(n: number): xdr.ScVal {
  return xdr.ScVal.scvU32(n);
}

export function u64Val(n: number | bigint): xdr.ScVal {
  return xdr.ScVal.scvU64(xdr.Uint64.fromString(BigInt(n).toString()));
}

export function i128Val(n: bigint | string): xdr.ScVal {
  // nativeToScVal with {type:"i128"} handles the hi/lo split correctly.
  return nativeToScVal(BigInt(n), { type: "i128" });
}

export function boolVal(b: boolean): xdr.ScVal {
  return xdr.ScVal.scvBool(b);
}

export function symbolVal(s: string): xdr.ScVal {
  return xdr.ScVal.scvSymbol(Buffer.from(s, "utf8"));
}

export function stringVal(s: string): xdr.ScVal {
  return xdr.ScVal.scvString(Buffer.from(s, "utf8"));
}

export function vecVal(items: xdr.ScVal[]): xdr.ScVal {
  return xdr.ScVal.scvVec(items);
}

/** Build a ScvMap from an ordered list of [symbolKey, val] pairs.
 *  Soroban requires map keys to be sorted lexicographically. */
export function mapVal(entries: [string, xdr.ScVal][]): xdr.ScVal {
  const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return xdr.ScVal.scvMap(
    sorted.map(
      ([k, v]) =>
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol(Buffer.from(k, "utf8")),
          val: v,
        }),
    ),
  );
}

// ── Transaction submit + poll ─────────────────────────────────────────────────

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 60_000;

/**
 * Submit a Soroban contract invocation using the JS SDK.
 * Loads the deployer's secret key via `stellar keys show <identity>`.
 */
export async function invokeSDK(
  rpcUrl: string,
  passphrase: string,
  identity: string,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<void> {
  const secretKey = loadSecretKey(identity);
  const kp = Keypair.fromSecret(secretKey);
  const server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });

  const account = await server.getAccount(kp.publicKey());
  const contract = new Contract(contractId);

  // Build a transaction shell (fee will be updated by simulation).
  const txBuilder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: passphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60);

  const tx = txBuilder.build();

  // Simulate to get footprint + resource fee.
  const simResult = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(simResult)) {
    throw new Error(
      `simulateTransaction failed for ${method} on ${contractId.slice(0, 12)}…: ${simResult.error}`,
    );
  }

  // Assemble (sets soroban data + fee) and sign.
  const prepared = SorobanRpc.assembleTransaction(tx, simResult).build();
  prepared.sign(kp);

  // Submit.
  const sendResult = await server.sendTransaction(prepared);
  if (sendResult.status === "ERROR") {
    throw new Error(
      `sendTransaction failed for ${method}: ${JSON.stringify(sendResult.errorResult)}`,
    );
  }

  // Poll until confirmed or timed out.
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (true) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const getResult = await server.getTransaction(sendResult.hash);
    if (getResult.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      return;
    }
    if (getResult.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(
        `transaction FAILED for ${method} on ${contractId.slice(0, 12)}…: ${JSON.stringify(getResult)}`,
      );
    }
    // NOT_FOUND — keep polling.
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${method} tx ${sendResult.hash}`,
      );
    }
  }
}
