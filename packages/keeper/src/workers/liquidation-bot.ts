import { BaseWorker } from "../worker.js";
import { scVal, type StellarClient } from "../stellar.js";
import type { Alerter } from "../alert.js";
import { getLogger } from "../logger.js";

export interface PositionLike {
  positionId: bigint;
  user: string;
  marketId: number;
}

/**
 * Pluggable position source.
 *
 * The keeper does not index the chain itself. In production this is backed
 * by the off-chain indexer (see {@link IndexerPositionSource}) which watches
 * Soroban events. In tests a simple in-memory list is injected.
 */
export interface PositionSource {
  getOpenPositions(): Promise<PositionLike[]>;
}

/**
 * Fetches open positions from the StellaX indexer REST endpoint.
 *
 * The indexer exposes `GET /positions` returning an array of row objects with
 * `position_id`, `user`, `market_id`. Extra fields are ignored.
 *
 * Network errors are swallowed and surface as an empty list; the keeper tick
 * will simply find no liquidatable positions and retry next cycle.
 */
export class IndexerPositionSource implements PositionSource {
  private readonly log = getLogger("indexer-pos-src");

  constructor(private readonly indexerUrl: string) {}

  async getOpenPositions(): Promise<PositionLike[]> {
    try {
      const res = await fetch(`${this.indexerUrl.replace(/\/$/, "")}/positions`);
      if (!res.ok) {
        this.log.warn({ status: res.status }, "indexer /positions non-200");
        return [];
      }
      const rows = (await res.json()) as Array<{
        positionId?: string | number;
        position_id?: string | number;
        user: string;
        marketId?: number;
        market_id?: number;
      }>;
      return rows.map((r) => ({
        positionId: BigInt((r.positionId ?? r.position_id ?? 0).toString()),
        user: r.user,
        marketId: Number(r.marketId ?? r.market_id ?? 0),
      }));
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, "indexer fetch failed");
      return [];
    }
  }
}

export interface LiquidationBotDeps {
  stellar: StellarClient;
  riskContractId: string;
  positions: PositionSource;
  alerter: Alerter;
  /** Margin ratio below which a position is considered "near liquidation". */
  warningThresholdBps: number;
}

interface Health {
  marginRatioBps: number;
  liquidatable: boolean;
}

/**
 * Monitors open positions and liquidates those under maintenance margin.
 *
 * Each tick:
 *   1. Fetches the current open-position set from the indexer.
 *   2. For each position, simulates `get_account_health(user)` to get the
 *      margin ratio (free, no fee).
 *   3. If liquidatable, submits `liquidate(position_id)`.
 *   4. Prioritises the most underwater positions first.
 *
 * The simulate step keeps the operation cost near-zero when no liquidations
 * are needed — only actual liquidations consume gas.
 */
export class LiquidationBot extends BaseWorker {
  readonly name = "liquidation-bot";

  constructor(private readonly deps: LiquidationBotDeps) {
    super();
    this.log = getLogger(this.name);
  }

  async tick(): Promise<void> {
    const { stellar, riskContractId, positions, alerter } = this.deps;
    const openPositions = await positions.getOpenPositions();
    if (openPositions.length === 0) {
      this.log.debug("no open positions");
      return;
    }

    // 1. Gather health for each distinct user.
    const users = Array.from(new Set(openPositions.map((p) => p.user)));
    const health = new Map<string, Health>();
    for (const user of users) {
      try {
        const sim = await stellar.simulate<Health | null>(
          riskContractId,
          "get_account_health",
          [scVal.address(user)],
        );
        if (sim.returnValue && typeof sim.returnValue === "object") {
          health.set(user, sim.returnValue as Health);
        }
      } catch (err) {
        this.log.warn(
          { user, err: (err as Error).message },
          "get_account_health simulate failed",
        );
      }
    }

    // 2. Select candidates: sort most-underwater first (lowest margin ratio).
    const candidates = openPositions
      .filter((p) => {
        const h = health.get(p.user);
        return h !== undefined && h.liquidatable;
      })
      .sort((a, b) => {
        const ha = health.get(a.user)?.marginRatioBps ?? Number.MAX_SAFE_INTEGER;
        const hb = health.get(b.user)?.marginRatioBps ?? Number.MAX_SAFE_INTEGER;
        return ha - hb;
      });

    this.log.info(
      {
        users: users.length,
        positions: openPositions.length,
        liquidatable: candidates.length,
      },
      "scan complete",
    );

    // 3. Execute liquidations.
    let liquidated = 0;
    let failed = 0;
    for (const pos of candidates) {
      try {
        const res = await stellar.invoke(
          riskContractId,
          "liquidate",
          [scVal.u64(pos.positionId)],
          { maxRetries: 1 }, // don't retry much — another keeper may beat us
        );
        liquidated += 1;
        this.log.info(
          {
            positionId: pos.positionId.toString(),
            user: pos.user,
            hash: res.hash,
          },
          "position liquidated",
        );
      } catch (err) {
        failed += 1;
        this.log.warn(
          {
            positionId: pos.positionId.toString(),
            err: (err as Error).message,
          },
          "liquidate failed (another keeper may have won the race)",
        );
      }
    }

    // 4. Near-liquidation warning.
    const near = openPositions.filter((p) => {
      const h = health.get(p.user);
      return (
        h !== undefined &&
        !h.liquidatable &&
        h.marginRatioBps <= this.deps.warningThresholdBps
      );
    });
    if (near.length > 0) {
      this.log.info({ near: near.length }, "positions near liquidation");
    }

    if (candidates.length > 0 && liquidated === 0) {
      await alerter.send(
        "warn",
        "liquidation-bot",
        `${candidates.length} liquidatable positions detected but none liquidated (all ${failed} attempts failed)`,
      );
    }
  }
}
