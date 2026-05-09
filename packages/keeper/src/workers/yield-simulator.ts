import { BaseWorker } from "../worker.js";
import { scVal, type StellarClient } from "../stellar.js";
import { getLogger } from "../logger.js";

/**
 * Phase M.4 — Yield Drip Simulator.
 *
 * On each tick (default: every hour for snappy demos), iterate the indexer's
 * known holders of a given mock RWA token (BENJI / USDY) and call
 * `stellax-rwa-issuer::credit_yield(holders, deltas, epoch_id)` so each
 * holder's balance grows by the **real** published APY pro-rated over the
 * elapsed time since the last credit.
 *
 * ## Idempotency
 * The worker computes each holder's *expected cumulative yield since
 * inception* and credits the delta against the contract's
 * `cumulative_yield(holder)` view. A reorg, restart, or missed tick at most
 * delays — never doubles — payouts.
 *
 * ## APY source
 * The APY is read off-chain from the issuer's public feed (USDY: Ondo API,
 * BENJI: Franklin NAV endpoint) and stored on-chain via
 * `stellax-rwa-issuer::set_apy_bps` so any client can read the current rate
 * without a keeper round-trip.
 *
 * ## Failure modes
 * - Holder list temporarily empty → no-op tick.
 * - Issuer API down → APY left at last-known value (logged).
 * - On-chain `credit_yield` fails → alerter notified; next tick retries.
 */

const SECONDS_PER_YEAR = 365n * 24n * 60n * 60n;
const BPS_DENOMINATOR = 10_000n;

export interface RwaHolder {
  address: string;
  /** Current on-chain balance in native token decimals. */
  balanceNative: bigint;
  /** Cumulative yield credited by this contract so far, native decimals. */
  cumulativeYield: bigint;
  /** Effective start timestamp (sec) used as the integration anchor. */
  sinceTs: number;
}

export interface RwaHolderSource {
  /** The asset symbol e.g. "BENJI" or "USDY". */
  feedId: string;
  /** Returns the current snapshot of holders. */
  getHolders(): Promise<RwaHolder[]>;
}

export interface ApySource {
  /** Returns annualised yield in basis points (e.g. 505 for 5.05% APY). */
  getApyBps(feedId: string): Promise<number>;
}

export interface YieldSimulatorDeps {
  stellar: StellarClient;
  rwaContracts: {
    /** Map of feedId ("BENJI" / "USDY") to deployed `stellax-rwa-issuer` contract id. */
    [feedId: string]: string;
  };
  holderSources: RwaHolderSource[];
  apySource: ApySource;
  /** Maximum number of holders dripped per on-chain call. Soroban tx size cap. */
  batchSize?: number;
  /** Soft cap on tx-per-tick to avoid keeper saturation. */
  maxBatchesPerTick?: number;
}

export class YieldSimulator extends BaseWorker {
  readonly name = "yield-simulator";
  private readonly batchSize: number;
  private readonly maxBatchesPerTick: number;

  constructor(private readonly deps: YieldSimulatorDeps) {
    super();
    this.log = getLogger(this.name);
    this.batchSize = deps.batchSize ?? 25;
    this.maxBatchesPerTick = deps.maxBatchesPerTick ?? 8;
  }

  async tick(): Promise<void> {
    for (const source of this.deps.holderSources) {
      await this.processFeed(source);
    }
  }

  private async processFeed(source: RwaHolderSource): Promise<void> {
    const contractId = this.deps.rwaContracts[source.feedId];
    if (!contractId) {
      this.log.warn({ feedId: source.feedId }, "no contract mapped; skipping");
      return;
    }

    let apyBps: number;
    try {
      apyBps = await this.deps.apySource.getApyBps(source.feedId);
    } catch (err) {
      this.log.warn(
        { err: (err as Error).message, feedId: source.feedId },
        "APY fetch failed; skipping feed this tick",
      );
      return;
    }

    // Mirror the APY on-chain so the frontend tile reads it without us.
    try {
      await this.deps.stellar.invoke(contractId, "set_apy_bps", [
        scVal.u32(apyBps),
      ]);
    } catch (err) {
      this.log.warn(
        { err: (err as Error).message, feedId: source.feedId },
        "set_apy_bps failed (non-fatal)",
      );
    }

    const holders = await source.getHolders();
    if (holders.length === 0) {
      this.log.debug({ feedId: source.feedId }, "no holders; nothing to drip");
      return;
    }

    const nowSec = Math.floor(Date.now() / 1_000);
    const epochId = BigInt(Math.floor(nowSec / 3_600)); // hour bucket

    const deltas: { addr: string; delta: bigint }[] = [];
    for (const h of holders) {
      const elapsed = BigInt(Math.max(0, nowSec - h.sinceTs));
      // expected = balance * apyBps * elapsed / (BPS * SECONDS_PER_YEAR)
      const expected =
        (h.balanceNative * BigInt(apyBps) * elapsed) /
        (BPS_DENOMINATOR * SECONDS_PER_YEAR);
      const delta = expected - h.cumulativeYield;
      if (delta > 0n) {
        deltas.push({ addr: h.address, delta });
      }
    }

    if (deltas.length === 0) {
      this.log.debug(
        { feedId: source.feedId, holders: holders.length },
        "all holders up-to-date",
      );
      return;
    }

    let batches = 0;
    let totalCredited = 0n;
    for (let i = 0; i < deltas.length; i += this.batchSize) {
      if (batches >= this.maxBatchesPerTick) {
        this.log.warn(
          { feedId: source.feedId, remaining: deltas.length - i },
          "batch cap reached; deferring rest to next tick",
        );
        break;
      }
      const slice = deltas.slice(i, i + this.batchSize);
      const addrs = slice.map((d) => d.addr);
      const amounts = slice.map((d) => d.delta);

      const res = await this.deps.stellar.invoke(contractId, "credit_yield", [
        scVal.addressVec(addrs),
        scVal.i128Vec(amounts),
        scVal.u64(epochId),
      ]);
      const sumBatch = slice.reduce((a, d) => a + d.delta, 0n);
      totalCredited += sumBatch;
      batches += 1;
      this.log.info(
        {
          feedId: source.feedId,
          hash: res.hash,
          batch: batches,
          holders: addrs.length,
          credited: sumBatch.toString(),
        },
        "yield drip submitted",
      );
    }

    this.log.info(
      {
        feedId: source.feedId,
        epochId: epochId.toString(),
        batches,
        totalCredited: totalCredited.toString(),
        apyBps,
      },
      "yield-simulator tick complete",
    );
  }
}
