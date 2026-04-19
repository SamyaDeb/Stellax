import { BaseWorker } from "../worker.js";
import { scVal, type StellarClient } from "../stellar.js";
import { getLogger } from "../logger.js";

/**
 * Source of option expiry information.
 *
 * Pluggable so the keeper itself stays indexer-agnostic. The returned
 * list should contain every option whose `expiry <= now` that has not
 * yet been settled.
 */
export interface OptionExpirySource {
  getExpiredUnsettled(nowSeconds: number): Promise<bigint[]>;
}

export interface OptionSettlerDeps {
  stellar: StellarClient;
  optionsContractId: string;
  expiries: OptionExpirySource;
  /** Max option IDs per settle_expired_options call to control tx size. */
  batchSize: number;
}

/**
 * Settles options that passed their expiry timestamp in batches.
 *
 * The on-chain contract exposes `settle_expired_options(Vec<u64>)` which
 * iterates ids and runs the appropriate payout for each. Batching reduces
 * overhead but each batch must fit in the Soroban resource limits, so the
 * keeper caps it.
 */
export class OptionSettler extends BaseWorker {
  readonly name = "option-settler";

  constructor(private readonly deps: OptionSettlerDeps) {
    super();
    this.log = getLogger(this.name);
  }

  async tick(): Promise<void> {
    const { stellar, optionsContractId, expiries, batchSize } = this.deps;
    if (!optionsContractId) {
      this.log.debug("no options contract configured; skipping");
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const ids = await expiries.getExpiredUnsettled(now);
    if (ids.length === 0) {
      this.log.debug("no options to settle");
      return;
    }
    this.log.info({ count: ids.length }, "settling expired options");

    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      try {
        const res = await stellar.invoke(
          optionsContractId,
          "settle_expired_options",
          [scVal.u64Vec(batch)],
        );
        this.log.info(
          { batchSize: batch.length, hash: res.hash },
          "batch settled",
        );
      } catch (err) {
        this.log.error(
          { err: (err as Error).message, batchSize: batch.length },
          "settle batch failed",
        );
        // Continue with remaining batches.
      }
    }
  }
}
