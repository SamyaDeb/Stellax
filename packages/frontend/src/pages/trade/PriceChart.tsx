/**
 * PriceChart – TradingView-style candlestick (or area) chart.
 *
 * Data sources:
 *   • Historical OHLCV – Binance public REST API (no auth required)
 *   • Current price    – on-chain oracle via TanStack Query (5 s poll)
 *     → oracle price is used to update the last candle's close in real time
 *
 * Features:
 *   • Candlestick series with green/red candles
 *   • Volume histogram overlay (lower 15 % of chart)
 *   • Area mode toggle (shows smooth line instead of candles)
 *   • Timeframe selector: 1m 5m 15m 1H 4H 1D
 *   • ResizeObserver keeps the chart responsive
 *   • Graceful fallback when Binance is unreachable
 */

import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import {
  ColorType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { fromFixed } from "@/ui/format";
import { toBinanceSymbol, useBinanceOHLC, useRwaOHLC, type Interval } from "@/hooks/useBinanceOHLC";

// ── Chart palette ─────────────────────────────────────────────────────────────

const UP_COLOR    = "#05c48a";
const DOWN_COLOR  = "#f03e3e";
const CHART_BG    = "#08090d";
const TEXT_COLOR  = "#5a5f7a";
const GRID_COLOR  = "#0f1118";
const BORDER_COL  = "#1e2030";

// ── Timeframe options ─────────────────────────────────────────────────────────

const INTERVALS: { label: string; value: Interval }[] = [
  { label: "1m",  value: "1m"  },
  { label: "5m",  value: "5m"  },
  { label: "15m", value: "15m" },
  { label: "1H",  value: "1h"  },
  { label: "4H",  value: "4h"  },
  { label: "1D",  value: "1d"  },
];

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  /** Current oracle price (18-decimal bigint). Updated every 5 s. */
  price?: bigint | undefined;
  /** Oracle write timestamp (bigint seconds). */
  timestamp?: bigint | undefined;
  /** Display title, e.g. "BTC-USD". */
  title: string;
  /** Base asset symbol for Binance OHLC lookup, e.g. "BTC". */
  asset?: string | null | undefined;
}

// ── Price display helper ──────────────────────────────────────────────────────

function fmtPrice(v: number): string {
  if (v >= 10_000) return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (v >= 1_000)  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (v >= 1)      return v.toFixed(4);
  return v.toFixed(6);
}

// ── Component ─────────────────────────────────────────────────────────────────

