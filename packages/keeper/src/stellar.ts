/**
 * Stellar Soroban client abstraction.
 *
 * Wraps `@stellar/stellar-sdk` so that workers receive a narrow, mockable
 * interface and never talk to the network directly.
 *
 * The real implementation handles:
 *   - account sequence management
 *   - simulation + assembly
 *   - submission with exponential-backoff retry
 *   - scValue encoding for common arg types (i128, u32, u64, bytes, address)
 */
import {
  Account,
  Address,
  Contract,
  Keypair,
  Networks,
  rpc as SorobanRpc,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { Logger } from "pino";
import { getLogger } from "./logger.js";

export type ScArg = number | bigint | string | Uint8Array | boolean | ScArg[];

export interface InvokeResult<T = unknown> {
  hash: string;
  status: "SUCCESS";
  returnValue: T;
  latestLedger: number;
}

export interface SimulateResult<T = unknown> {
  returnValue: T;
  minResourceFee: bigint;
  latestLedger: number;
}

export interface StellarClient {
  publicKey(): string;
  getAccountBalanceStroops(): Promise<bigint>;
  getLatestLedger(): Promise<number>;
  simulate<T = unknown>(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
  ): Promise<SimulateResult<T>>;
  invoke<T = unknown>(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    opts?: { fee?: number; timeoutSeconds?: number; maxRetries?: number },
  ): Promise<InvokeResult<T>>;
}

export interface StellarClientOptions {
  rpcUrl: string;
  networkPassphrase: string;
  secretKey: string;
}

const BASE_FEE = 1_000_000; // 0.1 XLM — Soroban txs need high base fees

export class SorobanClient implements StellarClient {
  private readonly server: SorobanRpc.Server;
  private readonly keypair: Keypair;
  private readonly networkPassphrase: string;
  private readonly log: Logger;

  constructor(opts: StellarClientOptions) {
    this.server = new SorobanRpc.Server(opts.rpcUrl, {
      allowHttp: opts.rpcUrl.startsWith("http://"),
    });
    this.keypair = Keypair.fromSecret(opts.secretKey);
    this.networkPassphrase = opts.networkPassphrase;
    this.log = getLogger("soroban");
  }

  publicKey(): string {
    return this.keypair.publicKey();
  }

  async getAccountBalanceStroops(): Promise<bigint> {
    const account = await this.server.getAccount(this.keypair.publicKey());
    // getAccount returns sequence info only; balances require Horizon.
    // For a quick check we rely on Horizon via the RPC base url.
    // Fallback: return 0 so callers treat as "unknown" if not available.
    try {
      const raw = (account as unknown as { balances?: { asset_type: string; balance: string }[] })
        .balances;
      if (raw) {
        const native = raw.find((b) => b.asset_type === "native");
        if (native) {
          return BigInt(Math.floor(Number(native.balance) * 1e7));
        }
      }
    } catch {
      // ignore
    }
    return 0n;
  }

  async getLatestLedger(): Promise<number> {
    const r = await this.server.getLatestLedger();
    return r.sequence;
  }

  private async loadAccount(): Promise<Account> {
    const a = await this.server.getAccount(this.keypair.publicKey());
    return new Account(a.accountId(), a.sequenceNumber());
  }

  async simulate<T = unknown>(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
  ): Promise<SimulateResult<T>> {
    const account = await this.loadAccount();
    const contract = new Contract(contractId);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE.toString(),
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(30)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(sim)) {
      throw new Error(`Simulation failed: ${sim.error}`);
    }
    if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
      throw new Error("Simulation produced no success result");
    }
    const retVal = sim.result?.retval;
    const decoded = retVal !== undefined ? (scValToNative(retVal) as T) : (undefined as T);
    return {
      returnValue: decoded,
      minResourceFee: BigInt(sim.minResourceFee ?? "0"),
      latestLedger: sim.latestLedger ?? 0,
    };
  }

  async invoke<T = unknown>(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    opts: { fee?: number; timeoutSeconds?: number; maxRetries?: number } = {},
  ): Promise<InvokeResult<T>> {
    const maxRetries = opts.maxRetries ?? 3;
    const timeout = opts.timeoutSeconds ?? 60;
    const fee = opts.fee ?? BASE_FEE;

    let attempt = 0;
    let lastErr: unknown;
    while (attempt <= maxRetries) {
      try {
        const account = await this.loadAccount();
        const contract = new Contract(contractId);
        const tx = new TransactionBuilder(account, {
          fee: fee.toString(),
          networkPassphrase: this.networkPassphrase,
        })
          .addOperation(contract.call(method, ...args))
          .setTimeout(timeout)
          .build();

        const sim = await this.server.simulateTransaction(tx);
        if (SorobanRpc.Api.isSimulationError(sim)) {
          throw new Error(`Simulation failed: ${sim.error}`);
        }
        const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
        prepared.sign(this.keypair);

        const sent = await this.server.sendTransaction(prepared);
        if (sent.status === "ERROR") {
          throw new Error(`sendTransaction error: ${JSON.stringify(sent.errorResult)}`);
        }
        // Poll for final status
        let status = await this.server.getTransaction(sent.hash);
        const pollUntil = Date.now() + timeout * 1000;
        while (
          status.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND &&
          Date.now() < pollUntil
        ) {
          await sleep(1_000);
          status = await this.server.getTransaction(sent.hash);
        }
        if (status.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
          throw new Error(`tx ${sent.hash} status=${status.status}`);
        }
        const retVal =
          (status as SorobanRpc.Api.GetSuccessfulTransactionResponse).returnValue;
        const decoded = retVal ? (scValToNative(retVal) as T) : (undefined as T);
        return {
          hash: sent.hash,
          status: "SUCCESS",
          returnValue: decoded,
          latestLedger: status.latestLedger,
        };
      } catch (err) {
        lastErr = err;
        const delay = 500 * 2 ** attempt;
        this.log.warn(
          { method, attempt, delay, err: (err as Error).message },
          "invoke attempt failed; will retry",
        );
        attempt += 1;
        if (attempt > maxRetries) break;
        await sleep(delay);
      }
    }
    throw new Error(
      `invoke(${method}) failed after ${maxRetries + 1} attempts: ${
        (lastErr as Error)?.message
      }`,
    );
  }
}

// ─── Helpers for building ScVal arguments ──────────────────────────────────────

export const scVal = {
  u32(n: number): xdr.ScVal {
    return nativeToScVal(n, { type: "u32" });
  },
  u64(n: number | bigint): xdr.ScVal {
    return nativeToScVal(typeof n === "number" ? BigInt(n) : n, { type: "u64" });
  },
  i128(n: number | bigint): xdr.ScVal {
    return nativeToScVal(typeof n === "number" ? BigInt(n) : n, { type: "i128" });
  },
  symbol(s: string): xdr.ScVal {
    return nativeToScVal(s, { type: "symbol" });
  },
  bytes(b: Uint8Array): xdr.ScVal {
    return nativeToScVal(b, { type: "bytes" });
  },
  address(a: string): xdr.ScVal {
    return new Address(a).toScVal();
  },
  u64Vec(xs: (number | bigint)[]): xdr.ScVal {
    return xdr.ScVal.scvVec(xs.map((x) => scVal.u64(x)));
  },
};

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { Networks };
