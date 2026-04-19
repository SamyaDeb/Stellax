/**
 * Invocation executor abstraction.
 *
 * The SDK never talks to Stellar directly. Consumers inject an
 * `InvocationExecutor` that knows how to:
 *
 *   1. Simulate a read-only contract call and return the decoded ScVal result.
 *   2. Build, sign, and submit a write contract call on behalf of a user.
 *
 * Both calls are tagged with `{ contractId, method, args }`. The frontend's
 * Freighter-backed implementation lives in `packages/frontend/src/stellar/`.
 * Unit tests inject mocks.
 */

import type { xdr } from "@stellar/stellar-sdk";

export interface SimulateOptions {
  /** Optional source account for the simulation. Defaults to a burn address. */
  sourceAccount?: string;
}

export interface InvokeOptions {
  /** Account that will sign and submit the transaction (the "from"). */
  sourceAccount: string;
  /** How long the signed transaction is valid in seconds from submission. */
  timeoutSeconds?: number;
  /** Maximum submission retries on `TRY_AGAIN_LATER`. Defaults to 3. */
  maxRetries?: number;
}

export interface InvokeResult {
  hash: string;
  status: "SUCCESS" | "FAILED" | "PENDING";
  returnValue: xdr.ScVal | undefined;
  latestLedger: number;
}

export interface SimulateResult {
  returnValue: xdr.ScVal | undefined;
  minResourceFee: bigint;
  latestLedger: number;
}

/** The contract I/O contract the SDK depends on. */
export interface InvocationExecutor {
  simulate(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    opts?: SimulateOptions,
  ): Promise<SimulateResult>;

  invoke(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    opts: InvokeOptions,
  ): Promise<InvokeResult>;
}
