import { useEffect, useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { Card } from "@/ui/Card";
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
import { MarketSelector } from "./trade/MarketSelector";
import { PriceChart } from "./trade/PriceChart";
import { OrderForm } from "./trade/OrderForm";
import { OrderBook } from "./trade/OrderBook";
import { OpenOrdersTable } from "./trade/OpenOrdersTable";
import { PositionsTable } from "./trade/PositionsTable";
import { ClosedTradesTable } from "./trade/ClosedTradesTable";
import { AccountSummary } from "./trade/AccountSummary";
import { MarginAccountWidget } from "./trade/MarginAccountWidget";
import { SpotSwapPanel } from "./trade/SpotSwapPanel";
import { CloseResultToast } from "@/ui/CloseResultToast";
import { PauseBanner } from "@/ui/PauseBanner";
import { TestnetFaucetBar } from "@/ui/TestnetFaucetBar";
import { config, hasContract } from "@/config";

// Poll interval shared with the price hooks (5 s).
const PRICE_POLL_MS = 5_000;

export function TradePage() {
  const { address } = useWallet();
  const markets = useMarkets();
  const storedMarketId = useMarketStore((s) => s.selectedMarketId);
  const setStoredMarketId = useMarketStore((s) => s.setSelectedMarketId);
  const [selectedId, setSelectedId] = useState<number | null>(storedMarketId);
  const [tab, setTab] = useState<"perp" | "spot">("perp");
  const [blotterTab, setBlotterTab] = useState<"positions" | "orders" | "history">("positions");

  const closedTrades = useClosedTradesOnChain(address);

  /** Update both local state and the persisted store together. */
  function selectMarket(id: number | null) {
    setSelectedId(id);
    setStoredMarketId(id);
  }

  // Auto-select first market when list loads — only if nothing is stored yet.
  useEffect(() => {
    if (selectedId === null && markets.data !== undefined && markets.data.length > 0) {
      const first = markets.data[0];
      if (first !== undefined) selectMarket(first.marketId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markets.data, selectedId]);

  const selected = useMemo(
    () => markets.data?.find((m) => m.marketId === selectedId) ?? null,
    [markets.data, selectedId],
  );

  const price = usePrice(selected?.baseAsset ?? null);
  const mark = useMarkPrice(selected?.marketId ?? null);
  const oi = useOpenInterest(selected?.marketId ?? null);
  const funding = useFundingRate(selected?.marketId ?? null);
  const fundingVel = useFundingVelocity(selected?.marketId ?? null);
  const ticker = useBinanceTicker(selected?.baseAsset ?? null);

  // Positions are sourced from the indexer when available, falling back to
  // the in-browser session store. See usePositions for details.
  const { positions, source: positionSource, indexerOffline } = usePositions(address);

  // Fetch mark price for every position market so the table can render PnL.
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
    positionMarketIds.forEach((id, i) => {
      m[id] = allMarks[i]?.data as bigint | undefined;
    });
    return m;
  }, [positionMarketIds, allMarks]);

  // Fetch on-chain unrealized PnL for every open position (includes funding).
  // Keyed by positionId string → bigint.
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
      <Card>
        <p className="text-sm text-stella-muted">
          Contracts not yet deployed. Populate <code>VITE_*_CONTRACT_ID</code> in
          <code> .env</code> after Phase 14 deployment.
        </p>
      </Card>
    );
  }

  return (
    <div className="terminal-shell min-h-[calc(100vh-5.5rem)] space-y-2 text-[13px]">
      <TestnetFaucetBar />
      <div className="flex items-center justify-between gap-3 border border-white/10 bg-[#080a0f] px-3 py-2 shadow-[0_0_0_1px_rgba(245,166,35,0.04)]">
        <div>
          <h1 className="text-sm font-semibold tracking-tight text-white">StellaX Perps Terminal</h1>
          <p className="text-[11px] text-stella-muted">Hyperliquid-style cross-margin execution for crypto and RWA perpetuals.</p>
        </div>
        <div className="flex gap-1 rounded-lg border border-white/10 bg-black/35 p-1">
        {(["perp", "spot"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={
              tab === t
                ? "rounded-md bg-white/10 px-3 py-1.5 text-xs font-semibold text-white"
                : "rounded-md px-3 py-1.5 text-xs font-medium text-stella-muted hover:text-white"
            }
          >
            {t === "perp" ? "Perpetuals" : "Spot Swap"}
          </button>
        ))}
        </div>
      </div>

      {tab === "spot" && <SpotSwapPanel />}

      {tab === "perp" && (
        <>
        <CloseResultToast />
        <PauseBanner />
        <div className="grid grid-cols-1 gap-2 xl:grid-cols-[260px_minmax(520px,1fr)_330px_360px]">
          <aside className="xl:row-span-3">
            <MarketSelector
              markets={markets.data ?? []}
              selectedId={selectedId}
              onSelect={selectMarket}
            />
          </aside>

          <section className="terminal-card rounded-none xl:col-span-3">
            <div className="flex flex-col gap-3 px-3 py-2 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex items-center gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-xl font-semibold text-white">
                      {selected !== null ? `${selected.baseAsset}-USD` : "Select Market"}
                    </h2>
                    <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold text-stella-muted">PERP</span>
                    {selected?.badge === "RWA" && (
                      <span className="rounded border border-stella-gold/30 bg-stella-gold/10 px-1.5 py-0.5 text-[10px] font-bold text-stella-gold">RWA NAV</span>
                    )}
                  </div>
                  <div className="text-xs text-stella-muted">
                    {selected !== null ? `${selected.maxLeverage}x max leverage · ${selected.isActive ? "Active" : "Paused"}` : "Choose a perp market"}
                  </div>
                </div>
                <div className="hidden h-9 w-px bg-white/10 sm:block" />
                <div className="num text-3xl font-semibold text-white">
                  {mark.data !== undefined ? formatUsd(mark.data) : price.data !== undefined ? formatUsd(price.data.price) : "—"}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-x-5 gap-y-2 sm:grid-cols-4 lg:grid-cols-7">
                <Stat label="Oracle" value={price.data !== undefined ? formatUsd(price.data.price) : "—"} />
                <Stat label="24h" value={ticker.data !== undefined ? `${ticker.data.priceChangePercent >= 0 ? "+" : ""}${ticker.data.priceChangePercent.toFixed(2)}%` : "—"} positive={ticker.data !== undefined && ticker.data.priceChangePercent >= 0} negative={ticker.data !== undefined && ticker.data.priceChangePercent < 0} />
                <Stat label="Funding" value={funding.data !== undefined ? `${funding.data >= 0n ? "+" : ""}${(fromFixed(funding.data) * 100).toFixed(4)}%${fundingVel.data !== undefined ? fundingVel.data > 0n ? " ↑" : fundingVel.data < 0n ? " ↓" : " →" : ""}` : "—"} positive={funding.data !== undefined && funding.data >= 0n} negative={funding.data !== undefined && funding.data < 0n} />
                <Stat label="OI Long" value={oi.data !== undefined ? formatUsd(oi.data.long) : "—"} muted />
                <Stat label="OI Short" value={oi.data !== undefined ? formatUsd(oi.data.short) : "—"} muted />
                <Stat label="Volume" value={ticker.data !== undefined ? `$${(ticker.data.volume * ticker.data.lastPrice / 1_000_000).toFixed(2)}M` : "—"} />
                <Stat label="Fees" value={selected !== null ? `${(selected.takerFeeBps / 100).toFixed(2)}%` : "—"} />
              </div>
            </div>
          </section>

          <section className="min-w-0">
            <Card padded={false} className="terminal-card rounded-none overflow-hidden">
              <PriceChart
                price={price.data?.price}
                timestamp={price.data?.writeTimestamp}
                title={
                  selected !== null
                    ? `${selected.baseAsset}-${selected.quoteAsset}`
                    : "No market"
                }
                asset={selected?.baseAsset}
              />
            </Card>
          </section>

          <section className="min-w-0">
            {config.contracts.clob.length > 0 && (
              <OrderBook
                marketId={selected?.marketId ?? null}
                markPrice={mark.data}
                address={address}
              />
            )}
          </section>

          <aside className="space-y-3">
            {selected !== null && (
              <OrderForm market={selected} markPrice={mark.data} />
            )}
            <AccountSummary address={address} />
            <MarginAccountWidget address={address} />
          </aside>

          <section className="terminal-card rounded-none overflow-hidden xl:col-span-3">
            <div className="flex items-center gap-1 border-b terminal-divider bg-black/20 px-3 py-2">
              {(["positions", "orders", "history"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setBlotterTab(t)}
                  className={
                    blotterTab === t
                      ? "rounded-md bg-white/10 px-3 py-1.5 text-xs font-semibold capitalize text-white"
                      : "rounded-md px-3 py-1.5 text-xs font-medium capitalize text-stella-muted hover:text-white"
                  }
                >
                  {t === "positions"
                    ? `Positions (${positions.length})`
                    : t === "history"
                      ? `History${closedTrades.length > 0 ? ` (${closedTrades.length})` : ""}`
                      : "Open Orders"}
                </button>
              ))}
            </div>
            {/* Indexer offline banner — only shown when indexer is confirmed unreachable */}
            {indexerOffline && address !== null && (
              <div className="flex items-center gap-2 border-b border-yellow-500/20 bg-yellow-500/5 px-3 py-1.5 text-[11px] text-yellow-400">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-yellow-400/80" />
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
              <ClosedTradesTable
                trades={closedTrades}
                markets={markets.data ?? []}
              />
            ) : (
              <OpenOrdersTable address={address} markets={markets.data ?? []} />
            )}
          </section>
        </div>
        </>
      )}
      </div>
  );
}

function Stat({
  label,
  value,
  accent,
  positive,
  negative,
  muted,
}: {
  label: string;
  value: string;
  accent?: boolean;
  positive?: boolean;
  negative?: boolean;
  /** Dim the value — used for stub/simulated data that doesn't yet update. */
  muted?: boolean;
}) {
  const colorClass = accent
    ? "text-stella-gold font-semibold"
    : positive
      ? "text-stella-long"
      : negative
        ? "text-stella-short"
        : muted
          ? "text-stella-muted"
          : "text-white";
  return (
    <div className="min-w-[72px]">
      <div className="text-[10px] uppercase tracking-wide text-stella-muted">
        {label}
      </div>
      <div className={`num text-xs ${colorClass}`}>{value}</div>
    </div>
  );
}
