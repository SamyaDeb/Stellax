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

function MarketRow({ market, selected, onSelect }: ChipProps) {
  const isRwa    = market.badge === "RWA";
  const ticker   = useBinanceTicker(isRwa ? null : market.baseAsset);
  const rwaTicker = useRwaTicker(isRwa ? market.baseAsset : null);
  const oracle   = usePrice(isRwa ? market.baseAsset : null);

  const pct = isRwa ? rwaTicker.data?.priceChangePercent : ticker.data?.priceChangePercent;
  const price = isRwa && oracle.data?.price !== undefined
    ? fromFixed(oracle.data.price)
    : isRwa
      ? rwaTicker.data?.lastPrice
      : ticker.data?.lastPrice;

  const isUp = pct !== undefined && pct >= 0;

  return (
    <button
      onClick={onSelect}
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "7px 10px",
        textAlign: "left",
        background: selected ? "rgba(240,167,66,0.06)" : "transparent",
        borderTop: "none",
        borderRight: "none",
        borderBottom: "none",
        borderLeft: `2px solid ${selected ? "var(--gold)" : "transparent"}`,
        cursor: "pointer",
        transition: "background 0.1s",
        fontFamily: "'JetBrains Mono', monospace",
      }}
      onMouseEnter={(e) => {
        if (!selected)
          (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.03)";
      }}
      onMouseLeave={(e) => {
        if (!selected)
          (e.currentTarget as HTMLButtonElement).style.background = "transparent";
      }}
    >
      {/* Left: ticker + badge */}
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: selected ? "var(--t1)" : "var(--t2)",
            }}
          >
            {market.baseAsset}
          </span>
          <span style={{ fontSize: 9, color: "var(--t3)" }}>PERP</span>
          {isRwa && (
            <span
              style={{
                fontSize: 8,
                fontWeight: 700,
                padding: "1px 4px",
                border: "1px solid rgba(240,167,66,0.3)",
                background: "rgba(240,167,66,0.08)",
                color: "var(--gold)",
                borderRadius: 2,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              RWA
            </span>
          )}
        </div>
        <div style={{ fontSize: 9, color: "var(--t3)", marginTop: 1 }}>
          {market.maxLeverage}x · {isRwa ? "NAV oracle" : market.quoteAsset}
        </div>
      </div>

      {/* Right: price + change */}
      <div style={{ textAlign: "right" }}>
        <div
          className="num"
          style={{ fontSize: 11, color: "var(--t1)", lineHeight: 1.2 }}
        >
          {price !== undefined
            ? `$${price.toLocaleString("en-US", {
                minimumFractionDigits: 2,
                maximumFractionDigits: isRwa ? 6 : 2,
              })}`
            : "—"}
        </div>
        <div
          className="num"
          style={{
            fontSize: 10,
            fontWeight: 600,
            lineHeight: 1.2,
            color:
              pct === undefined
                ? "var(--t3)"
                : isUp
                  ? "var(--green)"
                  : "var(--red)",
          }}
        >
          {pct !== undefined ? `${isUp ? "+" : ""}${pct.toFixed(2)}%` : "—"}
        </div>
      </div>
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

  return (
    <div style={{ fontFamily: "'JetBrains Mono', monospace" }}>
      {/* Header */}
      <div
        style={{
          padding: "8px 10px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 6,
          }}
        >
          <span className="terminal-panel-title">Markets</span>
          <span
            style={{
              fontSize: 8,
              fontWeight: 700,
              padding: "2px 5px",
              background: "var(--gold-dim)",
              color: "var(--gold)",
              borderRadius: 2,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            PERPS
          </span>
        </div>

        {/* Search */}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search market"
          style={{
            width: "100%",
            padding: "5px 8px",
            fontSize: 11,
            fontFamily: "'JetBrains Mono', monospace",
            background: "var(--bg0)",
            border: "1px solid var(--border2)",
            borderRadius: 3,
            color: "var(--t1)",
            outline: "none",
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; }}
          onBlur={(e)  => { e.currentTarget.style.borderColor = "var(--border2)"; }}
        />

        {/* Filter tabs */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 2,
            marginTop: 5,
            background: "var(--bg0)",
            border: "1px solid var(--border)",
            borderRadius: 3,
            padding: 2,
          }}
        >
          {(["all", "crypto", "rwa"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                padding: "3px 0",
                fontSize: 9,
                fontWeight: 700,
                fontFamily: "'JetBrains Mono', monospace",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                borderRadius: 2,
                border: "none",
                cursor: "pointer",
                background: filter === f ? "var(--bg3)" : "transparent",
                color: filter === f ? "var(--t1)" : "var(--t3)",
                transition: "background 0.1s, color 0.1s",
              }}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Market list */}
      <div style={{ maxHeight: 280, overflowY: "auto" }}>
        {markets.length === 0 ? (
          <div style={{ padding: "16px 10px", fontSize: 11, color: "var(--t3)", textAlign: "center" }}>
            No markets available
          </div>
        ) : visible.length === 0 ? (
          <div style={{ padding: "16px 10px", fontSize: 11, color: "var(--t3)", textAlign: "center" }}>
            No matching markets
          </div>
        ) : (
          visible.map((m) => (
            <MarketRow
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
