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
  Operation,
  rpc as SorobanRpc,
  SorobanDataBuilder,
  StrKey,
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
  /**
   * Extend the TTL of one or more ledger entries via a raw
   * `Operation.extendFootprintTtl` (no contract method invocation). The
   * footprint must list every entry to bump as read-only — Soroban does not
   * accept RW entries here. Returns the tx hash on success.
   */
  extendTtl(
    keys: xdr.LedgerKey[],
    extendToLedgers: number,
    opts?: { timeoutSeconds?: number; maxRetries?: number },
  ): Promise<{ hash: string; latestLedger: number }>;
}

export interface StellarClientOptions {
  rpcUrl: string;
  horizonUrl: string;
  networkPassphrase: string;
  secretKey: string;
}

const BASE_FEE = 1_000_000; // 0.1 XLM — Soroban txs need high base fees

export class SorobanClient implements StellarClient {
  private readonly server: SorobanRpc.Server;
  private readonly keypair: Keypair;
  private readonly networkPassphrase: string;
  private readonly horizonUrl: string;
  private readonly log: Logger;

  /**
   * Serialises all transactions through a single-entry mutex so concurrent
   * workers never race on account sequence numbers (txBadSeq).
   */
  private txQueue: Promise<void> = Promise.resolve();

  constructor(opts: StellarClientOptions) {
    this.server = new SorobanRpc.Server(opts.rpcUrl, {
      allowHttp: opts.rpcUrl.startsWith("http://"),
    });
    this.keypair = Keypair.fromSecret(opts.secretKey);
    this.networkPassphrase = opts.networkPassphrase;
    this.horizonUrl = opts.horizonUrl.replace(/\/$/, "");
    this.log = getLogger("soroban");
  }

  publicKey(): string {
    return this.keypair.publicKey();
  }

