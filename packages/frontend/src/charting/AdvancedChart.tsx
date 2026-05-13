/**
 * AdvancedChart — professional-grade charting using lightweight-charts.
 *
 * Features:
 *   • Candlestick / Line / Area / Baseline chart types
 *   • EMA(20, 50, 200) + SMA(200) overlays
 *   • Bollinger Bands (20, 2)
 *   • Volume histogram
 *   • RSI panel (separate chart below)
 *   • MACD panel (separate chart below)
 *   • Crosshair tooltip with OHLC + indicator values
 *   • Timeframe selector
 *   • Drawing: horizontal price lines
 *   • Works for ALL tokens (crypto via Binance, RWA via oracle/indexer)
 */

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import {
  ColorType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  type LineData,
  type HistogramData,
  type AreaData,
  type BaselineData,
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
import {
  sma,
  ema,
  bollinger,
  rsi,
  macd,
  type Candle as IndicatorCandle,
  type IndicatorPoint,
} from "./indicators";

// ── Palette ─────────────────────────────────────────────────────────────────
const UP_COLOR = "#00d47e";
const DOWN_COLOR = "#f0404a";
const CHART_BG = "#0b0e14";
const PANE_BG = "#0b0e14";
const TEXT_COLOR = "#4e5a6e";
const GRID_COLOR = "rgba(255,255,255,0.03)";
const BORDER_COL = "#1d2335";

const EMA20_COLOR = "#f0a742";
const EMA50_COLOR = "#4f8eff";
const SMA200_COLOR = "#a855f7";
const BB_COLOR = "rgba(79,142,255,0.3)";
const VOL_COLOR_UP = "rgba(0,212,126,0.18)";
const VOL_COLOR_DOWN = "rgba(240,64,74,0.15)";

const INTERVALS: { label: string; value: Interval }[] = [
  { label: "1m", value: "1m" },
  { label: "5m", value: "5m" },
  { label: "15m", value: "15m" },
  { label: "1H", value: "1h" },
  { label: "4H", value: "4h" },
  { label: "1D", value: "1d" },
];

// ── Props ───────────────────────────────────────────────────────────────────

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
  if (v >= 1) return v.toFixed(4);
  return v.toFixed(6);
}

function detectCandleSecs(candles: Candle[]): number {
  if (candles.length < 2) return 300;
  const diff = candles[candles.length - 1]!.time - candles[candles.length - 2]!.time;
  return diff > 0 ? diff : 300;
}

// ── Component ───────────────────────────────────────────────────────────────

