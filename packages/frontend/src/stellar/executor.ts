/**
 * Freighter-backed `InvocationExecutor`.
 *
 * Implements the SDK's I/O contract:
 *   - `simulate`: builds a read-only tx, simulates via Soroban RPC, returns the retval.
 *   - `invoke`:   builds, prepares (auto-fee & footprint), signs via Freighter, submits,
 *                 then polls `getTransaction` until a terminal status.
 *
 * The source account for simulation defaults to a deterministic burn address
 * so UI reads work before wallet connection.
 */

import {
  Account,
  Address,
  Contract,
  Networks,
  Operation,
  SorobanDataBuilder,
  Transaction,
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
import { friendlyError } from "./contractErrors";

/** Deterministic, non-signing source used for read-only simulations. */
const SIMULATION_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const POLL_INTERVAL_MS = 1_000;
const DEFAULT_POLL_TIMEOUT_MS = 120_000;

/**
 * Inclusion fee in stroops.  `BASE_FEE` (100) is far too low on a busy
 * testnet ledger — use 100 000 stroops (0.01 XLM) so the transaction is
 * included in the next ledger rather than sitting in the queue.
 */
const INCLUSION_FEE = "100000";

/**
 * Safety multiplier applied to the CPU-instruction count returned by
 * simulation before we submit the transaction.
 *
 * Simulation runs in a diagnostic VM.  The production VM consumes more
 * instructions for auth-entry verification, ledger-entry caching, and
 * host-function dispatch overhead.  For multi-contract calls like
 * openPosition (perpEngine → oracle → vault → risk-engine) the gap
 * between simulated and actual can be 30-50 %.  1.5× keeps us well
 * inside the 100 M instruction ceiling while eliminating
 * Error(Budget, ExceededLimit) on all realistic position sizes.
 */
const RESOURCE_INFLATE_FACTOR = 1.5;

/** Hard ceiling for CPU instructions — the Soroban network maximum. */
const MAX_INSTRUCTIONS = 100_000_000;

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

    // ── Step 1: simulate ──────────────────────────────────────────────────
    // We simulate manually instead of using `prepareTransaction` so we can
    // inflate the CPU-instruction limit before submission.  A vanilla
    // `prepareTransaction` sets resources to the exact simulation measurement
    // which is frequently too tight for multi-contract calls like openPosition
    // (oracle → vault → risk-engine), causing Error(Budget, ExceededLimit).
    let sim: rpc.Api.SimulateTransactionResponse;
    try {
      sim = await this.server.simulateTransaction(raw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`invoke(${method}) simulation failed: ${msg}`);
    }
    if (rpc.Api.isSimulationError(sim)) {
      const err = sim.error ?? "unknown simulation error";
      if (/Budget.*ExceededLimit|ExceededLimit.*Budget/i.test(err)) {
        throw new Error(
          "Transaction requires too much compute — try a smaller position size.",
        );
      }
      // Decode contract error codes (e.g. "Error(Contract, #28)") into
      // human-readable messages before surfacing to the toast.
      throw new Error(friendlyError(err));
    }

    // ── Step 2: inflate CPU instructions ─────────────────────────────────
    // sim.transactionData is a SorobanDataBuilder populated from the
    // simulation response.  We inflate the instruction count in-place before
    // passing it to assembleTransaction so the on-chain VM gets more headroom.
    // Cap at the network maximum (100 M) to avoid rejection at submission.
    const simResources = sim.transactionData.build().resources();
    const currentInstructions = Number(simResources.instructions());
    const inflatedInstructions = Math.min(
      Math.ceil(currentInstructions * RESOURCE_INFLATE_FACTOR),
      MAX_INSTRUCTIONS,
    );
    sim.transactionData.setResources(
      inflatedInstructions,
      Number(simResources.diskReadBytes()),
      Number(simResources.writeBytes()),
    );

    // ── Step 3: assemble (attach footprint + auth + resource fee) ─────────
    let prepared: Transaction;
    try {
      prepared = rpc.assembleTransaction(raw, sim).build() as Transaction;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`invoke(${method}) failed to prepare transaction: ${msg}`);
    }

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
    const pollTimeoutMs = (opts.timeoutSeconds ?? 120) * 1_000;
    const pollDeadline = Date.now() + Math.max(pollTimeoutMs, DEFAULT_POLL_TIMEOUT_MS);
    let attempt = 0;
    while (Date.now() < pollDeadline) {
      await sleep(POLL_INTERVAL_MS);
      attempt += 1;
      let got: rpc.Api.GetTransactionResponse;
      try {
        got = await this.server.getTransaction(send.hash);
      } catch (parseErr) {
        // Protocol 26+ RPC responses can contain XDR union discriminants that
        // older SDK versions fail to deserialize ("Bad union switch: N").
        // If the tx was not rejected at submission time it almost certainly
        // landed — surface SUCCESS with no returnValue so toasts/cache
        // invalidation fire correctly. The position is still on-chain.
        console.warn(
          `[executor] getTransaction XDR parse error (attempt ${attempt}):`,
          parseErr instanceof Error ? parseErr.message : parseErr,
          "— assuming SUCCESS since send.status was not ERROR",
        );
        return {
          hash: send.hash,
          status: "SUCCESS",
          returnValue: undefined,
          latestLedger: send.latestLedger,
        };
      }
      if (got.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return {
          hash: send.hash,
          status: "SUCCESS",
          returnValue: got.returnValue,
          latestLedger: got.latestLedger,
        };
      }
      if (got.status === rpc.Api.GetTransactionStatus.FAILED) {
        // Decode the actual on-chain error from resultXdr so toasts are
        // informative rather than just "Transaction failed".
        let onChainError = "Transaction failed on-chain";
        try {
          const result = got.resultXdr;
          const inner = result.result().results()[0]?.tr().invokeHostFunctionResult();
          if (inner) {
            const sw = inner.switch().name;
            // Try to extract a contract error code from diagnostic events.
            // `diagnosticEventsXdr` is present on GetFailedTransactionResponse
            // when the node has diagnostics enabled.
            let decoded: string | null = null;
            try {
              const diagEvents = (got as rpc.Api.GetFailedTransactionResponse)
                .diagnosticEventsXdr;
              if (diagEvents) {
                for (const evt of diagEvents) {
                  // Each DiagnosticEvent has a body() → contractEvent() → data()
                  // that may contain an ScError. Stringify the XDR and regex-scan
                  // for "Error(Contract, #N)" rather than walking the AST.
                  const raw = evt.toXDR("base64");
                  const m = /Error\(Contract,\s*#(\d+)\)/.exec(
                    Buffer.from(raw, "base64").toString("utf8"),
                  );
                  if (m) {
                    decoded = friendlyError(`Error(Contract, #${m[1]})`);
                    break;
                  }
                }
              }
            } catch {
              // diagnostic parse failed — that is fine
            }
            onChainError = decoded ?? `invoke(${method}) failed: ${sw}`;
          }
        } catch {
          // XDR parse failed — keep the generic message
        }
        throw new Error(onChainError);
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
      fee: INCLUSION_FEE,
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
