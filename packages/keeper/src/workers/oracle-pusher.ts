import { BaseWorker } from "../worker.js";
import { scVal, type StellarClient } from "../stellar.js";
import type { RedStoneFetcher } from "../redstone.js";
import type { Alerter } from "../alert.js";
import { getLogger } from "../logger.js";

export interface OraclePusherDeps {
  stellar: StellarClient;
  fetcher: RedStoneFetcher;
  alerter: Alerter;
  oracleContractId: string;
  feeds: string[];
  stalenessAlertMs: number;
}

/**
 * Pushes RedStone price packages to the oracle contract on a fixed interval.
 *
 * One `tick()` = one fetch + one `write_prices` invocation. If either
 * leg fails, the next tick retries (the StellarClient itself does bounded
 * retries on the submission side). A critical alert is emitted if no
 * successful push has landed within `stalenessAlertMs`.
 */
export class OraclePusher extends BaseWorker {
  readonly name = "oracle-pusher";

  constructor(private readonly deps: OraclePusherDeps) {
    super();
    this.log = getLogger(this.name);
  }

  async tick(): Promise<void> {
    const { stellar, fetcher, alerter, oracleContractId, feeds } = this.deps;

    if (feeds.length === 0) {
      this.log.warn("no feeds configured; skipping");
      return;
    }

    const payload = await fetcher.fetch(feeds);
    this.log.debug(
      { feeds, bytes: payload.bytes.length, ts: payload.timestampMs },
      "fetched payload",
    );

    let res;
    try {
      res = await stellar.invoke(
        oracleContractId,
        "write_prices",
        [scVal.bytes(payload.bytes)],
        {},
      );
    } catch (err) {
      const msg = (err as Error).message ?? "";
      // NonMonotonicTimestamp (#11): the oracle already has this RedStone
      // package (primary-prod refreshes ~every 10 min). Skip silently —
      // next tick will retry with whatever the gateway has at that point.
      if (msg.includes("#11") || msg.includes("NonMonotonicTimestamp")) {
        this.log.debug({ feeds }, "redstone package unchanged; skipping push");
        return;
      }
      throw err;
    }
    this.log.info(
      { hash: res.hash, feeds: feeds.length, bytes: payload.bytes.length },
      "prices pushed",
    );

    // Staleness watchdog based on lastSuccessAt from BaseWorker status.
    const lastOk = this.status.lastSuccessAt ?? Date.now();
    if (Date.now() - lastOk > this.deps.stalenessAlertMs) {
      await alerter.send(
        "critical",
        "oracle-stale",
        `no successful price push in ${Math.round(
          (Date.now() - lastOk) / 1000,
        )}s`,
      );
    }
  }
}
