import { BaseWorker } from "../worker.js";
import { scVal, type StellarClient } from "../stellar.js";
import { getLogger } from "../logger.js";

/**
 * A minimal view of an open limit order — enough for the matcher to decide
 * which pairs to settle on-chain. Field names mirror the on-chain
 * `LimitOrder` struct; the bigint types follow SDK conventions.
 */
export interface OpenOrder {
  orderId: bigint;
  trader: string;
  marketId: number;
  /** `true` = bid (buy), `false` = ask (sell). */
  isLong: boolean;
  /** Limit price in oracle scale (1e8). */
  price: bigint;
  /** Order size (1e8 scale). */
  size: bigint;
  /** Already filled portion (1e8 scale). */
  filledSize: bigint;
  /** Unix seconds. */
  expiresAt: number;
}

/**
 * Pluggable order-book source.
 *
 * Like the other data sources in the keeper, the matcher does not index the
 * chain itself. In production this is backed by the event indexer (Phase H)
 * which maintains the open book; in tests an in-memory list is injected.
 */
export interface OrderBookSource {
  /** Returns all currently Open (or partially filled) orders, any market. */
  getOpenOrders(): Promise<OpenOrder[]>;
}

export interface ClobMatcherDeps {
  stellar: StellarClient;
  clobContractId: string;
  book: OrderBookSource;
  /** Optional cap on settlements per tick (protects against runaway books). */
  maxFillsPerTick?: number;
}

interface MatchPair {
  buy: OpenOrder;
  sell: OpenOrder;
}

/**
 * CLOB order matcher keeper worker.
 *
 * Each tick:
 *   1. Pulls the current open book from the indexer.
 *   2. Groups orders by `marketId`; within each market, sorts bids desc and
 *      asks asc by price.
 *   3. Walks the crossed book (best bid ≥ best ask) and pairs orders
 *      greedily, producing a list of `MatchPair`s. Each order is used at
 *      most once per tick — on-chain settlement updates `filled_size` and
 *      status, so the next tick's snapshot reflects reality.
 *   4. Submits `settle_matched_orders(keeper, buyId, sellId)` for each pair.
 *      Errors are logged (another keeper may have won the race) and the
 *      next tick retries with a fresh snapshot.
 *
 * Price-time priority is approximated by ordering equal-priced orders by
 * ascending `orderId` (earliest placed wins). Partial fills are handled by
 * the on-chain contract — the matcher only decides *which* orders to pair.
 */
export class ClobMatcher extends BaseWorker {
  readonly name = "clob-matcher";

  constructor(private readonly deps: ClobMatcherDeps) {
    super();
    this.log = getLogger(this.name);
  }

  async tick(): Promise<void> {
    const { stellar, clobContractId, book } = this.deps;
    const maxFills = this.deps.maxFillsPerTick ?? 50;

    const orders = await book.getOpenOrders();
    if (orders.length === 0) {
      this.log.debug("empty book");
      return;
    }

    const pairs = matchBook(orders, maxFills);
    this.log.info(
      { orders: orders.length, pairs: pairs.length },
      "book scanned",
    );
    if (pairs.length === 0) return;

    let settled = 0;
    let failed = 0;
    for (const { buy, sell } of pairs) {
      try {
        const res = await stellar.invoke(
          clobContractId,
          "settle_matched_orders",
          [
            scVal.address(stellar.publicKey()),
            scVal.u64(buy.orderId),
            scVal.u64(sell.orderId),
          ],
          { maxRetries: 1 }, // races are expected; rely on next tick
        );
        settled += 1;
        this.log.info(
          {
            marketId: buy.marketId,
            buyId: buy.orderId.toString(),
            sellId: sell.orderId.toString(),
            hash: res.hash,
          },
          "orders matched",
        );
      } catch (err) {
        failed += 1;
        this.log.warn(
          {
            buyId: buy.orderId.toString(),
            sellId: sell.orderId.toString(),
            err: (err as Error).message,
          },
          "settle_matched_orders failed (race or stale book)",
        );
      }
    }

    this.log.info({ settled, failed }, "tick complete");
  }
}

/**
 * Pure function: given a snapshot of open orders, produce a list of
 * buy/sell pairs that cross. Exported for unit tests.
 */
export function matchBook(orders: OpenOrder[], maxPairs: number): MatchPair[] {
  const byMarket = new Map<number, OpenOrder[]>();
  for (const o of orders) {
    // Skip exhausted orders defensively — the indexer *should* not return them.
    if (o.filledSize >= o.size) continue;
    const bucket = byMarket.get(o.marketId);
    if (bucket) bucket.push(o);
    else byMarket.set(o.marketId, [o]);
  }

  const pairs: MatchPair[] = [];
  for (const market of byMarket.values()) {
    const bids = market
      .filter((o) => o.isLong)
      .sort((a, b) => {
        if (a.price === b.price) {
          return a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0;
        }
        // higher price first
        return a.price < b.price ? 1 : -1;
      });
    const asks = market
      .filter((o) => !o.isLong)
      .sort((a, b) => {
        if (a.price === b.price) {
          return a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0;
        }
        // lower price first
        return a.price < b.price ? -1 : 1;
      });

    let i = 0;
    let j = 0;
    while (i < bids.length && j < asks.length && pairs.length < maxPairs) {
      const bid = bids[i]!;
      const ask = asks[j]!;
      if (bid.trader === ask.trader) {
        // Self-match — skip the later order (advance the larger orderId).
        if (bid.orderId > ask.orderId) i += 1;
        else j += 1;
        continue;
      }
      if (bid.price >= ask.price) {
        pairs.push({ buy: bid, sell: ask });
        i += 1;
        j += 1;
      } else {
        // Book no longer crosses in this market.
        break;
      }
    }
    if (pairs.length >= maxPairs) break;
  }

  return pairs;
}
