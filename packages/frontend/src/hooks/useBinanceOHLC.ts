/**
 * Hooks for fetching live market data from Binance's public REST API.
 * No API key required. Used for:
 *   – useBinanceOHLC   : historical OHLCV candlestick data for the price chart
 *   – useBinanceTicker : 24-h price-change percentages for the price ticker bar
 */

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
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: 2,
  });
}
