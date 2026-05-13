/**
 * Hooks for fetching live market data from Binance's public REST API.
 * No API key required. Used for:
 *   – useBinanceOHLC   : historical OHLCV candlestick data for the price chart
 *   – useBinanceTicker : 24-h price-change percentages for the price ticker bar
 */

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { config } from "@/config";

// ── Symbol mapping (oracle feed → Binance spot symbol) ────────────────────────

export const BINANCE_SYMBOL_MAP: Record<string, string> = {
  XLM: "XLMUSDT",
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
  SOL: "SOLUSDT",
};

export function toBinanceSymbol(asset: string): string | null {
  return BINANCE_SYMBOL_MAP[asset.toUpperCase()] ?? null;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type Interval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export interface Candle {
  /** Unix timestamp in seconds (lightweight-charts UTCTimestamp). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Ticker24h {
  priceChangePercent: number;
  lastPrice: number;
  volume: number;
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function fetchKlines(
  symbol: string,
  interval: Interval,
  limit = 220,
): Promise<Candle[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance klines ${res.status}: ${symbol}`);
  const raw = (await res.json()) as [
    number,   // openTime ms
    string,   // open
    string,   // high
    string,   // low
    string,   // close
    string,   // volume
    ...unknown[],
  ][];
  return raw.map((k) => ({
    time: Math.floor(k[0] / 1000),
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

async function fetchTicker24h(symbol: string): Promise<Ticker24h> {
  const url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ticker ${res.status}: ${symbol}`);
  const d = (await res.json()) as {
    priceChangePercent: string;
    lastPrice: string;
    volume: string;
  };
  return {
    priceChangePercent: parseFloat(d.priceChangePercent),
    lastPrice:          parseFloat(d.lastPrice),
    volume:             parseFloat(d.volume),
  };
}

interface IndexerCandle {
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
}

function fixedStringToNumber(value: string): number {
  return Number(BigInt(value)) / 1e18;
}

function intervalSecs(interval: Interval): number {
  switch (interval) {
    case "1m": return 60;
    case "5m": return 300;
    case "15m": return 900;
    case "1h": return 3_600;
    case "4h": return 14_400;
    case "1d": return 86_400;
  }
}

async function fetchRwaCandles(feed: string, interval: Interval, limit = 220): Promise<Candle[]> {
  const base = config.indexer.url.replace(/\/$/, "");
  const url = `${base}/prices/${encodeURIComponent(feed.toUpperCase())}/candles?interval=${intervalSecs(interval)}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Indexer RWA candles ${res.status}: ${feed}`);
  const raw = (await res.json()) as IndexerCandle[];
  return raw.map((c) => ({
    time: c.time,
    open: fixedStringToNumber(c.open),
    high: fixedStringToNumber(c.high),
    low: fixedStringToNumber(c.low),
    close: fixedStringToNumber(c.close),
    volume: 0,
  }));
}

async function fetchRwaTicker24h(feed: string): Promise<Ticker24h> {
  const candles = await fetchRwaCandles(feed, "1h", 26);
  if (candles.length === 0) throw new Error(`Indexer RWA ticker has no candles: ${feed}`);
  const last = candles[candles.length - 1]!;
  const first = candles[0]!;
  const open = first.open > 0 ? first.open : first.close;
  const priceChangePercent = open > 0 ? ((last.close - open) / open) * 100 : 0;
  return {
    priceChangePercent,
    lastPrice: last.close,
    volume: 0,
  };
}

// ── Refetch cadence ───────────────────────────────────────────────────────────

function klineRefetchMs(interval: Interval): number {
  switch (interval) {
    case "1m":  return 15_000;
    case "5m":  return 30_000;
    case "15m": return 60_000;
    default:    return 5 * 60_000;
  }
}

// ── React Query hooks ─────────────────────────────────────────────────────────

/**
 * Fetch OHLCV candlestick data from Binance for the given oracle asset symbol
 * (e.g. "BTC"). Returns undefined while loading or when the asset is unknown.
 */
export function useBinanceOHLC(asset: string | null, interval: Interval) {
  const sym = asset ? toBinanceSymbol(asset) : null;
  return useQuery({
    queryKey: ["binance", "klines", sym, interval],
    queryFn:  () => fetchKlines(sym!, interval),
    enabled:  sym !== null,
    refetchInterval: klineRefetchMs(interval),
    staleTime: 5_000,
    retry: 2,
  });
}

/** Fetch OHLC candles from the StellaX indexer for oracle-only RWA feeds. */
export function useRwaOHLC(asset: string | null, interval: Interval) {
  const feed = asset?.toUpperCase() ?? null;
  return useQuery({
    queryKey: ["indexer", "rwa-candles", feed, interval],
    queryFn: () => fetchRwaCandles(feed!, interval),
    enabled: config.indexer.enabled && feed !== null && toBinanceSymbol(feed) === null,
    refetchInterval: klineRefetchMs(interval),
    staleTime: 5_000,
    retry: 1,
  });
}

/** Fetch 24-hour ticker stats from indexed RWA oracle candles. */
export function useRwaTicker(asset: string | null) {
  const feed = asset?.toUpperCase() ?? null;
  return useQuery({
    queryKey: ["indexer", "rwa-ticker24h", feed],
    queryFn: () => fetchRwaTicker24h(feed!),
    enabled: config.indexer.enabled && feed !== null && toBinanceSymbol(feed) === null,
    refetchInterval: 60_000,
    staleTime: 15_000,
    retry: 1,
  });
}

/**
 * Fetch 24-hour rolling ticker stats from Binance.
 * Used by the PriceTicker bar to show price-change percentages.
 */
export function useBinanceTicker(asset: string | null) {
  const sym = asset ? toBinanceSymbol(asset) : null;
  return useQuery({
    queryKey: ["binance", "ticker24h", sym],
    queryFn:  () => fetchTicker24h(sym!),
    enabled:  sym !== null,
    refetchInterval: 10_000,
    staleTime: 5_000,
    retry: 2,
  });
}

// ── Binance WebSocket kline stream ────────────────────────────────────────────

interface BinanceKlineEvent {
  e: string;
  k: {
    t: number;   // kline open time ms
    o: string;
    h: string;
    l: string;
    c: string;
    v: string;
    x: boolean;  // is this kline closed?
  };
}

// ── Pyth Benchmarks OHLC — true 1m/5m/15m/1h/4h/1d for Pyth-listed RWA assets ──

export const PYTH_BENCHMARK_SYMBOLS: Record<string, string> = {
  USDY: "Crypto.USDY/USD",
  // OUSG / BENJI: add if they appear on Pyth Benchmarks
};

interface PythBenchmarkResponse {
  s: string;   // "ok" | "no_data" | "error"
  t: number[]; // open timestamps (unix seconds)
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v?: number[];
}

function intervalToResolution(interval: Interval): string {
  switch (interval) {
    case "1m":  return "1";
    case "5m":  return "5";
    case "15m": return "15";
    case "1h":  return "60";
    case "4h":  return "240";
    case "1d":  return "D";
  }
}

function intervalToRangeSecs(interval: Interval, limit: number): number {
  const candle: Record<Interval, number> = {
    "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400,
  };
  return candle[interval] * (limit + 10); // fetch a few extra to guarantee limit
}

async function fetchPythBenchmarkOHLC(symbol: string, interval: Interval, limit = 220): Promise<Candle[]> {
  const to   = Math.floor(Date.now() / 1000);
  const from = to - intervalToRangeSecs(interval, limit);
  const url  = new URL("https://benchmarks.pyth.network/v1/shims/tradingview/history");
  url.searchParams.set("symbol",     symbol);
  url.searchParams.set("resolution", intervalToResolution(interval));
  url.searchParams.set("from",       String(from));
  url.searchParams.set("to",         String(to));

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Pyth Benchmarks ${res.status}: ${symbol}`);
  const body = await res.json() as PythBenchmarkResponse;
  if (body.s !== "ok" || !body.t?.length) throw new Error(`Pyth Benchmarks no_data: ${symbol}`);

  const seen = new Set<number>();
  return body.t
    .map((ts, i) => ({
      time:   ts,
      open:   body.o[i] ?? body.c[i] ?? 0,
      high:   body.h[i] ?? body.c[i] ?? 0,
      low:    body.l[i] ?? body.c[i] ?? 0,
      close:  body.c[i] ?? 0,
      volume: body.v?.[i] ?? 0,
    }))
    .filter(c => c.close > 0 && !seen.has(c.time) && seen.add(c.time) as unknown as boolean)
    .sort((a, b) => a.time - b.time)
    .slice(-limit);
}

export function usePythBenchmarkOHLC(asset: string | null, interval: Interval) {
  const symbol = asset ? (PYTH_BENCHMARK_SYMBOLS[asset.toUpperCase()] ?? null) : null;
  return useQuery({
    queryKey: ["pyth-benchmark", "ohlc", symbol, interval],
    queryFn:  () => fetchPythBenchmarkOHLC(symbol!, interval),
    enabled:  symbol !== null,
    refetchInterval: klineRefetchMs(interval),
    staleTime: 10_000,
    retry: 1,
  });
}

// ── CoinGecko OHLC for RWA assets ─────────────────────────────────────────────
// Used as fallback when Pyth Benchmarks has no symbol mapping (OUSG, BENJI).
// Granularity: 30min (days=1), 4h (days=7/30), 1d (days=90) — same data for 1m/5m/15m.

export const COINGECKO_COIN_IDS: Record<string, string> = {
  USDY: "ondo-us-dollar-yield",
  // OUSG / BENJI: add CoinGecko IDs here once confirmed listed
};

function intervalToDays(interval: Interval): number {
  switch (interval) {
    case "1m":  return 1;
    case "5m":  return 1;
    case "15m": return 1;
    case "1h":  return 7;
    case "4h":  return 30;
    case "1d":  return 90;
  }
}

async function fetchCoinGeckoOHLC(coinId: string, interval: Interval): Promise<Candle[]> {
  const days = intervalToDays(interval);
  const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coinId)}/ohlc?vs_currency=usd&days=${days}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko OHLC ${res.status}: ${coinId}`);
  const raw = await res.json() as [number, number, number, number, number][];

  // lightweight-charts requires strictly ascending, deduplicated timestamps
  const seen = new Set<number>();
  return raw
    .map(([ts, o, h, l, c]) => ({ time: Math.floor(ts / 1000), open: o, high: h, low: l, close: c, volume: 0 }))
    .sort((a, b) => a.time - b.time)
    .filter((c) => { if (seen.has(c.time)) return false; seen.add(c.time); return true; });
}

export function useCoinGeckoOHLC(asset: string | null, interval: Interval) {
  const coinId = asset ? (COINGECKO_COIN_IDS[asset.toUpperCase()] ?? null) : null;
  return useQuery({
    queryKey: ["coingecko", "ohlc", coinId, interval],
    queryFn:  () => fetchCoinGeckoOHLC(coinId!, interval),
    enabled:  coinId !== null,
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  });
}

/**
 * Subscribe to Binance's real-time kline WebSocket stream for a given asset
 * and interval. Fires `onCandle` on every tick, giving the chart live updates
 * without waiting for the REST poll interval.
 *
 * Automatically disabled for oracle-only (RWA) assets that have no Binance symbol.
 * Reconnects on disconnect with a 2-second backoff (max 8 attempts).
 */
export function useBinanceKlineStream(
  asset: string | null,
  interval: Interval,
  onCandle: (candle: Candle, isClosed: boolean) => void,
): void {
  const sym = asset ? toBinanceSymbol(asset) : null;

  useEffect(() => {
    if (!sym) return;

    const streamName = `${sym.toLowerCase()}@kline_${interval}`;
    const url = `wss://stream.binance.com:9443/ws/${streamName}`;

    let ws: WebSocket | null = null;
    let attempts = 0;
    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closed || attempts >= 8) return;
      attempts++;
      try {
        ws = new WebSocket(url);
        ws.onopen = () => { attempts = 0; };
        ws.onmessage = (ev: MessageEvent<string>) => {
          try {
            const msg = JSON.parse(ev.data) as BinanceKlineEvent;
            if (msg.e !== "kline") return;
            const k = msg.k;
            const candle: Candle = {
              time:   Math.floor(k.t / 1000),
              open:   parseFloat(k.o),
              high:   parseFloat(k.h),
              low:    parseFloat(k.l),
              close:  parseFloat(k.c),
              volume: parseFloat(k.v),
            };
            onCandle(candle, k.x);
          } catch { /* ignore malformed frames */ }
        };
        ws.onclose = () => {
          if (!closed) retryTimer = setTimeout(connect, 2_000);
        };
        ws.onerror = () => ws?.close();
      } catch {
        if (!closed) retryTimer = setTimeout(connect, 2_000);
      }
    };

    connect();

    return () => {
      closed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      ws?.close();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sym, interval]);
}
