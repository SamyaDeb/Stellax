import { useEffect, useMemo, useRef, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { formatUsd, fromFixed } from "@/ui/format";
import {
  useMarkPrice,
  useMarkets,
  useOpenInterest,
  usePrice,
  useFundingRate,
  useFundingVelocity,
  qk,
} from "@/hooks/queries";
import { useBinanceTicker } from "@/hooks/useBinanceOHLC";
import { getClients } from "@/stellar/clients";
import { useWallet } from "@/wallet";
import { usePositions } from "@/hooks/usePositions";
import { useClosedTradesOnChain } from "@/hooks/useClosedTradesOnChain";
import { useMarketStore } from "@/stores/marketStore";
import { useRwaPrice } from "@/hooks/useRwaPrice";
import { MarketSelector } from "./trade/MarketSelector";
import { PriceChart } from "./trade/PriceChart";
import { OrderForm } from "./trade/OrderForm";
import { OrderBook } from "./trade/OrderBook";
import { RecentTrades } from "./trade/RecentTrades";
import { OpenOrdersTable } from "./trade/OpenOrdersTable";
import { PositionsTable } from "./trade/PositionsTable";
import { ClosedTradesTable } from "./trade/ClosedTradesTable";
import { AccountSummary } from "./trade/AccountSummary";
import { SpotSwapPanel } from "./trade/SpotSwapPanel";
import { CloseResultToast } from "@/ui/CloseResultToast";
import { PauseBanner } from "@/ui/PauseBanner";
import { TestnetFaucetBar } from "@/ui/TestnetFaucetBar";
import { config, hasContract } from "@/config";

const PRICE_POLL_MS = 5_000;

export function TradePage() {
  const { address } = useWallet();
  const markets = useMarkets();
  const storedMarketId = useMarketStore((s) => s.selectedMarketId);
  const setStoredMarketId = useMarketStore((s) => s.setSelectedMarketId);
  const [selectedId, setSelectedId] = useState<number | null>(storedMarketId);
  const [tab, setTab] = useState<"perp" | "spot">("perp");
  const [blotterTab, setBlotterTab] = useState<"positions" | "orders" | "history">("positions");
  const [showMarketDropdown, setShowMarketDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const closedTrades = useClosedTradesOnChain(address);

  function selectMarket(id: number | null) {
    setSelectedId(id);
    setStoredMarketId(id);
  }

  // Auto-select first market
  useEffect(() => {
    if (selectedId === null && markets.data !== undefined && markets.data.length > 0) {
      const first = markets.data[0];
      if (first !== undefined) selectMarket(first.marketId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markets.data, selectedId]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!showMarketDropdown) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowMarketDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showMarketDropdown]);

  const selected = useMemo(
    () => markets.data?.find((m) => m.marketId === selectedId) ?? null,
    [markets.data, selectedId],
  );

  const price      = usePrice(selected?.baseAsset ?? null);
  const mark       = useMarkPrice(selected?.marketId ?? null);
  const oi         = useOpenInterest(selected?.marketId ?? null);
  const funding    = useFundingRate(selected?.marketId ?? null);
  const fundingVel = useFundingVelocity(selected?.marketId ?? null);
  const ticker     = useBinanceTicker(selected?.baseAsset ?? null);
  const rwaPrice   = useRwaPrice(selected?.badge === "RWA" ? (selected.baseAsset ?? null) : null);

  const { positions, source: positionSource, indexerOffline } = usePositions(address);

  const positionMarketIds = useMemo(
    () => Array.from(new Set(positions.map((p) => p.marketId))),
    [positions],
  );
  const allMarks = useQueries({
    queries: positionMarketIds.map((id) => ({
      queryKey: qk.markPrice(id),
      queryFn: () => getClients().perpEngine.getMarkPrice(id),
      enabled: hasContract(config.contracts.perpEngine),
      refetchInterval: PRICE_POLL_MS,
    })),
  });
  const marksMap = useMemo(() => {
    const m: Record<number, bigint | undefined> = {};
    positionMarketIds.forEach((id, i) => { m[id] = allMarks[i]?.data as bigint | undefined; });
    return m;
  }, [positionMarketIds, allMarks]);

  const allOnChainPnl = useQueries({
    queries: positions.map((p) => ({
      queryKey: qk.unrealizedPnl(p.positionId),
      queryFn: () => getClients().perpEngine.getUnrealizedPnl(p.positionId),
      enabled: hasContract(config.contracts.perpEngine),
      refetchInterval: PRICE_POLL_MS,
    })),
  });
  const onChainPnlMap = useMemo(() => {
    const m: Record<string, bigint | undefined> = {};
    positions.forEach((p, i) => {
      const v = allOnChainPnl[i]?.data;
      m[p.positionId.toString()] = typeof v === "bigint" ? v : undefined;
    });
    return m;
  }, [positions, allOnChainPnl]);

  if (!hasContract(config.contracts.perpEngine) || !hasContract(config.contracts.oracle)) {
    return (
      <div className="p-6" style={{ color: "var(--t2)", fontSize: 12 }}>
        Contracts not yet deployed. Populate{" "}
        <code style={{ color: "var(--gold)" }}>VITE_*_CONTRACT_ID</code> in{" "}
        <code style={{ color: "var(--gold)" }}>.env</code> after Phase 14 deployment.
      </div>
    );
  }

  // Crypto: Binance real-time lastPrice. RWA: Pyth → oracle → indexer ticker.
  const livePrice = ticker.data !== undefined
    ? `$${ticker.data.lastPrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: ticker.data.lastPrice < 1 ? 6 : 2 })}`
    : rwaPrice.price !== undefined
      ? `$${rwaPrice.price.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: rwaPrice.price < 10 ? 6 : 4 })}`
      : mark.data !== undefined && mark.data > 0n
        ? formatUsd(mark.data)
        : "—";

  const changePct = ticker.data?.priceChangePercent;
  const isUp      = changePct !== undefined && changePct >= 0;

  return (
    <div
      className="terminal-shell"
      style={{ minHeight: "calc(100vh - 44px)", fontFamily: "'JetBrains Mono', monospace" }}
    >
      <TestnetFaucetBar />

      {/* ── Mode switcher ────────────────────────────────────────── */}
      <div
        className="flex items-center gap-3 px-4"
        style={{
          height: 40,
          background: "var(--bg1)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div
          className="flex"
          style={{
            background: "var(--bg2)",
            border: "1px solid var(--border2)",
            borderRadius: 3,
            padding: 2,
            gap: 1,
          }}
        >
          {(["perp", "spot"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                padding: "3px 12px",
                fontSize: 11,
                fontWeight: 600,
                borderRadius: 2,
                border: "none",
                cursor: "pointer",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                background: tab === t ? "var(--bg3)" : "transparent",
                color: tab === t ? "var(--t1)" : "var(--t3)",
                transition: "background 0.1s, color 0.1s",
              }}
            >
              {t === "perp" ? "Perps" : "Spot"}
            </button>
          ))}
        </div>

        {selected !== null && tab === "perp" && (
          <div style={{ fontSize: 10, color: "var(--t3)", display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                width: 6, height: 6, borderRadius: "50%",
                background: selected.isActive ? "var(--green)" : "var(--red)",
                display: "inline-block",
              }}
            />
            {selected.isActive ? "Live" : "Paused"}
            <span style={{ opacity: 0.3 }}>·</span>
            {selected.maxLeverage}x max
          </div>
        )}
      </div>

      {tab === "spot" && <SpotSwapPanel />}

      {tab === "perp" && (
        <>
          <CloseResultToast />
          <PauseBanner />

          {/* ── Market header strip ──────────────────────────────── */}
          <div
            className="trade-market-header"
            style={{
              background: "var(--bg1)",
              borderBottom: "1px solid var(--border)",
              padding: "0 16px",
              display: "flex",
              alignItems: "stretch",
              flexWrap: "nowrap",
              gap: 0,
              minHeight: 54,
            }}
          >
            {/* ── Token / market dropdown trigger ─── */}
            <div
              ref={dropdownRef}
              style={{ position: "relative", flexShrink: 0, display: "flex", alignItems: "center" }}
            >
              <button
                onClick={() => setShowMarketDropdown((v) => !v)}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center",
                  gap: 3,
                  padding: "0 16px 0 0",
                  height: "100%",
                  background: "transparent",
                  border: "none",
                  borderRight: "1px solid var(--border)",
                  cursor: "pointer",
                  fontFamily: "'JetBrains Mono', monospace",
                  transition: "background 0.1s",
                  textAlign: "left",
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "var(--bg3)"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
              >
                {/* Row 1: asset name + badges + chevron */}
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "var(--t1)", letterSpacing: "0.02em" }}>
                    {selected !== null ? `${selected.baseAsset}-USD` : "Select Market"}
                  </span>

                  <span
                    style={{
                      fontSize: 9, fontWeight: 700, padding: "1px 4px",
                      background: "rgba(255,255,255,0.07)", color: "var(--t3)",
                      borderRadius: 2, textTransform: "uppercase", letterSpacing: "0.1em",
                    }}
                  >
                    PERP
                  </span>

                  {selected?.badge === "RWA" && (
                    <span
                      style={{
                        fontSize: 9, fontWeight: 700, padding: "1px 4px",
                        border: "1px solid rgba(240,167,66,0.35)",
                        background: "rgba(240,167,66,0.1)",
                        color: "var(--gold)", borderRadius: 2,
                        textTransform: "uppercase", letterSpacing: "0.1em",
                      }}
                    >
                      RWA
                    </span>
                  )}

                  <svg
                    width="9" height="5" viewBox="0 0 10 6" fill="none"
                    style={{
                      color: "var(--t3)",
                      transform: showMarketDropdown ? "rotate(180deg)" : "rotate(0deg)",
                      transition: "transform 0.15s",
                      flexShrink: 0,
                    }}
                  >
                    <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>

                {/* Row 2: live price + change % + RWA source badge */}
                <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                  <span
                    className="num"
                    style={{
                      fontSize: 16, fontWeight: 700, lineHeight: 1,
                      color: isUp ? "var(--green)" : changePct !== undefined ? "var(--red)" : "var(--t1)",
                    }}
                  >
                    {livePrice}
                  </span>
                  {changePct !== undefined && (
                    <span
                      className="num"
                      style={{
                        fontSize: 10, fontWeight: 600,
                        color: isUp ? "var(--green)" : "var(--red)",
                      }}
                    >
                      {isUp ? "+" : ""}{changePct.toFixed(2)}%
                    </span>
                  )}
                  {/* RWA price source badge */}
                  {selected?.badge === "RWA" && rwaPrice.source !== undefined && (
                    <span
                      style={{
                        fontSize: 8, fontWeight: 700, padding: "1px 4px",
                        background: (rwaPrice.source === "pyth" || rwaPrice.source === "lazer") ? "rgba(100,160,255,0.12)" : "rgba(240,167,66,0.1)",
                        color: (rwaPrice.source === "pyth" || rwaPrice.source === "lazer") ? "var(--accent)" : "var(--gold)",
                        border: `1px solid ${(rwaPrice.source === "pyth" || rwaPrice.source === "lazer") ? "rgba(79,142,255,0.25)" : "rgba(240,167,66,0.25)"}`,
                        borderRadius: 2, textTransform: "uppercase", letterSpacing: "0.08em",
                        alignSelf: "center",
                      }}
                    >
                      {rwaPrice.source === "pyth" ? "PYTH" : rwaPrice.source === "lazer" ? "LAZER" : "NAV"}
                    </span>
                  )}
                </div>
              </button>

              {/* ── Dropdown panel ─── */}
              {showMarketDropdown && (
                <div
                  style={{
                    position: "absolute",
                    top: "100%",
                    left: 0,
                    zIndex: 200,
                    width: 300,
                    maxHeight: 440,
                    background: "var(--bg1)",
                    border: "1px solid var(--border2)",
                    borderTop: "2px solid var(--accent)",
                    boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
                    overflowY: "auto",
                  }}
                >
                  <MarketSelector
                    markets={markets.data ?? []}
                    selectedId={selectedId}
                    onSelect={(id) => {
                      selectMarket(id);
                      setShowMarketDropdown(false);
                    }}
                  />
                </div>
              )}
            </div>

            {/* Stats row */}
            <div
              className="trade-stats-row"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 20,
                flex: 1,
                overflowX: "auto",
                minWidth: 0,
                padding: "0 16px",
              }}
            >
              <Stat
                label="24h Change"
                value={changePct !== undefined ? `${isUp ? "+" : ""}${changePct.toFixed(2)}%` : "—"}
                positive={isUp}
                negative={changePct !== undefined && !isUp}
              />
              <Stat
                label="24h Volume"
                value={
                  ticker.data !== undefined
                    ? `$${(ticker.data.volume * ticker.data.lastPrice / 1_000_000).toFixed(2)}M`
                    : "—"
                }
              />
              <Stat
                label="Open Interest"
                value={
                  oi.data !== undefined
                    ? `L ${formatUsd(oi.data.long)} / S ${formatUsd(oi.data.short)}`
                    : "—"
                }
              />
              <Stat
                label="Funding 1h"
                value={
                  funding.data !== undefined
                    ? `${funding.data >= 0n ? "+" : ""}${(fromFixed(funding.data) * 100).toFixed(4)}%${
                        fundingVel.data !== undefined
                          ? fundingVel.data > 0n ? " ↑" : fundingVel.data < 0n ? " ↓" : " →"
                          : ""
                      }`
                    : "—"
                }
                positive={funding.data !== undefined && funding.data >= 0n}
                negative={funding.data !== undefined && funding.data < 0n}
              />
              <Stat
                label="Oracle"
                value={price.data !== undefined ? formatUsd(price.data.price) : "—"}
                muted
              />
              <Stat
                label="Fees"
                value={selected !== null ? `${(selected.takerFeeBps / 100).toFixed(2)}%` : "—"}
                muted
              />
            </div>
          </div>

          {/* ── 3-column trade grid ──────────────────────────────── */}
          <div
            className="trade-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "280px 1fr 280px",
              gap: 1,
              background: "var(--border)",
              minHeight: "calc(100vh - 182px)",
            }}
          >
            {/* LEFT: Order Book + Recent Trades */}
            <aside
              className="trade-orderbook-col"
              style={{
                background: "var(--bg1)",
                display: "flex",
                flexDirection: "column",
                overflow: "hidden auto",
              }}
            >
              {config.contracts.clob.length > 0 && (
                <OrderBook
                  marketId={selected?.marketId ?? null}
                  markPrice={mark.data}
                  address={address}
                />
              )}
              <div style={{ borderTop: "1px solid var(--border)" }}>
                <RecentTrades markPrice={mark.data} />
              </div>
            </aside>

            {/* CENTER: Chart (fixed ~2/3 height) + Blotter */}
            <section
              style={{
                background: "var(--bg0)",
                display: "flex",
                flexDirection: "column",
                minWidth: 0,
              }}
            >
              {/* Chart — grows to fill available space above blotter */}
              <div style={{ flex: 1, minHeight: 280, minWidth: 0 }}>
                <PriceChart
                  price={
                    selected?.badge === "RWA" && rwaPrice.price18 !== undefined
                      ? rwaPrice.price18
                      : price.data?.price
                  }
                  timestamp={price.data?.writeTimestamp}
                  title={
                    selected !== null
                      ? `${selected.baseAsset}-${selected.quoteAsset}`
                      : "No market"
                  }
                  asset={selected?.baseAsset}
                />
              </div>

              {/* Blotter */}
              <div
                style={{
                  borderTop: "1px solid var(--border)",
                  background: "var(--bg1)",
                  flexShrink: 0,
                  height: 230,
                  overflowY: "auto",
                }}
              >
                {/* Blotter tabs */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    borderBottom: "1px solid var(--border)",
                    background: "var(--bg0)",
                    padding: "0 4px",
                  }}
                >
                  {(["positions", "orders", "history"] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setBlotterTab(t)}
                      className={`trade-tab${blotterTab === t ? " active" : ""}`}
                    >
                      {t === "positions"
                        ? `Positions${positions.length > 0 ? ` (${positions.length})` : ""}`
                        : t === "history"
                          ? `History${closedTrades.length > 0 ? ` (${closedTrades.length})` : ""}`
                          : "Open Orders"}
                    </button>
                  ))}
                </div>

                {/* Indexer offline banner */}
                {indexerOffline && address !== null && (
                  <div
                    style={{
                      display: "flex", alignItems: "center", gap: 8,
                      borderBottom: "1px solid rgba(234,179,8,0.2)",
                      background: "rgba(234,179,8,0.05)",
                      padding: "6px 12px", fontSize: 10, color: "#eab308",
                    }}
                  >
                    <span
                      style={{
                        width: 6, height: 6, borderRadius: "50%",
                        background: "rgba(234,179,8,0.8)", display: "inline-block",
                      }}
                    />
                    {positionSource === "chain"
                      ? "Indexer offline — showing on-chain positions (may lag)."
                      : "Indexer offline — showing session-only positions. Data resets on tab close."}
                  </div>
                )}

                {blotterTab === "positions" ? (
                  <PositionsTable
                    positions={positions}
                    markets={markets.data ?? []}
                    marks={marksMap}
                    onChainPnl={onChainPnlMap}
                    address={address}
                  />
                ) : blotterTab === "history" ? (
                  <ClosedTradesTable trades={closedTrades} markets={markets.data ?? []} />
                ) : (
                  <OpenOrdersTable address={address} markets={markets.data ?? []} />
                )}
              </div>
            </section>

            {/* RIGHT: Order Form + Account */}
            <aside
              className="trade-account-col"
              style={{
                background: "var(--bg1)",
                display: "flex",
                flexDirection: "column",
                overflow: "hidden auto",
              }}
            >
              {selected !== null && (
                <OrderForm market={selected} markPrice={mark.data} />
              )}
              <div style={{ borderTop: "1px solid var(--border)" }}>
                <AccountSummary address={address} />
              </div>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}

/* ── Stat cell ───────────────────────────────────────────────────── */
function Stat({
  label, value, positive, negative, muted,
}: {
  label: string;
  value: string;
  positive?: boolean;
  negative?: boolean;
  muted?: boolean;
}) {
  const color = positive
    ? "var(--green)"
    : negative
      ? "var(--red)"
      : muted
        ? "var(--t3)"
        : "var(--t1)";
  return (
    <div className="market-stat">
      <div className="market-stat-label">{label}</div>
      <div className="market-stat-value num" style={{ color }}>
        {value}
      </div>
    </div>
  );
}
