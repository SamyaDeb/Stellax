import { BaseWorker } from "../worker.js";
import type { StellarClient } from "../stellar.js";
import type { Alerter } from "../alert.js";
import { getLogger } from "../logger.js";
import {
  pushRwaNavToOracle,
  type RwaNavFetcher,
  type RwaNavSample,
} from "../rwa-nav.js";

/**
 * Tier 1 — RWA price pusher.
 *
 * Each tick: for every configured feed
 *   1. fetch a multi-source aggregated sample (median + deviation filter)
 *   2. compare the new price against the last on-chain push:
 *        - if `|Δ| < minDeviationBps` AND `now - lastPushTs < forcePushMs` → skip
 *        - else                                                            → push
 *   3. on failure, increment per-feed failure counter; emit a critical alert
 *      after `failureAlertThreshold` consecutive misses.
 *
 * Exposes `getMetrics()` so the keeper's `/metrics` endpoint can publish
 * Prometheus gauges per symbol.
 */
export interface RwaNavPusherDeps {
  stellar: StellarClient;
  fetcher: RwaNavFetcher;
  alerter: Alerter;
  oracleContractId: string;
  feeds: string[]; // ["BENJI", "USDY", "OUSG"]
  /** Skip on-chain push when price moved less than this and not yet stale. */
  minDeviationBps: number;
  /** Always push if at least this long has elapsed since last push. */
  forcePushMs: number;
  /** Alert threshold for consecutive tick failures. */
  failureAlertThreshold?: number;
  /** Legacy field — kept for backwards compatibility with existing config wiring. */
  stalenessAlertMs?: number;
}

export interface RwaPriceFeedMetrics {
  feedId: string;
  lastPushTs: number | null;
  lastPushedPriceUsd: number | null;
  lastSource: string | null;
  consecutiveFailures: number;
  totalSuccesses: number;
  totalFailures: number;
  totalSkippedNoChange: number;
}

export interface RwaPriceMetrics {
  feeds: RwaPriceFeedMetrics[];
}

const DEFAULT_FAILURE_ALERT_THRESHOLD = 8;

export class RwaNavPusher extends BaseWorker {
  readonly name = "rwa-nav-pusher";

  private readonly metricsByFeed = new Map<string, RwaPriceFeedMetrics>();

  constructor(private readonly deps: RwaNavPusherDeps) {
    super();
    this.log = getLogger(this.name);
    for (const feedId of deps.feeds) {
      this.metricsByFeed.set(feedId.toUpperCase(), {
        feedId: feedId.toUpperCase(),
        lastPushTs: null,
        lastPushedPriceUsd: null,
        lastSource: null,
        consecutiveFailures: 0,
        totalSuccesses: 0,
        totalFailures: 0,
        totalSkippedNoChange: 0,
      });
    }
  }

  async tick(): Promise<void> {
    if (this.deps.feeds.length === 0) {
      this.log.warn("no RWA feeds configured; skipping");
      return;
    }
    const threshold =
      this.deps.failureAlertThreshold ?? DEFAULT_FAILURE_ALERT_THRESHOLD;

    for (const rawFeed of this.deps.feeds) {
      const feedId = rawFeed.toUpperCase();
      const m = this.metricsByFeed.get(feedId);
      if (!m) continue;

      try {
        const sample = await this.deps.fetcher.fetch(feedId);
        const newPriceUsd = sample18ToUsd(sample.price18);
        const shouldPush = this.shouldPush(m, newPriceUsd);
        if (shouldPush) {
          await this.pushOne(sample);
          m.lastPushTs = Date.now();
          m.lastPushedPriceUsd = newPriceUsd;
          m.lastSource = sample.source;
          m.totalSuccesses++;
        } else {
          m.totalSkippedNoChange++;
          this.log.debug(
            {
              feedId,
              priceUsd: newPriceUsd,
              lastPriceUsd: m.lastPushedPriceUsd,
            },
            "skip push (deviation below threshold)",
          );
        }
        m.consecutiveFailures = 0;
      } catch (err) {
        m.consecutiveFailures++;
        m.totalFailures++;
        this.log.error(
          {
            err: (err as Error).message,
            feedId,
            consecutiveFailures: m.consecutiveFailures,
          },
          "rwa price tick failed",
        );

        if (m.consecutiveFailures === threshold) {
          await this.deps.alerter.send(
            "critical",
            "rwa-price-source-down",
            `${feedId}: ${m.consecutiveFailures} consecutive price-fetch failures; trades for this market may halt soon`,
          );
        }
      }
    }
  }

  /**
   * Force-push when nothing has been pushed yet OR `forcePushMs` has elapsed
   * since the last push. Otherwise only push if the price moved more than
   * `minDeviationBps` from the last on-chain value.
   */
  private shouldPush(m: RwaPriceFeedMetrics, newPriceUsd: number): boolean {
    if (m.lastPushTs === null || m.lastPushedPriceUsd === null) return true;
    const ageMs = Date.now() - m.lastPushTs;
    if (ageMs >= this.deps.forcePushMs) return true;
    const deviationBps =
      (Math.abs(newPriceUsd - m.lastPushedPriceUsd) / m.lastPushedPriceUsd) *
      10_000;
    return deviationBps >= this.deps.minDeviationBps;
  }

  private async pushOne(sample: RwaNavSample): Promise<void> {
    const hash = await pushRwaNavToOracle({
      stellar: this.deps.stellar,
      oracleContractId: this.deps.oracleContractId,
      sample,
    });
    this.log.info(
      {
        hash,
        feedId: sample.feedId,
        price18: sample.price18.toString(),
        source: sample.source,
        timestampMs: sample.timestampMs,
      },
      "rwa nav pushed",
    );
  }

  /** Read-only snapshot for the health/metrics server. */
  getMetrics(): RwaPriceMetrics {
    return {
      feeds: Array.from(this.metricsByFeed.values()).map((m) => ({ ...m })),
    };
  }
}

function sample18ToUsd(price18: bigint): number {
  // 18-dec fixed point → float; safe for prices in normal RWA range.
  return Number(price18) / 1e18;
}