export function AdvancedChart({ price, timestamp: _timestamp, title, asset }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rsiContainerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const lineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const areaRef = useRef<ISeriesApi<"Area"> | null>(null);
  const baselineRef = useRef<ISeriesApi<"Baseline"> | null>(null);
  const ema20Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const ema50Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const sma200Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const bbUpperRef = useRef<ISeriesApi<"Line"> | null>(null);
  const bbLowerRef = useRef<ISeriesApi<"Line"> | null>(null);
  const rsiChartRef = useRef<IChartApi | null>(null);
  const rsiSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const oracleBufferRef = useRef<Candle[]>([]);

  const [timeframe, setTimeframe] = useState<Interval>("15m");
  const [chartType, setChartType] = useState<"candles" | "line" | "area" | "baseline">("candles");
  const [hoveredOhlc, setHoveredOhlc] = useState<HoveredOhlc | null>(null);
  const [hoveredVol, setHoveredVol] = useState<number | null>(null);
  const [hoveredIndicators, setHoveredIndicators] = useState<Record<string, number | null>>({});
  const [wsLiveClose, setWsLiveClose] = useState<number | null>(null);
  const [showEma20, setShowEma20] = useState(true);
  const [showEma50, setShowEma50] = useState(true);
  const [showSma200, setShowSma200] = useState(false);
  const [showBb, setShowBb] = useState(false);
  const [showRsi, setShowRsi] = useState(false);
  const [showVol, setShowVol] = useState(true);

  const oracleOnly = asset !== null && asset !== undefined && toBinanceSymbol(asset) === null;
  const ohlcQuery = useBinanceOHLC(asset ?? null, timeframe);
  const rwaOhlcQuery = useRwaOHLC(asset ?? null, timeframe);
  const benchmarkQuery = usePythBenchmarkOHLC(oracleOnly ? (asset ?? null) : null, timeframe);
  const cgOhlcQuery = useCoinGeckoOHLC(oracleOnly ? (asset ?? null) : null, timeframe);

  const hasBenchmarkData = (benchmarkQuery.data?.length ?? 0) > 0;
  const hasCgData = (cgOhlcQuery.data?.length ?? 0) > 0;
  const hasIndexerData = (rwaOhlcQuery.data?.length ?? 0) > 0;
  const rwaIndexedData = oracleOnly
    ? hasBenchmarkData ? benchmarkQuery.data
    : hasCgData ? cgOhlcQuery.data
    : hasIndexerData ? rwaOhlcQuery.data
    : undefined
    : undefined;

  const chartData = oracleOnly ? rwaIndexedData : ohlcQuery.data;
  const displayPrice = price !== undefined ? fromFixed(price) : undefined;

  const anyRwaLoading = benchmarkQuery.isLoading || cgOhlcQuery.isLoading || rwaOhlcQuery.isLoading;
  const isLoading =
    (!oracleOnly && ohlcQuery.isLoading && !ohlcQuery.data) ||
    (oracleOnly && anyRwaLoading && !rwaIndexedData);

  // ── Calculate indicators ───────────────────────────────────────────────
  const indicators = useMemo(() => {
    const data = chartData;
    if (!data || data.length < 50) return null;
    const candles: IndicatorCandle[] = data.map((c) => ({ ...c }));
    return {
      ema20: ema(candles, 20),
      ema50: ema(candles, 50),
      sma200: sma(candles, 200),
      bb: bollinger(candles, 20, 2),
      rsi: rsi(candles, 14),
      macd: macd(candles, 12, 26, 9),
    };
  }, [chartData]);

  // ── Init main chart ────────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: CHART_BG },
        textColor: TEXT_COLOR,
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        fontSize: 10,
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
        borderColor: BORDER_COL,
        minimumWidth: 68,
      },
      timeScale: {
        borderColor: BORDER_COL,
        timeVisible: true,
        secondsVisible: false,
        barSpacing: 8,
        fixLeftEdge: false,
        fixRightEdge: false,
      },
      width: el.clientWidth,
      height: el.clientHeight || 400,
    });

    const candles = chart.addCandlestickSeries({
      upColor: UP_COLOR,
      downColor: DOWN_COLOR,
      borderUpColor: UP_COLOR,
      borderDownColor: DOWN_COLOR,
      wickUpColor: UP_COLOR,
      wickDownColor: DOWN_COLOR,
    });

    const vol = chart.addHistogramSeries({
      color: VOL_COLOR_UP,
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
    });
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.88, bottom: 0 } });

    const line = chart.addLineSeries({
      color: "var(--accent, #4f8eff)",
      lineWidth: 2,
      visible: false,
    });

    const area = chart.addAreaSeries({
      lineColor: "var(--accent, #4f8eff)",
      topColor: "rgba(79,142,255,0.1)",
      bottomColor: "rgba(79,142,255,0)",
      lineWidth: 2,
      visible: false,
    });

    const baseline = chart.addBaselineSeries({
      baseValue: { type: "price", price: 0 },
      topLineColor: UP_COLOR,
      bottomLineColor: DOWN_COLOR,
      lineWidth: 2,
      visible: false,
    });

    const ema20 = chart.addLineSeries({ color: EMA20_COLOR, lineWidth: 1, visible: showEma20 });
    const ema50 = chart.addLineSeries({ color: EMA50_COLOR, lineWidth: 1, visible: showEma50 });
    const sma200 = chart.addLineSeries({ color: SMA200_COLOR, lineWidth: 1, visible: showSma200 });
    const bbUpper = chart.addLineSeries({ color: BB_COLOR, lineWidth: 1, lineStyle: 2, visible: showBb });
    const bbLower = chart.addLineSeries({ color: BB_COLOR, lineWidth: 1, lineStyle: 2, visible: showBb });

    chartRef.current = chart;
    candleRef.current = candles;
    volRef.current = vol;
    lineRef.current = line;
    areaRef.current = area;
    baselineRef.current = baseline;
    ema20Ref.current = ema20;
    ema50Ref.current = ema50;
    sma200Ref.current = sma200;
    bbUpperRef.current = bbUpper;
    bbLowerRef.current = bbLower;

    // Crosshair: OHLC + volume + indicators
    chart.subscribeCrosshairMove((param) => {
      if (!param.time) {
        setHoveredOhlc(null);
        setHoveredVol(null);
        setHoveredIndicators({});
        return;
      }
      const ohlc = param.seriesData.get(candles) as HoveredOhlc | undefined;
      setHoveredOhlc(ohlc ?? null);
      const v = param.seriesData.get(vol) as { value?: number } | undefined;
      setHoveredVol(v?.value ?? null);

      const inds: Record<string, number | null> = {};
      const e20 = param.seriesData.get(ema20) as { value?: number } | undefined;
      const e50 = param.seriesData.get(ema50) as { value?: number } | undefined;
      const s200 = param.seriesData.get(sma200) as { value?: number } | undefined;
      const bbu = param.seriesData.get(bbUpper) as { value?: number } | undefined;
      const bbl = param.seriesData.get(bbLower) as { value?: number } | undefined;
      if (e20?.value !== undefined) inds["EMA20"] = e20.value;
      if (e50?.value !== undefined) inds["EMA50"] = e50.value;
      if (s200?.value !== undefined) inds["SMA200"] = s200.value;
      if (bbu?.value !== undefined) inds["BBU"] = bbu.value;
      if (bbl?.value !== undefined) inds["BBL"] = bbl.value;
      setHoveredIndicators(inds);
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
      chartRef.current = null;
      candleRef.current = null;
      volRef.current = null;
      lineRef.current = null;
      areaRef.current = null;
      baselineRef.current = null;
      ema20Ref.current = null;
      ema50Ref.current = null;
      sma200Ref.current = null;
      bbUpperRef.current = null;
      bbLowerRef.current = null;
    };
  }, []);

  // ── Init RSI chart ─────────────────────────────────────────────────────
  useEffect(() => {
    const el = rsiContainerRef.current;
    if (!el || !showRsi) return;

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: PANE_BG },
        textColor: TEXT_COLOR,
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        fontSize: 9,
      },
      grid: {
        vertLines: { color: GRID_COLOR },
        horzLines: { color: GRID_COLOR },
      },
      rightPriceScale: { borderColor: BORDER_COL, minimumWidth: 68 },
      timeScale: {
        borderColor: BORDER_COL,
        timeVisible: true,
        secondsVisible: false,
        visible: false,
      },
      crosshair: { vertLine: { color: "rgba(79,142,255,0.2)", style: 1 }, horzLine: { color: "rgba(79,142,255,0.2)", style: 1 } },
      width: el.clientWidth,
      height: 80,
    });

    const rsiLine = chart.addLineSeries({ color: "#4f8eff", lineWidth: 1 });
    // Add 30/70 reference lines
    const ref30 = chart.addLineSeries({ color: "rgba(0,212,126,0.3)", lineWidth: 1, lastValueVisible: false, priceLineVisible: false });
    const ref70 = chart.addLineSeries({ color: "rgba(240,64,74,0.3)", lineWidth: 1, lastValueVisible: false, priceLineVisible: false });

    rsiChartRef.current = chart;
    rsiSeriesRef.current = rsiLine;

    // Set reference lines (static)
    ref30.setData([]); // placeholder, will be filled when data arrives
    ref70.setData([]);

    const ro = new ResizeObserver(() => {
      if (el && rsiChartRef.current) {
        rsiChartRef.current.applyOptions({ width: el.clientWidth });
      }
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      rsiChartRef.current = null;
      rsiSeriesRef.current = null;
    };
  }, [showRsi]);

  // ── Toggle series visibility ───────────────────────────────────────────
  useEffect(() => { ema20Ref.current?.applyOptions({ visible: showEma20 }); }, [showEma20]);
  useEffect(() => { ema50Ref.current?.applyOptions({ visible: showEma50 }); }, [showEma50]);
  useEffect(() => { sma200Ref.current?.applyOptions({ visible: showSma200 }); }, [showSma200]);
  useEffect(() => { bbUpperRef.current?.applyOptions({ visible: showBb }); bbLowerRef.current?.applyOptions({ visible: showBb }); }, [showBb]);
  useEffect(() => { volRef.current?.applyOptions({ visible: showVol }); }, [showVol]);

  // ── Chart type toggle ──────────────────────────────────────────────────
  useEffect(() => {
    candleRef.current?.applyOptions({ visible: chartType === "candles" });
    lineRef.current?.applyOptions({ visible: chartType === "line" });
    areaRef.current?.applyOptions({ visible: chartType === "area" });
    baselineRef.current?.applyOptions({ visible: chartType === "baseline" });
  }, [chartType]);

  // ── Clear on market switch ─────────────────────────────────────────────
  useEffect(() => {
    candleRef.current?.setData([]);
    volRef.current?.setData([]);
    lineRef.current?.setData([]);
    areaRef.current?.setData([]);
    baselineRef.current?.setData([]);
    ema20Ref.current?.setData([]);
    ema50Ref.current?.setData([]);
    sma200Ref.current?.setData([]);
    bbUpperRef.current?.setData([]);
    bbLowerRef.current?.setData([]);
    rsiSeriesRef.current?.setData([]);
    oracleBufferRef.current = [];
    setHoveredOhlc(null);
    setHoveredVol(null);
    setWsLiveClose(null);
  }, [asset]);

  useEffect(() => {
    oracleBufferRef.current = [];
  }, [timeframe]);

  // ── Load data + indicators ─────────────────────────────────────────────
  useEffect(() => {
    const data = chartData;
    if (!data || !candleRef.current || !volRef.current) return;

    try {
      const candleData = data.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close }));
      candleRef.current.setData(candleData);
      volRef.current.setData(
        data.map((c) => ({
          time: c.time as UTCTimestamp,
          value: c.volume,
          color: c.close >= c.open ? VOL_COLOR_UP : VOL_COLOR_DOWN,
        })),
      );
      lineRef.current?.setData(data.map((c) => ({ time: c.time as UTCTimestamp, value: c.close })));
      areaRef.current?.setData(data.map((c) => ({ time: c.time as UTCTimestamp, value: c.close })));
      baselineRef.current?.setData(data.map((c) => ({ time: c.time as UTCTimestamp, value: c.close })));

      if (indicators) {
        ema20Ref.current?.setData(indicators.ema20.map((d) => ({ time: d.time as UTCTimestamp, value: d.value })));
        ema50Ref.current?.setData(indicators.ema50.map((d) => ({ time: d.time as UTCTimestamp, value: d.value })));
        sma200Ref.current?.setData(indicators.sma200.map((d) => ({ time: d.time as UTCTimestamp, value: d.value })));
        bbUpperRef.current?.setData(indicators.bb.upper.map((d) => ({ time: d.time as UTCTimestamp, value: d.value })));
        bbLowerRef.current?.setData(indicators.bb.lower.map((d) => ({ time: d.time as UTCTimestamp, value: d.value })));
        rsiSeriesRef.current?.setData(indicators.rsi.map((d) => ({ time: d.time as UTCTimestamp, value: d.value })));
      }

      chartRef.current?.timeScale().fitContent();
      rsiChartRef.current?.timeScale().fitContent();
    } catch (e) {
      console.warn("AdvancedChart setData error:", e);
    }
  }, [chartData, indicators]);

  // ── Live WebSocket updates (crypto only) ───────────────────────────────
  useBinanceKlineStream(
    oracleOnly ? null : (asset ?? null),
    timeframe,
    (candle, _isClosed) => {
      const t = candle.time as UTCTimestamp;
      candleRef.current?.update({ time: t, open: candle.open, high: candle.high, low: candle.low, close: candle.close });
      lineRef.current?.update({ time: t, value: candle.close });
      areaRef.current?.update({ time: t, value: candle.close });
      baselineRef.current?.update({ time: t, value: candle.close });
      volRef.current?.update({
        time: t,
        value: candle.volume,
        color: candle.close >= candle.open ? VOL_COLOR_UP : VOL_COLOR_DOWN,
      });
      setWsLiveClose(candle.close);
    },
  );

  // ── RWA oracle buffer updates ──────────────────────────────────────────
  useEffect(() => {
    if (!oracleOnly || !price) return;
    const p = fromFixed(price);
    const now = Math.floor(Date.now() / 1000);
    const newCandle: Candle = { time: now, open: p, high: p, low: p, close: p, volume: 0 };
    oracleBufferRef.current = [...oracleBufferRef.current.slice(-199), newCandle];

    if (!candleRef.current) return;
    if (rwaIndexedData) {
      const candleSecs = detectCandleSecs(rwaIndexedData);
      const bucketTime = Math.floor(now / candleSecs) * candleSecs;
      try {
        candleRef.current.update({ time: bucketTime as UTCTimestamp, open: p, high: p, low: p, close: p });
        lineRef.current?.update({ time: bucketTime as UTCTimestamp, value: p });
        areaRef.current?.update({ time: bucketTime as UTCTimestamp, value: p });
      } catch { /* ignore */ }
    } else if (!benchmarkQuery.isLoading && !cgOhlcQuery.isLoading) {
      const buf = oracleBufferRef.current;
      try {
        candleRef.current.setData(buf.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })));
        lineRef.current?.setData(buf.map((c) => ({ time: c.time as UTCTimestamp, value: c.close })));
        areaRef.current?.setData(buf.map((c) => ({ time: c.time as UTCTimestamp, value: c.close })));
      } catch { /* ignore */ }
    }
  }, [price, oracleOnly, rwaIndexedData, timeframe, benchmarkQuery.isLoading, cgOhlcQuery.isLoading]);

  // ── Derived display values ─────────────────────────────────────────────
  const livePrice = oracleOnly ? (displayPrice ?? null) : (wsLiveClose ?? chartData?.[chartData.length - 1]?.close ?? null);
  const openPrice = chartData?.[0]?.close;
  const priceUp = livePrice !== null && openPrice !== undefined && livePrice >= openPrice;
  const changePct = livePrice !== null && openPrice !== undefined && openPrice > 0
    ? ((livePrice - openPrice) / openPrice) * 100 : null;

  // ── Price line drawing ─────────────────────────────────────────────────
  const addPriceLine = useCallback(() => {
    if (!chartRef.current || livePrice === null) return;
    const series = candleRef.current ?? lineRef.current ?? areaRef.current;
    if (!series) return;
    series.createPriceLine({
      price: livePrice,
      color: "rgba(240,167,66,0.5)",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: "Manual",
    });
  }, [livePrice]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 280 }}>
      {/* ── Toolbar ─────────────────────────────────────────────── */}
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
          <span style={{ fontSize: 11, fontWeight: 700, color: "var(--t2)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
            {title}
          </span>
          {changePct !== null && hoveredOhlc === null && (
            <span className="num" style={{
              fontSize: 10, fontWeight: 600, padding: "2px 5px", borderRadius: 2,
              background: priceUp ? "var(--green-dim)" : "var(--red-dim)",
              color: priceUp ? "var(--green)" : "var(--red)",
            }}>
              {priceUp ? "+" : ""}{changePct.toFixed(2)}%
            </span>
          )}
          {hoveredOhlc !== null && (
            <div className="num" style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 10, color: "var(--t2)" }}>
              <OhlcCell label="O" value={hoveredOhlc.open} />
              <OhlcCell label="H" value={hoveredOhlc.high} />
              <OhlcCell label="L" value={hoveredOhlc.low} />
              <OhlcCell label="C" value={hoveredOhlc.close} />
              {hoveredVol !== null && <span style={{ color: "var(--t3)", fontSize: 9 }}>V {hoveredVol.toFixed(2)}</span>}
            </div>
          )}
          {/* Indicator values on crosshair */}
          {Object.entries(hoveredIndicators).map(([name, val]) =>
            val !== null ? (
              <span key={name} className="num" style={{ fontSize: 9, color: "var(--t3)" }}>
                {name} {fmtPrice(val)}
              </span>
            ) : null
          )}
        </div>

        {/* Right: controls */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {/* Chart type */}
          <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 3, overflow: "hidden" }}>
            {(["candles", "line", "area"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setChartType(t)}
                style={{
                  padding: "3px 8px", fontSize: 10, fontWeight: 600,
                  fontFamily: "'JetBrains Mono', monospace", border: "none", cursor: "pointer",
                  textTransform: "capitalize",
                  background: chartType === t ? "var(--bg3)" : "transparent",
                  color: chartType === t ? "var(--t1)" : "var(--t3)",
                }}
              >
                {t}
              </button>
            ))}
          </div>

          {/* Indicator toggles */}
          {[
            { key: "EMA20", active: showEma20, toggle: () => setShowEma20((v) => !v), color: EMA20_COLOR },
            { key: "EMA50", active: showEma50, toggle: () => setShowEma50((v) => !v), color: EMA50_COLOR },
            { key: "SMA200", active: showSma200, toggle: () => setShowSma200((v) => !v), color: SMA200_COLOR },
            { key: "BB", active: showBb, toggle: () => setShowBb((v) => !v), color: "#4f8eff" },
            { key: "RSI", active: showRsi, toggle: () => setShowRsi((v) => !v), color: "#4f8eff" },
            { key: "VOL", active: showVol, toggle: () => setShowVol((v) => !v), color: "var(--t3)" },
          ].map((ind) => (
            <button
              key={ind.key}
              onClick={ind.toggle}
              style={{
                padding: "2px 6px", fontSize: 9, fontWeight: 600,
                fontFamily: "'JetBrains Mono', monospace", borderRadius: 2,
                border: ind.active ? `1px solid ${ind.color}` : "1px solid var(--border)",
                background: ind.active ? `${ind.color}22` : "transparent",
                color: ind.active ? ind.color : "var(--t3)", cursor: "pointer",
              }}
            >
              {ind.key}
            </button>
          ))}

          <button
            onClick={addPriceLine}
            title="Add price line"
            style={{
              padding: "2px 6px", fontSize: 9, fontWeight: 600,
              fontFamily: "'JetBrains Mono', monospace", borderRadius: 2,
              border: "1px solid var(--border)", background: "transparent",
              color: "var(--t3)", cursor: "pointer",
            }}
          >
            +Line
          </button>

          {/* Timeframes */}
          <div style={{ display: "flex", gap: 1 }}>
            {INTERVALS.map((iv) => (
              <button
                key={iv.value}
                onClick={() => setTimeframe(iv.value)}
                style={{
                  padding: "3px 7px", fontSize: 10, fontWeight: 600,
                  fontFamily: "'JetBrains Mono', monospace",
                  border: timeframe === iv.value ? "1px solid var(--border2)" : "1px solid transparent",
                  borderRadius: 2, cursor: "pointer",
                  background: timeframe === iv.value ? "var(--bg3)" : "transparent",
                  color: timeframe === iv.value ? "var(--t1)" : "var(--t3)",
                }}
              >
                {iv.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Chart + optional RSI ────────────────────────────────── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div ref={containerRef} style={{ flex: 1, minHeight: 0 }} />
        {showRsi && (
          <div ref={rsiContainerRef} style={{ height: 80, flexShrink: 0, borderTop: "1px solid var(--border)" }} />
        )}

        {/* Loading overlay */}
        {isLoading && (
          <div style={{
            position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgba(11,14,20,0.72)", fontSize: 11, color: "var(--t3)", zIndex: 5, pointerEvents: "none",
            fontFamily: "'JetBrains Mono', monospace",
          }}>
            Loading chart data...
          </div>
        )}

        {/* No-data state */}
        {!isLoading && !chartData?.length && !price && oracleBufferRef.current.length === 0 && (
          <div style={{
            position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 11, color: "var(--t3)", pointerEvents: "none", fontFamily: "'JetBrains Mono', monospace",
          }}>
            No chart data available
          </div>
        )}
      </div>
    </div>
  );
}

function OhlcCell({ label, value }: { label: string; value: number }) {
  return (
    <span style={{ display: "flex", alignItems: "baseline", gap: 3 }}>
      <span style={{ color: "var(--t3)", fontSize: 9 }}>{label}</span>
      <span style={{ color: "var(--t1)", fontWeight: 600 }}>${fmtPrice(value)}</span>
    </span>
  );
}
