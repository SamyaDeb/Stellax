/**
 * PriceChart – candlestick chart powered by lightweight-charts.
 *
 * Data sources:
 *   • Historical OHLCV — Binance public REST (no auth required)
 *   • Live candles     — Binance WebSocket kline stream (sub-second updates)
 *   • RWA markets      — indexed oracle history via useRwaOHLC; when unavailable,
 *                        a rolling oracle-price buffer builds pseudo-candles from
 *                        the 5-second on-chain poll.
 *   • Live price       — on-chain oracle (5s poll), overlaid on last candle
 *
 * Features: candlestick + area toggle, timeframe selector, volume bars,
 * OHLC crosshair tooltip, loading overlay, ResizeObserver for responsive width.
 */

import { useEffect, useRef, useState } from "react";
import {
  ColorType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { fromFixed } from "@/ui/format";
import {
  toBinanceSymbol,
  useBinanceOHLC,
  useBinanceKlineStream,
  useRwaOHLC,
  useCoinGeckoOHLC,
  usePythBenchmarkOHLC,
  type Candle,
  type Interval,
} from "@/hooks/useBinanceOHLC";

// ── Chart palette ─────────────────────────────────────────────────────────

const UP_COLOR   = "#00d47e";
const DOWN_COLOR = "#f0404a";
const CHART_BG   = "#0b0e14";
const TEXT_COLOR = "#4e5a6e";
const GRID_COLOR = "rgba(255,255,255,0.03)";
const BORDER_COL = "#1d2335";

function klineIntervalSecs(interval: Interval): number {
  switch (interval) {
    case "1m":  return 60;
    case "5m":  return 300;
    case "15m": return 900;
    case "1h":  return 3_600;
    case "4h":  return 14_400;
    case "1d":  return 86_400;
  }
}

// Detect actual candle interval from loaded data (handles CoinGecko 30min/4h/1d)
function detectCandleSecs(candles: Candle[]): number {
  if (candles.length < 2) return 300;
  const diff = candles[candles.length - 1]!.time - candles[candles.length - 2]!.time;
  return diff > 0 ? diff : 300; // guard: dedup should prevent 0, but be safe
}

// ── Intervals ─────────────────────────────────────────────────────────────

const INTERVALS: { label: string; value: Interval }[] = [
  { label: "1m",  value: "1m"  },
  { label: "5m",  value: "5m"  },
  { label: "15m", value: "15m" },
  { label: "1H",  value: "1h"  },
  { label: "4H",  value: "4h"  },
  { label: "1D",  value: "1d"  },
];

// ── Props ─────────────────────────────────────────────────────────────────

interface Props {
  price?: bigint | undefined;
  timestamp?: bigint | undefined;
  title: string;
  asset?: string | null | undefined;
}

interface HoveredOhlc {
  open: number;
  high: number;
  low: number;
  close: number;
}

function fmtPrice(v: number): string {
  if (v >= 1_000) return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (v >= 1)     return v.toFixed(4);
  return v.toFixed(6);
}

// ── Component ─────────────────────────────────────────────────────────────

export function PriceChart({ price, timestamp: _timestamp, title, asset }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef     = useRef<IChartApi | null>(null);
  const candleRef    = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef       = useRef<ISeriesApi<"Histogram"> | null>(null);
  const areaRef      = useRef<ISeriesApi<"Area"> | null>(null);

  // Rolling oracle-price buffer for RWA markets with no indexed history
  const oracleBufferRef = useRef<Candle[]>([]);

  const [timeframe, setTimeframe] = useState<Interval>("15m");
  const [mode, setMode]           = useState<"candles" | "area">("candles");
  const [hoveredOhlc, setHoveredOhlc] = useState<HoveredOhlc | null>(null);
  // Tracks the last candle close from the Binance WS stream (crypto markets only)
  const [wsLiveClose, setWsLiveClose] = useState<number | null>(null);

  const oracleOnly       = asset !== null && asset !== undefined && toBinanceSymbol(asset) === null;
  const ohlcQuery        = useBinanceOHLC(asset ?? null, timeframe);
  const rwaOhlcQuery     = useRwaOHLC(asset ?? null, timeframe);
  const benchmarkQuery   = usePythBenchmarkOHLC(oracleOnly ? (asset ?? null) : null, timeframe);
  const cgOhlcQuery      = useCoinGeckoOHLC(oracleOnly ? (asset ?? null) : null, timeframe);

  // Priority: Pyth Benchmarks (true 1m/5m/15m) > CoinGecko (30min/4h/1d) > indexer > oracle buffer
  const hasBenchmarkData = (benchmarkQuery.data?.length ?? 0) > 0;
  const hasCgData        = (cgOhlcQuery.data?.length ?? 0) > 0;
  const hasIndexerData   = (rwaOhlcQuery.data?.length ?? 0) > 0;
  const rwaIndexedData   = oracleOnly
    ? hasBenchmarkData ? benchmarkQuery.data
    : hasCgData        ? cgOhlcQuery.data
    : hasIndexerData   ? rwaOhlcQuery.data
    : undefined
    : undefined;
  const rwaSource: "pyth-benchmark" | "coingecko" | "indexer" | undefined =
    oracleOnly
      ? hasBenchmarkData ? "pyth-benchmark"
      : hasCgData        ? "coingecko"
      : hasIndexerData   ? "indexer"
      : undefined
    : undefined;
  const chartData    = oracleOnly ? rwaIndexedData : ohlcQuery.data;
  const displayPrice = price !== undefined ? fromFixed(price) : undefined;

  const anyRwaLoading = benchmarkQuery.isLoading || cgOhlcQuery.isLoading || rwaOhlcQuery.isLoading;
  const isLoading =
    (!oracleOnly && ohlcQuery.isLoading && !ohlcQuery.data) ||
    (oracleOnly && anyRwaLoading && !rwaIndexedData);

  // ── Init chart (once) ──────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: CHART_BG },
        textColor:  TEXT_COLOR,
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        fontSize:   10,
      },
      grid: {
        vertLines: { color: GRID_COLOR },
        horzLines: { color: GRID_COLOR },
      },
      crosshair: {
        vertLine: { color: "rgba(79,142,255,0.3)", style: 1, labelBackgroundColor: "#1d2335" },
        horzLine: { color: "rgba(79,142,255,0.3)", style: 1, labelBackgroundColor: "#1d2335" },
      },
      rightPriceScale: {
        borderColor:  BORDER_COL,
        minimumWidth: 68,
      },
      timeScale: {
        borderColor:    BORDER_COL,
        timeVisible:    true,
        secondsVisible: false,
        barSpacing:     8,
        fixLeftEdge:    false,
        fixRightEdge:   false,
      },
      width:  el.clientWidth,
      height: el.clientHeight || 400,
    });

    const candles = chart.addCandlestickSeries({
      upColor:         UP_COLOR,
      downColor:       DOWN_COLOR,
      borderUpColor:   UP_COLOR,
      borderDownColor: DOWN_COLOR,
      wickUpColor:     UP_COLOR,
      wickDownColor:   DOWN_COLOR,
      visible: true,
    });

    const vol = chart.addHistogramSeries({
      color:        "rgba(79,142,255,0.12)",
      priceFormat:  { type: "volume" },
      priceScaleId: "vol",
    });
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });

    const area = chart.addAreaSeries({
      lineColor:   "var(--accent, #4f8eff)",
      topColor:    "rgba(79,142,255,0.1)",
      bottomColor: "rgba(79,142,255,0)",
      lineWidth:   2,
      visible:     false,
    });

    chartRef.current  = chart;
    candleRef.current = candles;
    volRef.current    = vol;
    areaRef.current   = area;

    // OHLC crosshair tooltip
    chart.subscribeCrosshairMove((param) => {
      if (!param.time) {
        setHoveredOhlc(null);
        return;
      }
      const bar = param.seriesData.get(candles) as HoveredOhlc | undefined;
      setHoveredOhlc(bar ?? null);
    });

    const ro = new ResizeObserver(() => {
      if (el && chartRef.current) {
        chartRef.current.applyOptions({ width: el.clientWidth, height: el.clientHeight || 400 });
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

  // ── Mode toggle ────────────────────────────────────────────────────────
  useEffect(() => {
    candleRef.current?.applyOptions({ visible: mode === "candles" });
    areaRef.current?.applyOptions({ visible: mode === "area" });
  }, [mode]);

  // ── Clear all series on every market switch (fixes stale chart bug) ────
  useEffect(() => {
    candleRef.current?.setData([]);
    volRef.current?.setData([]);
    areaRef.current?.setData([]);
    oracleBufferRef.current = [];
    setHoveredOhlc(null);
    setWsLiveClose(null);
  }, [asset]);

  // ── Clear oracle buffer on timeframe switch so stale timestamps don't corrupt new chart
  useEffect(() => {
    oracleBufferRef.current = [];
  }, [timeframe]);

  // ── Load OHLCV data from REST ──────────────────────────────────────────
  useEffect(() => {
    const data = chartData;
    if (!data || !candleRef.current || !volRef.current || !areaRef.current) return;

    try {
      candleRef.current.setData(
        data.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })),
      );
      volRef.current.setData(
        data.map((c) => ({
          time:  c.time as UTCTimestamp,
          value: c.volume,
          color: c.close >= c.open ? "rgba(0,212,126,0.18)" : "rgba(240,64,74,0.15)",
        })),
      );
      areaRef.current.setData(
        data.map((c) => ({ time: c.time as UTCTimestamp, value: c.close })),
      );
      chartRef.current?.timeScale().fitContent();
    } catch (e) {
      console.warn("PriceChart setData error:", e);
    }
  }, [chartData]);

  // ── Live WebSocket candle updates (crypto markets only) ────────────────
  // The WS stream is the source of truth for crypto prices — we do NOT overlay
  // the on-chain oracle price onto crypto candles because the testnet oracle
  // may carry stale prices (e.g. BTC=$65k) that would corrupt the chart.
  useBinanceKlineStream(
    oracleOnly ? null : (asset ?? null),
    timeframe,
    (candle, _isClosed) => {
      candleRef.current?.update({
        time:  candle.time as UTCTimestamp,
        open:  candle.open,
        high:  candle.high,
        low:   candle.low,
        close: candle.close,
      });
      areaRef.current?.update({ time: candle.time as UTCTimestamp, value: candle.close });
      volRef.current?.update({
        time:  candle.time as UTCTimestamp,
        value: candle.volume,
        color: candle.close >= candle.open ? "rgba(0,212,126,0.18)" : "rgba(240,64,74,0.15)",
      });
      // Track live close for toolbar price display
      setWsLiveClose(candle.close);
    },
  );

  // ── RWA oracle buffer — live candle updates from 5s oracle poll
  useEffect(() => {
    if (!oracleOnly || !price) return;
    const p = fromFixed(price);
    const now = Math.floor(Date.now() / 1000);

    const newCandle: Candle = { time: now, open: p, high: p, low: p, close: p, volume: 0 };
    oracleBufferRef.current = [...oracleBufferRef.current.slice(-199), newCandle];

    if (!candleRef.current || !areaRef.current) return;

    if (rwaIndexedData) {
      // Historical data loaded: snap price to current candle bucket and update in place
      const candleSecs = detectCandleSecs(rwaIndexedData);
      const bucketTime = Math.floor(now / candleSecs) * candleSecs;
      try {
        candleRef.current.update({ time: bucketTime as UTCTimestamp, open: p, high: p, low: p, close: p });
        areaRef.current.update({ time: bucketTime as UTCTimestamp, value: p });
      } catch { /* lightweight-charts rejects a time < last bar; safe to ignore */ }
    } else if (!benchmarkQuery.isLoading && !cgOhlcQuery.isLoading) {
      // All external sources finished (no data or no mapping) — fall back to oracle buffer
      const buf = oracleBufferRef.current;
      try {
        areaRef.current.setData(buf.map((c) => ({ time: c.time as UTCTimestamp, value: c.close })));
        candleRef.current.setData(buf.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })));
      } catch { /* ignore */ }
    }
    // While any source is loading: leave chart as-is; data effect will update when it arrives
  }, [price, oracleOnly, rwaIndexedData, timeframe, benchmarkQuery.isLoading, cgOhlcQuery.isLoading]);

  // ── Derived display values ─────────────────────────────────────────────
  // For crypto: use the live Binance WS close (accurate, real-time Binance price).
  // For RWA oracle-only: use the on-chain oracle price (it IS the source of truth).
  // Never use the on-chain oracle for crypto — testnet oracle prices are stale.
  const livePrice   = oracleOnly ? (displayPrice ?? null) : (wsLiveClose ?? chartData?.[chartData.length - 1]?.close ?? null);
  const openPrice   = chartData?.[0]?.close;
  const priceUp     = livePrice !== null && openPrice !== undefined && livePrice >= openPrice;
  const changeAmt   = livePrice !== null && openPrice !== undefined ? livePrice - openPrice : null;
  const changePct   = changeAmt !== null && openPrice !== undefined && openPrice > 0
    ? (changeAmt / openPrice) * 100 : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 280 }}>
      {/* ── Chart toolbar ─────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "6px 12px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg1)",
          flexShrink: 0,
        }}
      >
        {/* Left: asset + price + change + OHLC tooltip */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: "var(--t2)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            {title}
          </span>

          {changePct !== null && hoveredOhlc === null && (
            <span
              className="num"
              style={{
                fontSize: 10,
                fontWeight: 600,
                padding: "2px 5px",
                borderRadius: 2,
                background: priceUp ? "var(--green-dim)" : "var(--red-dim)",
                color: priceUp ? "var(--green)" : "var(--red)",
              }}
            >
              {priceUp ? "+" : ""}{changePct.toFixed(2)}%
            </span>
          )}

          {/* OHLC crosshair tooltip */}
          {hoveredOhlc !== null && (
            <div
              className="num"
              style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 10, color: "var(--t2)" }}
            >
              <OhlcCell label="O" value={hoveredOhlc.open} up={hoveredOhlc.close >= hoveredOhlc.open} />
              <OhlcCell label="H" value={hoveredOhlc.high} up={true} />
              <OhlcCell label="L" value={hoveredOhlc.low}  up={false} />
              <OhlcCell label="C" value={hoveredOhlc.close} up={hoveredOhlc.close >= hoveredOhlc.open} />
            </div>
          )}

          {/* Data source labels */}
          {oracleOnly && rwaSource === "pyth-benchmark" && (
            <span style={{ fontSize: 10, color: "var(--accent)" }}>NAV · Pyth</span>
          )}
          {oracleOnly && rwaSource === "coingecko" && (
            <span style={{ fontSize: 10, color: "var(--accent)", opacity: 0.7 }}>NAV · CoinGecko</span>
          )}
          {oracleOnly && rwaSource === "indexer" && (
            <span style={{ fontSize: 10, color: "var(--gold)" }}>NAV · indexed oracle</span>
          )}
          {oracleOnly && !rwaIndexedData && oracleBufferRef.current.length > 0 && (
            <span style={{ fontSize: 10, color: "var(--gold)" }}>NAV · live oracle ({oracleBufferRef.current.length}pts)</span>
          )}
          {oracleOnly && !rwaIndexedData && oracleBufferRef.current.length === 0 && price !== undefined && (
            <span style={{ fontSize: 10, color: "var(--gold)" }}>NAV · live oracle</span>
          )}
          {oracleOnly && !rwaIndexedData && price === undefined && !cgOhlcQuery.isLoading && !rwaOhlcQuery.isLoading && (
            <span style={{ fontSize: 10, color: "var(--t3)" }}>NAV · waiting for oracle...</span>
          )}
          {!oracleOnly && ohlcQuery.isError && (
            <span style={{ fontSize: 10, color: "var(--t3)" }}>Chart data unavailable</span>
          )}
        </div>

        {/* Right: mode toggle + timeframe buttons */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Candles / Area toggle */}
          <div
            style={{
              display: "flex",
              border: "1px solid var(--border)",
              borderRadius: 3,
              overflow: "hidden",
            }}
          >
            {(["candles", "area"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                style={{
                  padding: "3px 8px",
                  fontSize: 10,
                  fontWeight: 600,
                  fontFamily: "'JetBrains Mono', monospace",
                  border: "none",
                  cursor: "pointer",
                  textTransform: "capitalize",
                  background: mode === m ? "var(--bg3)" : "transparent",
                  color: mode === m ? "var(--t1)" : "var(--t3)",
                  transition: "background 0.1s, color 0.1s",
                }}
              >
                {m}
              </button>
            ))}
          </div>

          {/* Timeframe buttons */}
          <div style={{ display: "flex", gap: 1 }}>
            {INTERVALS.map((iv) => (
              <button
                key={iv.value}
                onClick={() => setTimeframe(iv.value)}
                style={{
                  padding: "3px 7px",
                  fontSize: 10,
                  fontWeight: 600,
                  fontFamily: "'JetBrains Mono', monospace",
                  border: timeframe === iv.value ? "1px solid var(--border2)" : "1px solid transparent",
                  borderRadius: 2,
                  cursor: "pointer",
                  background: timeframe === iv.value ? "var(--bg3)" : "transparent",
                  color: timeframe === iv.value ? "var(--t1)" : "var(--t3)",
                  transition: "background 0.1s, color 0.1s",
                }}
              >
                {iv.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Chart canvas ──────────────────────────────────────────── */}
      <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
        <div ref={containerRef} style={{ width: "100%", height: "100%" }} />

        {/* Loading overlay */}
        {isLoading && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(11,14,20,0.72)",
              fontSize: 11,
              color: "var(--t3)",
              zIndex: 5,
              pointerEvents: "none",
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            Loading chart data...
          </div>
        )}

        {/* No-data state */}
        {!isLoading && !chartData?.length && !price && oracleBufferRef.current.length === 0 && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              color: "var(--t3)",
              pointerEvents: "none",
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            No chart data available
          </div>
        )}
      </div>
    </div>
  );
}

// ── OHLC cell sub-component ────────────────────────────────────────────────

function OhlcCell({ label, value, up }: { label: string; value: number; up: boolean }) {
  return (
    <span style={{ display: "flex", alignItems: "baseline", gap: 3 }}>
      <span style={{ color: "var(--t3)", fontSize: 9 }}>{label}</span>
      <span style={{ color: up ? "var(--green)" : "var(--red)", fontWeight: 600 }}>
        ${fmtPrice(value)}
      </span>
    </span>
  );
}
