/**
 * PriceTicker – horizontal live-price bar shown below the header on all pages.
 *
 * Displays real-time oracle prices (polled every 5 s from the on-chain oracle)
 * and 24-h change percentages from Binance (polled every 30 s).
 *
 * Layout:
 *   [XLM/USD  $0.1682  ▲+0.52%] | [BTC/USD  $75,258  ▲+1.24%] | … | ● ORACLE LIVE
 */

import clsx from "clsx";
import { useBinanceTicker } from "@/hooks/useBinanceOHLC";
import { usePrice } from "@/hooks/queries";
import { fromFixed } from "@/ui/format";

// ── Assets shown in the ticker ────────────────────────────────────────────────

const TICKER_ASSETS = ["XLM", "BTC", "ETH", "SOL"] as const;

// ── Price formatting ──────────────────────────────────────────────────────────

function formatTickerPrice(v: number): string {
  if (v >= 10_000) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (v >= 1_000)  return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (v >= 1)      return v.toFixed(4);
  return v.toFixed(6);
}

// ── Single asset ticker item ──────────────────────────────────────────────────

function TickerItem({ asset }: { asset: string }) {
  const oracle  = usePrice(asset);
  const ticker  = useBinanceTicker(asset);

  const oraclePrice    = oracle.data?.price !== undefined ? fromFixed(oracle.data.price) : null;
  const changePercent  = ticker.data?.priceChangePercent;
  const isUp           = changePercent !== undefined && changePercent >= 0;

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-r border-stella-border last:border-r-0 shrink-0">
      {/* Symbol */}
      <span className="text-[11px] font-bold tracking-wider text-stella-muted uppercase">
        {asset}/USD
      </span>

      {/* Oracle price */}
      <span className="num text-sm font-semibold text-white tabular-nums">
        {oracle.isLoading ? (
          <span className="inline-block h-3.5 w-16 animate-pulse rounded bg-stella-border" />
        ) : oraclePrice !== null ? (
          `$${formatTickerPrice(oraclePrice)}`
        ) : (
          "—"
        )}
      </span>

      {/* 24-h change */}
      {changePercent !== undefined && (
        <span
          className={clsx(
            "num text-[11px] font-semibold tabular-nums",
            isUp ? "text-stella-long" : "text-stella-short",
          )}
        >
          {isUp ? "▲" : "▼"}&nbsp;
          {isUp ? "+" : ""}
          {changePercent.toFixed(2)}%
        </span>
      )}
    </div>
  );
}

// ── Main ticker bar ───────────────────────────────────────────────────────────

export function PriceTicker() {
  return (
    <div className="border-b border-stella-border bg-stella-bg/95">
      <div className="mx-auto flex max-w-[1400px] items-center justify-between">
        {/* Asset prices */}
        <div className="flex items-center overflow-x-auto scrollbar-hide">
          {TICKER_ASSETS.map((asset) => (
            <TickerItem key={asset} asset={asset} />
          ))}
        </div>

        {/* Live oracle indicator */}
        <div className="hidden shrink-0 items-center gap-2 px-5 sm:flex">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-stella-long opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-stella-long" />
          </span>
          <span className="text-[10px] font-semibold uppercase tracking-widest text-stella-muted">
            Oracle Live
          </span>
        </div>
      </div>
    </div>
  );
}
