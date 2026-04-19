/**
 * Freighter-backed `InvocationExecutor`.
 *
 * Implements the SDK's I/O contract:
 *   - `simulate`: builds a read-only tx, simulates via Soroban RPC, returns the retval.
 *   - `invoke`:   builds, prepares (auto-fee & footprint), signs via Freighter, submits,
 *                 then polls `getTransaction` until a terminal status.
 *
 * The source account for simulation defaults to a deterministic burn address
 * (all-zero G-key) so UI reads work before wallet connection.
 */

import { Buffer } from "buffer";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { signTransaction as freighterSign } from "@stellar/freighter-api";
import type {
  InvocationExecutor,
  InvokeOptions,
  InvokeResult,
  SimulateOptions,
  SimulateResult,
} from "@stellax/sdk";
import { config } from "@/config";
import { getRpcServer } from "./rpc";

/** Deterministic, non-signing source used for read-only simulations. */
const SIMULATION_SOURCE = Keypair.fromRawEd25519Seed(Buffer.alloc(32)).publicKey();

const POLL_INTERVAL_MS = 1_000;
const MAX_POLL_ATTEMPTS = 30;

export class FreighterExecutor implements InvocationExecutor {
  private readonly server: rpc.Server;
  private readonly networkPassphrase: string;

  constructor(networkPassphrase: string = config.network.passphrase) {
    this.server = getRpcServer();
    this.networkPassphrase = networkPassphrase;
  }

  async simulate(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    opts: SimulateOptions = {},
  ): Promise<SimulateResult> {
    if (!contractId) {
      throw new Error(`simulate(${method}): contract ID not configured`);
    }

    const source = opts.sourceAccount ?? SIMULATION_SOURCE;
    // `getAccount` requires the account to exist on-chain; for a deterministic
    // simulation source we fabricate an Account shell with sequence 0.
    const account =
      opts.sourceAccount !== undefined
        ? await this.server.getAccount(source)
        : new Account(source, "0");

    const tx = this.buildInvocation(account, contractId, method, args);
    const sim = await this.server.simulateTransaction(tx);

    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`simulate(${method}) failed: ${sim.error}`);
    }

    return {
      returnValue: sim.result?.retval,
      minResourceFee: BigInt(sim.minResourceFee ?? "0"),
      latestLedger: sim.latestLedger,
    };
  }

  async invoke(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    if (!contractId) {
      throw new Error(`invoke(${method}): contract ID not configured`);
    }

    const account = await this.server.getAccount(opts.sourceAccount);
    const raw = this.buildInvocation(
      account,
      contractId,
      method,
      args,
      opts.timeoutSeconds ?? 60,
    );

    // `prepareTransaction` bundles simulate + auto-attach footprint/fee.
    const prepared = await this.server.prepareTransaction(raw);

    const signed = await freighterSign(prepared.toXDR(), {
      networkPassphrase: this.networkPassphrase,
      address: opts.sourceAccount,
    });
    if (signed.error) {
      throw new Error(`Freighter sign failed: ${String(signed.error)}`);
    }

    const signedTx = TransactionBuilder.fromXDR(
      signed.signedTxXdr,
      this.networkPassphrase,
    );

    const maxRetries = opts.maxRetries ?? 3;
    let send: rpc.Api.SendTransactionResponse | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      send = await this.server.sendTransaction(signedTx);
      if (send.status !== "TRY_AGAIN_LATER") break;
      await sleep(POLL_INTERVAL_MS);
    }
    if (send === null) {
      throw new Error(`invoke(${method}): no response from RPC`);
    }
    if (send.status === "ERROR") {
      throw new Error(
        `invoke(${method}) rejected: ${send.errorResult?.result().switch().name ?? "unknown"}`,
      );
    }

    // Poll until terminal. DUPLICATE means server already has the hash; still poll.
    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
      await sleep(POLL_INTERVAL_MS);
      const got = await this.server.getTransaction(send.hash);
      if (got.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return {
          hash: send.hash,
          status: "SUCCESS",
          returnValue: got.returnValue,
          latestLedger: got.latestLedger,
        };
      }
      if (got.status === rpc.Api.GetTransactionStatus.FAILED) {
        return {
          hash: send.hash,
          status: "FAILED",
          returnValue: undefined,
          latestLedger: got.latestLedger,
        };
      }
    }

    return {
      hash: send.hash,
      status: "PENDING",
      returnValue: undefined,
      latestLedger: send.latestLedger,
    };
  }

  private buildInvocation(
    account: Account,
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    timeoutSeconds = 60,
  ) {
    // Validate contractId early with a clear message.
    new Address(contractId); // throws if malformed

    const contract = new Contract(contractId);
    return new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(timeoutSeconds)
      .build();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Network passphrase helpers. */
export const NETWORKS = Networks;

let _executor: FreighterExecutor | null = null;
let _executorPassphrase: string | null = null;

/**
 * Return the singleton FreighterExecutor. If the wallet has switched networks
 * (different passphrase), a new instance is created so signed transactions
 * always carry the correct network passphrase.
 */
export function getExecutor(passphrase: string = config.network.passphrase): FreighterExecutor {
  if (_executor === null || passphrase !== _executorPassphrase) {
    _executor = new FreighterExecutor(passphrase);
    _executorPassphrase = passphrase;
  }
  return _executor;
}
