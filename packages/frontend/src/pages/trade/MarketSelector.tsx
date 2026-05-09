import clsx from "clsx";
import { useMemo, useState } from "react";
import type { Market } from "@stellax/sdk";
import { useBinanceTicker, useRwaTicker } from "@/hooks/useBinanceOHLC";
import { usePrice } from "@/hooks/queries";
import { fromFixed } from "@/ui/format";

interface ChipProps {
  market: Market;
  selected: boolean;
  onSelect: () => void;
}

function MarketChip({ market, selected, onSelect }: ChipProps) {
  const isRwa = market.badge === "RWA";
  const ticker = useBinanceTicker(isRwa ? null : market.baseAsset);
  const rwaTicker = useRwaTicker(isRwa ? market.baseAsset : null);
  const oracle = usePrice(isRwa ? market.baseAsset : null);
  const pct = isRwa ? rwaTicker.data?.priceChangePercent : ticker.data?.priceChangePercent;
  const price = isRwa && oracle.data?.price !== undefined
    ? fromFixed(oracle.data.price)
    : isRwa
      ? rwaTicker.data?.lastPrice
      : ticker.data?.lastPrice;

  return (
    <button
      onClick={onSelect}
      className={clsx(
        "group grid w-full grid-cols-[1fr_auto] items-center gap-2 border-l-2 px-3 py-2 text-left transition-colors",
        selected
          ? "border-l-stella-gold bg-stella-gold/10 text-white"
          : "border-l-transparent text-stella-muted hover:bg-white/[0.035] hover:text-white",
      )}
    >
      <span className="min-w-0">
        <span className="flex items-center gap-1.5">
          <span className="text-xs font-semibold leading-tight">
            {market.baseAsset}
          </span>
          <span className="text-[10px] text-stella-muted">PERP</span>
          {isRwa && (
            <span className="rounded border border-stella-gold/30 bg-stella-gold/10 px-1 py-px text-[8px] font-bold text-stella-gold">
              RWA
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-[10px] text-stella-muted">
          {market.maxLeverage}x max · {isRwa ? "NAV oracle" : market.quoteAsset}
        </span>
      </span>
      <span className="text-right">
        <span className="num block text-[11px] leading-tight text-white">
          {price !== undefined
            ? `$${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: isRwa ? 6 : 2 })}`
            : "—"}
        </span>
        <span
          className={clsx(
            "num block text-[10px] leading-tight font-medium",
            pct === undefined
              ? "text-stella-muted"
              : pct >= 0
                ? "text-stella-long"
                : "text-stella-short",
          )}
        >
          {pct !== undefined ? `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%` : "—"}
        </span>
      </span>
    </button>
  );
}

interface Props {
  markets: readonly Market[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}

export function MarketSelector({ markets, selectedId, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "crypto" | "rwa">("all");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return markets.filter((m) => {
      const isRwa = m.badge === "RWA";
      if (filter === "crypto" && isRwa) return false;
      if (filter === "rwa" && !isRwa) return false;
      if (q.length === 0) return true;
      return `${m.baseAsset}-${m.quoteAsset}`.toLowerCase().includes(q);
    });
  }, [filter, markets, query]);

  if (markets.length === 0) {
    return (
      <div className="terminal-card p-3 text-xs text-stella-muted">No markets available</div>
    );
  }

  return (
    <div className="terminal-card overflow-hidden rounded-none">
      <div className="border-b terminal-divider p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="terminal-panel-title">Markets</div>
          <span className="rounded bg-stella-gold/10 px-1.5 py-0.5 text-[9px] font-bold text-stella-gold">PERPS</span>
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search market"
          className="h-8 w-full rounded-md border border-white/10 bg-black/35 px-2.5 text-xs text-white placeholder:text-stella-muted focus:border-stella-gold/50 focus:outline-none"
        />
        <div className="mt-2 grid grid-cols-3 gap-1 rounded-md bg-black/25 p-1 text-[10px] font-medium">
          {(["all", "crypto", "rwa"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={clsx(
                "rounded px-2 py-1 uppercase tracking-wide transition-colors",
                filter === f
                  ? "bg-white/10 text-white"
                  : "text-stella-muted hover:text-white",
              )}
            >
              {f}
            </button>
          ))}
        </div>
      </div>
      <div className="max-h-[calc(100vh-12rem)] overflow-y-auto py-1">
        {visible.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-stella-muted">No matching markets</div>
        ) : (
          visible.map((m) => (
            <MarketChip
              key={m.marketId}
              market={m}
              selected={m.marketId === selectedId}
              onSelect={() => onSelect(m.marketId)}
            />
          ))
        )}
      </div>
    </div>
  );
}
