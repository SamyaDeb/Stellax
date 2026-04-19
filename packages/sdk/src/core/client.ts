/**
 * Base class shared by every contract client.
 *
 * Provides `simulate` and `invoke` wrappers that pin the contract id and
 * delegate to the injected `InvocationExecutor`. Clients only need to
 * encode args and decode return values.
 */

import type { xdr } from "@stellar/stellar-sdk";
import type {
  InvocationExecutor,
  InvokeOptions,
  InvokeResult,
  SimulateOptions,
  SimulateResult,
} from "./executor.js";

export abstract class ContractClient {
  constructor(
    public readonly contractId: string,
    protected readonly executor: InvocationExecutor,
  ) {}

  protected simulate(
    method: string,
    args: xdr.ScVal[],
    opts?: SimulateOptions,
  ): Promise<SimulateResult> {
    return this.executor.simulate(this.contractId, method, args, opts);
  }

  protected async simulateReturn<T>(
    method: string,
    args: xdr.ScVal[],
    decode: (v: xdr.ScVal | undefined) => T,
    opts?: SimulateOptions,
  ): Promise<T> {
    const sim = await this.simulate(method, args, opts);
    return decode(sim.returnValue);
  }

  protected invoke(
    method: string,
    args: xdr.ScVal[],
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.executor.invoke(this.contractId, method, args, opts);
  }
}
