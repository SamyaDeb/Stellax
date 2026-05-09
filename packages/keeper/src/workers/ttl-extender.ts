/**
 * TTL extender — periodically refreshes the on-chain TTL of every StellaX
 * core contract instance and its compiled wasm code.
 *
 * Why: the contracts no longer call `instance().extend_ttl(...)` from inside
 * state-mutating methods (that auto-bumping behaviour pulled the contract
 * code blobs into the per-tx RW footprint and pushed `writeBytes` past the
 * network cap of 132,096). With auto-bump removed, the contracts must be
 * kept alive out-of-band — this worker is that "out-of-band".
 *
 * Strategy: build a single `Operation.extendFootprintTtl` per target with
 * an explicit read-only footprint listing both the contract `<instance>`
 * key and its `<contractCode>` (wasm hash) key, then submit via the
 * keeper's existing `SorobanClient`. No CLI dependency.
 *
 * On any tick failure, the worker retries on the next interval; failures
 * are logged but not alerted (TTL extensions are slack — even at the
 * default 6-hour cadence we have ~7 days of runway from a single
 * successful tick at the 30-day extendTo).
 */
import { BaseWorker } from "../worker.js";
import {
  ledgerKeyContractCode,
  ledgerKeyContractInstance,
  type StellarClient,
} from "../stellar.js";
import { getLogger } from "../logger.js";

export interface TtlExtenderTarget {
  /** Display name for logs (e.g. "perp_engine"). */
  name: string;
  /** Contract id (`C…` strkey). Required. */
  contractId: string;
  /**
   * Wasm hash hex (64 chars). Optional — when provided, the contract code
   * entry is included alongside the instance entry in the same tx.
   */
  wasmHash?: string;
}

export interface TtlExtenderDeps {
  stellar: StellarClient;
  /**
   * Number of ledgers to extend each entry's TTL by. The protocol clamps
   * this to `maxEntryTTL - 1` (~30 days on testnet at 535,680 ledgers).
   */
  ledgersToExtend: number;
  /** Contracts + their wasm hashes to keep alive. */
  targets: TtlExtenderTarget[];
}

export class TtlExtender extends BaseWorker {
  readonly name = "ttl-extender";

  constructor(private readonly deps: TtlExtenderDeps) {
    super();
    this.log = getLogger(this.name);
  }

  async tick(): Promise<void> {
    let extended = 0;
    let failed = 0;

    for (const t of this.deps.targets) {
      if (!t.contractId) {
        this.log.warn({ name: t.name }, "missing contract id; skipping target");
        continue;
      }
      const keys = [ledgerKeyContractInstance(t.contractId)];
      if (t.wasmHash && t.wasmHash.length === 64) {
        keys.push(ledgerKeyContractCode(t.wasmHash));
      }
      try {
        const res = await this.deps.stellar.extendTtl(keys, this.deps.ledgersToExtend);
        this.log.info(
          {
            name: t.name,
            entries: keys.length,
            hash: res.hash,
            ledger: res.latestLedger,
          },
          "ttl extended",
        );
        extended += 1;
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        this.log.error({ name: t.name, err: msg }, "extend failed");
        failed += 1;
      }
    }

    this.log.info(
      { extended, failed, targets: this.deps.targets.length },
      "tick complete",
    );
    if (failed > 0) {
      throw new Error(`ttl-extender: ${failed} target extensions failed this tick`);
    }
  }
}
