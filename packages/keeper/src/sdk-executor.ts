/**
 * KeeperExecutor — bridges the keeper's StellarClient to the SDK's
 * InvocationExecutor interface, so keeper workers can use typed SDK clients
 * (SlpVaultClient, FundingClient, etc.) directly.
 *
 * Design notes:
 *
 *  • `invoke`: delegates to StellarClient.invoke. The keeper always signs with
 *    its own key (baked into SorobanClient), so InvokeOptions.sourceAccount is
 *    intentionally ignored. The raw returnValue is omitted — keeper workers do
 *    not inspect return values from state-mutating calls.
 *
 *  • `simulate`: not needed by any current keeper worker (all SDK calls from
 *    the keeper are write operations). Throws a clear error if accidentally
 *    called so the gap is surfaced quickly rather than silently returning
 *    wrong data.
 */

import type { xdr } from "@stellar/stellar-sdk";
import type {
  InvocationExecutor,
  InvokeOptions,
  InvokeResult,
  SimulateOptions,
  SimulateResult,
} from "@stellax/sdk";
import type { StellarClient } from "./stellar.js";

export class KeeperExecutor implements InvocationExecutor {
  constructor(private readonly stellar: StellarClient) {}

  /**
   * Simulate is not required by any keeper worker. Throws intentionally to
   * surface accidental misuse during development.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  simulate(
    _contractId: string,
    _method: string,
    _args: xdr.ScVal[],
    _opts?: SimulateOptions,
  ): Promise<SimulateResult> {
    throw new Error(
      "KeeperExecutor.simulate: read-only simulation is not supported in the keeper. " +
        "Use StellarClient.simulate() directly for off-chain reads.",
    );
  }

  async invoke(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    const res = await this.stellar.invoke(contractId, method, args, {
      timeoutSeconds: opts.timeoutSeconds,
      maxRetries: opts.maxRetries,
    });
    return {
      hash: res.hash,
      status: "SUCCESS",
      // Keeper workers never inspect return values from state-mutating calls.
      // StellarClient already decoded the retval via scValToNative; we cannot
      // losslessly re-encode it back to xdr.ScVal, so we return undefined.
      returnValue: undefined,
      latestLedger: res.latestLedger,
    };
  }
}
