import { BaseWorker } from "../worker.js";
import { scVal, type StellarClient } from "../stellar.js";
import { getLogger } from "../logger.js";

export interface FundingUpdaterDeps {
  stellar: StellarClient;
  fundingContractId: string;
  marketIds: number[];
}

/**
 * Calls `update_funding(market_id)` on the funding contract for each
 * configured market. Runs hourly by default.
 *
 * Failures per-market are logged but do not abort the sweep: one market
 * failing should not block the rest.
 */
export class FundingUpdater extends BaseWorker {
  readonly name = "funding-updater";

  constructor(private readonly deps: FundingUpdaterDeps) {
    super();
    this.log = getLogger(this.name);
  }

  async tick(): Promise<void> {
    const { stellar, fundingContractId, marketIds } = this.deps;
    if (marketIds.length === 0) {
      this.log.warn("no markets configured; skipping");
      return;
    }
    let ok = 0;
    let failed = 0;
    for (const marketId of marketIds) {
      try {
        const res = await stellar.invoke(
          fundingContractId,
          "update_funding",
          [scVal.u32(marketId)],
        );
        this.log.info(
          { marketId, hash: res.hash },
          "funding updated",
        );
        ok += 1;
      } catch (err) {
        failed += 1;
        this.log.error(
          { marketId, err: (err as Error).message },
          "update_funding failed",
        );
      }
    }
    this.log.info({ ok, failed }, "funding sweep complete");
    if (failed > 0 && ok === 0) {
      throw new Error(`all ${failed} funding updates failed`);
    }
  }
}
