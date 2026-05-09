/**
 * OrderBook — aggregated limit-order depth chart for the selected market.
 *
 * Fetches open orders from the indexer (`useOrders({ marketId })`), buckets
 * them into ±1% of mid at 0.1% granularity, and renders red asks above the
 * current price and green bids below with horizontal depth bars.
 *
 * Orders placed by the current user are highlighted with a gold left border
 * so traders can see their own quotes in context.
 *
 * Sizes are 18-dec base units; notional per bucket = price × size / 1e18
 * (in USD because price is a USD-per-base quote with 18 decimals).
 */

import { useMemo } from "react";
import { Card } from "@/ui/Card";
import { fromFixed } from "@/ui/format";
import { useOrders } from "@/hooks/useOrders";

interface OrderBookProps {
  marketId: number | null;
  /** 18-dec mark price used as mid reference. */
  markPrice: bigint | undefined;
  /** Connected wallet to highlight own orders. */
  address: string | null;
}

interface Bucket {
  /** Price in USD (human). */
  price: number;
  /** Aggregated base size in human units (18-dec → float). */
  size: number;
  /** Notional USD at this price. */
  notional: number;
  /** Whether any of the orders in the bucket belong to the connected wallet. */
  isOwn: boolean;
}

const BAND_BPS = 10;   // 0.1% per bucket
const HALF_BANDS = 10; // ±1% → 20 buckets total

export function OrderBook({ marketId, markPrice, address }: OrderBookProps) {
  const { orders, connected } = useOrders({ marketId });

  const { bids, asks, maxNotional } = useMemo(
    () => aggregate(orders, markPrice, address),
    [orders, markPrice, address],
  );

  if (marketId === null) {
    return (
      <Card className="terminal-card rounded-none">
        <div className="text-sm text-stella-muted">Select a market to view orders.</div>
      </Card>
    );
  }

  return (
    <Card className="terminal-card rounded-none" padded={false}>
      <div className="flex items-center justify-between border-b terminal-divider px-3 py-2">
        <h3 className="terminal-panel-title">Order Book</h3>
        <span className="text-[10px] uppercase tracking-wide text-stella-muted">
          {connected ? "live" : "offline"}
        </span>
      </div>

      {orders.length === 0 ? (
        <div className="px-3 py-10 text-center">
          <div className="text-xs font-medium text-white">No live liquidity</div>
          <div className="mt-1 text-[11px] text-stella-muted">
            {markPrice === undefined ? "Waiting for a mark price." : "Place a limit order to seed the book."}
          </div>
        </div>
      ) : (
        <div className="px-3 py-2 text-xs">
          <div className="mb-1 grid grid-cols-3 text-[10px] uppercase tracking-wide text-stella-muted">
            <span>Price</span>
            <span className="text-right">Size</span>
            <span className="text-right">Total</span>
          </div>
          {/* Asks (high → low toward mid) */}
          <div className="space-y-0.5">
            {asks.map((b) => (
              <Row key={`ask-${b.price}`} b={b} max={maxNotional} side="ask" />
            ))}
          </div>

          {/* Mid price divider */}
          <div className="my-1 flex items-center justify-between border-y border-stella-border py-1">
            <span className="text-[10px] uppercase tracking-wide text-stella-muted">Mark</span>
            <span className="num text-stella-gold">
              {markPrice !== undefined ? fromFixed(markPrice).toFixed(2) : "—"}
            </span>
          </div>

          {/* Bids (high → low) */}
          <div className="space-y-0.5">
            {bids.map((b) => (
              <Row key={`bid-${b.price}`} b={b} max={maxNotional} side="bid" />
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function Row({ b, max, side }: { b: Bucket; max: number; side: "bid" | "ask" }) {
  const pct = max > 0 ? Math.min(100, (b.notional / max) * 100) : 0;
  const bg = side === "bid" ? "bg-stella-long/15" : "bg-stella-short/15";
  const fg = side === "bid" ? "text-stella-long" : "text-stella-short";
  const ownBorder = b.isOwn ? "border-l-2 border-stella-gold pl-1" : "pl-1.5";
  return (
    <div className={`relative grid grid-cols-3 items-center py-0.5 ${ownBorder}`}>
      <div
        className={`absolute inset-y-0 right-0 ${bg}`}
        style={{ width: `${pct}%` }}
      />
      <span className={`relative num ${fg}`}>{b.price.toFixed(2)}</span>
      <span className="relative num text-right text-stella-muted">{b.size.toFixed(4)}</span>
      <span className="relative num text-right text-white">{formatNotional(b.notional)}</span>
    </div>
  );
}

function formatNotional(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

// ── Aggregation ──────────────────────────────────────────────────────────────

interface AggregateResult {
  bids: Bucket[];
  asks: Bucket[];
  maxNotional: number;
}

function aggregate(
  orders: ReadonlyArray<{ price: string; size: string; filledSize: string; isLong: 0 | 1; trader: string }>,
  markPrice: bigint | undefined,
  address: string | null,
): AggregateResult {
  if (markPrice === undefined || markPrice <= 0n) {
    return { bids: [], asks: [], maxNotional: 0 };
  }
  const mid = fromFixed(markPrice);
  if (!Number.isFinite(mid) || mid <= 0) {
    return { bids: [], asks: [], maxNotional: 0 };
  }

  // Bucket key = signed band index relative to mid (negative = bid, positive = ask).
  // Each band spans BAND_BPS basis points of mid.
  const bandSize = mid * BAND_BPS / 10_000;

  const bucketMap = new Map<number, Bucket>();

  for (const o of orders) {
    const price = fromFixed(BigInt(o.price));
    const total = BigInt(o.size);
    const filled = BigInt(o.filledSize);
    const remaining = total > filled ? total - filled : 0n;
    if (remaining <= 0n) continue;

    const size = fromFixed(remaining);
    if (!Number.isFinite(price) || price <= 0 || size <= 0) continue;

    const delta = price - mid;
    const bandIdx = Math.round(delta / bandSize);
    if (Math.abs(bandIdx) > HALF_BANDS) continue;

    const notional = price * size;
    const bucketPrice = mid + bandIdx * bandSize;
    const isOwn = address !== null && o.trader === address;

    const existing = bucketMap.get(bandIdx);
    if (existing === undefined) {
      bucketMap.set(bandIdx, {
        price: bucketPrice,
        size,
        notional,
        isOwn,
      });
    } else {
      existing.size += size;
      existing.notional += notional;
      if (isOwn) existing.isOwn = true;
    }
  }

  const buckets = Array.from(bucketMap.entries());
  const asks = buckets
    .filter(([idx]) => idx > 0)
    .sort((a, b) => b[0] - a[0])   // highest ask first
    .map(([, v]) => v);
  const bids = buckets
    .filter(([idx]) => idx < 0)
    .sort((a, b) => b[0] - a[0])   // closest to mid first
    .map(([, v]) => v);

  const maxNotional = buckets.reduce((m, [, v]) => Math.max(m, v.notional), 0);

  return { bids, asks, maxNotional };
}