  async getAccountBalanceStroops(): Promise<bigint> {
    // Soroban RPC's getAccount only returns sequence info, not balances.
    // Fetch from Horizon instead.
    const url = `${this.horizonUrl}/accounts/${this.keypair.publicKey()}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Horizon accounts fetch failed: HTTP ${resp.status}`);
    }
    const data = (await resp.json()) as {
      balances?: { asset_type: string; balance: string }[];
    };
    const native = data.balances?.find((b) => b.asset_type === "native");
    if (!native) return 0n;
    // Horizon balance is in XLM (e.g. "17862.0223428"); convert to stroops.
    return BigInt(Math.floor(Number(native.balance) * 1e7));
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
    // Enqueue behind any in-flight transaction to avoid txBadSeq races.
    let releaseQueue!: () => void;
    const prev = this.txQueue;
    this.txQueue = new Promise<void>((resolve) => { releaseQueue = resolve; });
    await prev;

    try {
      return await this._invokeInner<T>(contractId, method, args, opts);
    } finally {
      releaseQueue();
    }
  }

  private async _invokeInner<T = unknown>(
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
        // Poll for final status. Wrap the entire polling + return-value
        // parsing block in its own try-catch: some SDK versions throw
        // "Bad union switch: N" when decoding void/unit XDR return values
        // (e.g. from Result<(), ContractError>::Ok(())). If that happens
        // after a successful submission we still want to return SUCCESS.
        try {
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
          let decoded: T;
          try {
            const retVal =
              (status as SorobanRpc.Api.GetSuccessfulTransactionResponse).returnValue;
            decoded = retVal ? (scValToNative(retVal) as T) : (undefined as T);
          } catch (_parseErr) {
            decoded = undefined as T;
          }
          return {
            hash: sent.hash,
            status: "SUCCESS",
            returnValue: decoded,
            latestLedger: status.latestLedger,
          };
        } catch (pollErr) {
          // If XDR parse error after successful send, treat as success.
          if ((pollErr as Error).message?.includes("Bad union switch")) {
            this.log.debug(
              { method, hash: sent.hash },
              "void return value from successful tx (XDR parse skipped)",
            );
            return {
              hash: sent.hash,
              status: "SUCCESS",
              returnValue: undefined as T,
              latestLedger: 0,
            };
          }
          throw pollErr;
        }
      } catch (err) {
        lastErr = err;
        // Simulation-time contract errors are deterministic — the payload and
        // args won't change between retries, so the outcome is always the same.
        // Throw immediately instead of burning retry budget on a certain loss.
        const msg = (err as Error)?.message ?? "";
        if (msg.startsWith("Simulation failed:") && msg.includes("HostError: Error(Contract,")) {
          throw err;
        }
        const delay = 500 * 2 ** attempt;
        this.log.warn(
          { method, attempt, delay, err: msg },
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

  /**
   * Submit `Operation.extendFootprintTtl` with an explicit read-only footprint.
   *
   * Used by the TTL-extender worker to bump contract instance and contract
   * code (wasm) entries out-of-band, replacing the in-contract `extend_ttl`
   * calls that previously inflated every state-mutating tx's write footprint
   * past `txMaxWriteBytes`.
   */
  async extendTtl(
    keys: xdr.LedgerKey[],
    extendToLedgers: number,
    opts: { timeoutSeconds?: number; maxRetries?: number } = {},
  ): Promise<{ hash: string; latestLedger: number }> {
    if (keys.length === 0) {
      throw new Error("extendTtl: keys must be non-empty");
    }
    const maxRetries = opts.maxRetries ?? 3;
    const timeout = opts.timeoutSeconds ?? 60;

    // Serialise behind the same queue used by invoke() to avoid txBadSeq.
    let releaseQueue!: () => void;
    const prev = this.txQueue;
    this.txQueue = new Promise<void>((resolve) => { releaseQueue = resolve; });
    await prev;

    try {
      let attempt = 0;
      let lastErr: unknown;
      while (attempt <= maxRetries) {
        try {
          const account = await this.loadAccount();
          // Pre-seed the footprint so simulation has something to refine.
          // Soroban simulation will recompute resources but it needs the
          // ledger keys to know what to bump.
          const sorobanData = new SorobanDataBuilder()
            .setReadOnly(keys)
            .setReadWrite([])
            .build();
          const tx = new TransactionBuilder(account, {
            fee: BASE_FEE.toString(),
            networkPassphrase: this.networkPassphrase,
          })
            .setSorobanData(sorobanData)
            .addOperation(
              Operation.extendFootprintTtl({ extendTo: extendToLedgers }),
            )
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
            throw new Error(
              `sendTransaction error: ${JSON.stringify(sent.errorResult)}`,
            );
          }

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
            throw new Error(`extendTtl tx ${sent.hash} status=${status.status}`);
          }
          return { hash: sent.hash, latestLedger: status.latestLedger };
        } catch (err) {
          lastErr = err;
          const msg = (err as Error)?.message ?? "";
          if (
            msg.startsWith("Simulation failed:") &&
            msg.includes("HostError: Error(Contract,")
          ) {
            throw err;
          }
          const delay = 500 * 2 ** attempt;
          this.log.warn(
            { op: "extendTtl", attempt, delay, err: msg },
            "extendTtl attempt failed; will retry",
          );
          attempt += 1;
          if (attempt > maxRetries) break;
          await sleep(delay);
        }
      }
      throw new Error(
        `extendTtl failed after ${maxRetries + 1} attempts: ${
          (lastErr as Error)?.message
        }`,
      );
    } finally {
      releaseQueue();
    }
  }
}

/**
 * Build the LedgerKey for a contract's `<instance>` storage entry.
 * This is the same key the protocol bumps when you call
 * `instance().extend_ttl(...)` from inside a contract.
 */
export function ledgerKeyContractInstance(contractId: string): xdr.LedgerKey {
  const contract = StrKey.decodeContract(contractId);
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      contract: xdr.ScAddress.scAddressTypeContract(contract as any),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

/**
 * Build the LedgerKey for a deployed wasm blob (the `<contractCode>` entry
 * keyed by the wasm hash). Bumping this prevents the code from being
 * archived out from under the contract instance.
 */
export function ledgerKeyContractCode(wasmHashHex: string): xdr.LedgerKey {
  if (wasmHashHex.length !== 64) {
    throw new Error(
      `ledgerKeyContractCode: wasm hash must be 64 hex chars, got ${wasmHashHex.length}`,
    );
  }
  const hashBuf = Buffer.from(wasmHashHex, "hex");
  if (hashBuf.length !== 32) {
    throw new Error(`ledgerKeyContractCode: invalid hex (decoded ${hashBuf.length} bytes)`);
  }
  return xdr.LedgerKey.contractCode(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new xdr.LedgerKeyContractCode({ hash: hashBuf as any }),
  );
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
  addressVec(xs: string[]): xdr.ScVal {
    return xdr.ScVal.scvVec(xs.map((x) => scVal.address(x)));
  },
  i128Vec(xs: (number | bigint)[]): xdr.ScVal {
    return xdr.ScVal.scvVec(xs.map((x) => scVal.i128(x)));
  },
};

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { Networks };