export function PriceChart({ price, timestamp: _timestamp, title, asset }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef     = useRef<IChartApi | null>(null);
  const candleRef    = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef       = useRef<ISeriesApi<"Histogram"> | null>(null);
  const areaRef      = useRef<ISeriesApi<"Area"> | null>(null);

  const [timeframe, setTimeframe] = useState<Interval>("15m");
  const [mode, setMode]           = useState<"candles" | "area">("candles");

  const oracleOnly = asset !== null && asset !== undefined && toBinanceSymbol(asset) === null;
  const ohlcQuery = useBinanceOHLC(asset ?? null, timeframe);
  const rwaOhlcQuery = useRwaOHLC(asset ?? null, timeframe);
  const rwaIndexedData = oracleOnly && rwaOhlcQuery.data?.length ? rwaOhlcQuery.data : undefined;
  const chartData = oracleOnly ? rwaIndexedData : ohlcQuery.data;
  const displayPrice = price !== undefined ? fromFixed(price) : undefined;

  // ── Initialise chart (once on mount) ────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: CHART_BG },
        textColor:  TEXT_COLOR,
        fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
        fontSize:   11,
      },
      grid: {
        vertLines: { color: GRID_COLOR },
        horzLines: { color: GRID_COLOR },
      },
      crosshair: {
        vertLine: { color: "#35394f", style: 1, labelBackgroundColor: "#1a1d2b" },
        horzLine: { color: "#35394f", style: 1, labelBackgroundColor: "#1a1d2b" },
      },
      rightPriceScale: {
        borderColor:  BORDER_COL,
        minimumWidth: 72,
      },
      timeScale: {
        borderColor:     BORDER_COL,
        timeVisible:     true,
        secondsVisible:  false,
        barSpacing:      8,
        fixLeftEdge:     false,
        fixRightEdge:    false,
      },
      width:  el.clientWidth,
      height: 460,
    });

    // Candlestick series
    const candles = chart.addCandlestickSeries({
      upColor:         UP_COLOR,
      downColor:       DOWN_COLOR,
      borderUpColor:   UP_COLOR,
      borderDownColor: DOWN_COLOR,
      wickUpColor:     UP_COLOR,
      wickDownColor:   DOWN_COLOR,
      visible:         true,
    });

    // Volume histogram (occupies bottom ~15 % of the canvas)
    const vol = chart.addHistogramSeries({
      color:        "rgba(245,166,35,0.15)",
      priceFormat:  { type: "volume" },
      priceScaleId: "vol",
    });
    vol.priceScale().applyOptions({
      scaleMargins: { top: 0.85, bottom: 0 },
    });

    // Area series (shown when user switches to "Area" mode)
    const area = chart.addAreaSeries({
      lineColor:   "#f5a623",
      topColor:    "rgba(245,166,35,0.15)",
      bottomColor: "rgba(245,166,35,0)",
      lineWidth:   2,
      visible:     false,
    });

    chartRef.current  = chart;
    candleRef.current = candles;
    volRef.current    = vol;
    areaRef.current   = area;

    // Responsive width
    const ro = new ResizeObserver(() => {
      if (el && chartRef.current) {
        chartRef.current.applyOptions({ width: el.clientWidth });
      }
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current  = null;
      candleRef.current = null;
      volRef.current    = null;
      areaRef.current   = null;
    };
  }, []);

  // ── Switch between Candles / Area ──────────────────────────────────────────
  useEffect(() => {
    candleRef.current?.applyOptions({ visible: mode === "candles" });
    areaRef.current?.applyOptions({ visible: mode === "area" });
  }, [mode]);

  // ── Load / reload OHLCV from Binance or indexed oracle history ─────────────
  useEffect(() => {
    const data = chartData;
    if (!data || !candleRef.current || !volRef.current || !areaRef.current) return;

    candleRef.current.setData(
      data.map((c) => ({
        time:  c.time as UTCTimestamp,
        open:  c.open,
        high:  c.high,
        low:   c.low,
        close: c.close,
      })),
    );

    volRef.current.setData(
      data.map((c) => ({
        time:  c.time as UTCTimestamp,
        value: c.volume,
        color: c.close >= c.open
          ? "rgba(5,196,138,0.22)"
          : "rgba(240,62,62,0.18)",
      })),
    );

    areaRef.current.setData(
      data.map((c) => ({
        time:  c.time as UTCTimestamp,
        value: c.close,
      })),
    );

    chartRef.current?.timeScale().fitContent();
  }, [chartData]);

  // ── Overlay live oracle price on the last candle ───────────────────────────
  useEffect(() => {
    const data = chartData;
    if (!price || !data?.length) return;

    const oraclePrice = fromFixed(price);
    const last = data[data.length - 1];
    if (!last) return;

    candleRef.current?.update({
      time:  last.time as UTCTimestamp,
      open:  last.open,
      high:  Math.max(last.high, oraclePrice),
      low:   Math.min(last.low,  oraclePrice),
      close: oraclePrice,
    });

    areaRef.current?.update({
      time:  last.time as UTCTimestamp,
      value: oraclePrice,
    });
  }, [price, chartData]);

  // ── Clear chart when market changes ───────────────────────────────────────
  useEffect(() => {
    if (oracleOnly) return;
    candleRef.current?.setData([]);
    volRef.current?.setData([]);
    areaRef.current?.setData([]);
  }, [title, oracleOnly]);

  // ── Derived display values ─────────────────────────────────────────────────
  const oraclePrice = displayPrice ?? null;
  const openPrice   = chartData?.[0]?.close;
  const priceUp     = oraclePrice !== null && openPrice !== undefined && oraclePrice >= openPrice;

  const changeAmt   = oraclePrice !== null && openPrice !== undefined
    ? oraclePrice - openPrice : null;
  const changePct   = changeAmt !== null && openPrice !== undefined && openPrice > 0
    ? (changeAmt / openPrice) * 100 : null;

  return (
    <div className="select-none">
      {/* ── Chart header ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b terminal-divider px-3 py-2">
        {/* Left: title + price + change */}
        <div className="flex items-center gap-3">
            <span className="text-xs font-bold uppercase tracking-wide text-stella-muted">
              {title}
            </span>

          {oraclePrice !== null && (
            <span
              className={clsx(
                "num text-base font-bold tabular-nums",
                priceUp ? "text-stella-long" : "text-stella-short",
              )}
            >
              ${fmtPrice(oraclePrice)}
            </span>
          )}

          {changePct !== null && (
            <span
              className={clsx(
                "num text-xs font-semibold tabular-nums rounded px-1.5 py-0.5",
                priceUp
                  ? "text-stella-long bg-stella-long/10"
                  : "text-stella-short bg-stella-short/10",
              )}
            >
              {priceUp ? "+" : ""}
              {changePct.toFixed(2)}%
            </span>
          )}

          {/* Loading / error state */}
          {oracleOnly && rwaIndexedData && (
            <span className="text-[11px] text-stella-gold">
              RWA NAV chart · indexed oracle history
            </span>
          )}
          {oracleOnly && !rwaIndexedData && price !== undefined && (
            <span className="text-[11px] text-stella-gold">
              RWA NAV chart · live oracle price
            </span>
          )}
          {oracleOnly && !rwaIndexedData && price === undefined && (
            <span className="text-[11px] text-stella-muted">
              RWA NAV chart · waiting for oracle NAV…
            </span>
          )}
          {oracleOnly && !rwaIndexedData && rwaOhlcQuery.isLoading && (
            <span className="text-[11px] text-stella-muted animate-pulse">
              Loading indexed NAV history…
            </span>
          )}
          {oracleOnly && !rwaIndexedData && rwaOhlcQuery.isError && (
            <span className="text-[11px] text-stella-muted">
              ⚠ Indexed NAV history unavailable
            </span>
          )}
          {!oracleOnly && ohlcQuery.isLoading && !ohlcQuery.data && (
            <span className="text-[11px] text-stella-muted animate-pulse">
              Loading chart data…
            </span>
          )}
          {!oracleOnly && ohlcQuery.isError && (
            <span className="text-[11px] text-stella-muted">
              ⚠ Chart data unavailable — showing oracle price only
            </span>
          )}
        </div>

        {/* Right: mode toggle + timeframe buttons */}
        <div className="flex items-center gap-2">
          {/* Candles / Area toggle */}
          <div className="flex overflow-hidden rounded-md border border-white/10 bg-black/30 text-xs">
            {(["candles", "area"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={clsx(
                  "px-2 py-1 font-medium capitalize transition-colors",
                  mode === m
                    ? "bg-stella-gold/15 text-stella-gold"
                    : "text-stella-muted hover:text-white",
                )}
              >
                {m}
              </button>
            ))}
          </div>

          {/* Timeframe buttons */}
          <div className="flex items-center gap-0.5">
            {INTERVALS.map((iv) => (
              <button
                key={iv.value}
                onClick={() => setTimeframe(iv.value)}
                className={clsx(
                  "rounded px-2 py-1 text-xs font-medium transition-colors",
                  timeframe === iv.value
                    ? "bg-stella-gold/15 text-stella-gold"
                    : "text-stella-muted hover:text-white",
                )}
              >
                {iv.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Chart canvas ─────────────────────────────────────────────────── */}
      <div ref={containerRef} className="h-[460px] w-full" />
    </div>
  );
}
