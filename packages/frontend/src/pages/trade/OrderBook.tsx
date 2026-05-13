/**
 * OrderBook — aggregated limit-order depth for the selected market.
 *
 * Fetches open orders from the indexer, buckets them into ±1% of mid at
 * 0.1% granularity. Asks are red (above mid), bids are green (below).
 * Own orders get a gold left border. Depth bars are proportional fills.
 */

import { useMemo } from "react";
import { fromFixed } from "@/ui/format";
import { useOrders } from "@/hooks/useOrders";

interface OrderBookProps {
  marketId: number | null;
  markPrice: bigint | undefined;
  address: string | null;
}

interface Bucket {
  price: number;
  size: number;
  notional: number;
  isOwn: boolean;
}

const BAND_BPS   = 10;
const HALF_BANDS = 10;

export function OrderBook({ marketId, markPrice, address }: OrderBookProps) {
  const { orders, connected } = useOrders({ marketId });

  const { bids, asks, maxNotional } = useMemo(
    () => aggregate(orders, markPrice, address),
    [orders, markPrice, address],
  );

  if (marketId === null) {
    return (
      <div style={{ padding: "16px 12px", fontSize: 11, color: "var(--t3)" }}>
        Select a market.
      </div>
    );
  }

  const topAsk = asks.length > 0 ? asks[asks.length - 1] : undefined;
  const topBid = bids.length > 0 ? bids[0] : undefined;
  const mid = markPrice !== undefined ? fromFixed(markPrice) : null;
  const spread = topAsk !== undefined && topBid !== undefined
    ? topAsk.price - topBid.price : null;
  const spreadPct = spread !== null && mid !== null && mid > 0
    ? (spread / mid) * 100 : null;

  return (
    <div>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span className="terminal-panel-title">Order Book</span>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span
            style={{
              width: 5, height: 5, borderRadius: "50%",
              background: connected ? "var(--green)" : "var(--t3)",
              display: "inline-block",
            }}
          />
          <span style={{ fontSize: 9, color: "var(--t3)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
            {connected ? "live" : "offline"}
          </span>
        </div>
      </div>

      {orders.length === 0 ? (
        <div style={{ padding: "28px 12px", textAlign: "center" }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--t2)" }}>No liquidity</div>
          <div style={{ fontSize: 10, color: "var(--t3)", marginTop: 4 }}>
            {markPrice === undefined
              ? "Waiting for mark price."
              : "Place a limit order to seed the book."}
          </div>
        </div>
      ) : (
        <div style={{ padding: "6px 0" }}>
          {/* Column headers */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              padding: "0 10px",
              marginBottom: 4,
              fontSize: 9,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              color: "var(--t3)",
            }}
          >
            <span>Price (USD)</span>
            <span style={{ textAlign: "right" }}>Size</span>
            <span style={{ textAlign: "right" }}>Total</span>
          </div>

          {/* Asks */}
          {asks.map((b) => (
            <BookRow key={`ask-${b.price}`} b={b} max={maxNotional} side="ask" />
          ))}

          {/* Mid / Spread row */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              alignItems: "center",
              margin: "4px 8px",
              padding: "6px 8px",
              border: "1px solid var(--border2)",
              background: "var(--bg2)",
              borderRadius: 2,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 9, color: "var(--t3)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                Mark
              </span>
              <span className="num" style={{ fontSize: 13, fontWeight: 700, color: "var(--gold)" }}>
                {mid !== null ? mid.toFixed(2) : "—"}
              </span>
            </div>
            {spreadPct !== null && (
              <div style={{ textAlign: "right" }}>
                <span style={{ fontSize: 9, color: "var(--t3)" }}>Spread </span>
                <span className="num" style={{ fontSize: 10, color: "var(--t2)" }}>
                  {spreadPct.toFixed(3)}%
                </span>
              </div>
            )}
          </div>

          {/* Bids */}
          {bids.map((b) => (
            <BookRow key={`bid-${b.price}`} b={b} max={maxNotional} side="bid" />
          ))}
        </div>
      )}
    </div>
  );
}

function BookRow({ b, max, side }: { b: Bucket; max: number; side: "bid" | "ask" }) {
  const pct = max > 0 ? Math.min(100, (b.notional / max) * 100) : 0;
  const textColor   = side === "bid" ? "var(--green)" : "var(--red)";
  const fillColor   = side === "bid" ? "var(--green-dim)" : "var(--red-dim)";
  const ownStyle = b.isOwn
    ? { borderLeft: "2px solid var(--gold)", paddingLeft: 4 }
    : { paddingLeft: 6 };

  return (
    <div
      style={{
        position: "relative",
        display: "grid",
        gridTemplateColumns: "1fr 1fr 1fr",
        alignItems: "center",
        padding: "2px 10px",
        ...ownStyle,
      }}
    >
      {/* Depth fill */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          right: 0,
          left: "auto",
          width: `${pct}%`,
          background: fillColor,
          pointerEvents: "none",
        }}
      />
      <span className="num" style={{ position: "relative", fontSize: 11, color: textColor }}>
        {b.price.toFixed(2)}
      </span>
      <span className="num" style={{ position: "relative", fontSize: 11, color: "var(--t2)", textAlign: "right" }}>
        {b.size.toFixed(4)}
      </span>
      <span className="num" style={{ position: "relative", fontSize: 11, color: "var(--t1)", textAlign: "right" }}>
        {fmtNotional(b.notional)}
      </span>
    </div>
  );
}

function fmtNotional(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
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
  if (markPrice === undefined || markPrice <= 0n) return { bids: [], asks: [], maxNotional: 0 };
  const mid = fromFixed(markPrice);
  if (!Number.isFinite(mid) || mid <= 0) return { bids: [], asks: [], maxNotional: 0 };

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

    const delta  = price - mid;
    const bandIdx = Math.round(delta / bandSize);
    if (Math.abs(bandIdx) > HALF_BANDS) continue;

    const notional   = price * size;
    const bucketPrice = mid + bandIdx * bandSize;
    const isOwn      = address !== null && o.trader === address;

    const existing = bucketMap.get(bandIdx);
    if (existing === undefined) {
      bucketMap.set(bandIdx, { price: bucketPrice, size, notional, isOwn });
    } else {
      existing.size     += size;
      existing.notional += notional;
      if (isOwn) existing.isOwn = true;
    }
  }

  const buckets = Array.from(bucketMap.entries());
  const asks = buckets
    .filter(([idx]) => idx > 0)
    .sort((a, b) => b[0] - a[0])
    .map(([, v]) => v);
  const bids = buckets
    .filter(([idx]) => idx < 0)
    .sort((a, b) => b[0] - a[0])
    .map(([, v]) => v);

  const maxNotional = buckets.reduce((m, [, v]) => Math.max(m, v.notional), 0);
  return { bids, asks, maxNotional };
}
