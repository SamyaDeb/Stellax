/**
 * Tier 1 — Multi-source RWA price fetchers.
 *
 * Each fetcher returns 0..N `RwaQuote` objects and **never throws**: any HTTP,
 * parse, or validation failure is logged and yields an empty result. The
 * higher-level `selectBestPrice` (in `../rwa-nav.ts`) is responsible for
 * picking a median across whatever sources returned successfully.
 *
 * Source-to-symbol mapping is hardcoded to the canonical IDs published by
 * each provider; only the API key / base URL is environment-driven.
 */

import { getLogger } from "../logger.js";

const log = getLogger("rwa-prices");

const FETCH_TIMEOUT_MS = 5_000;
const MAX_QUOTE_AGE_MS = 6 * 60 * 60 * 1000; // 6h — drop ancient publishes outright

export interface RwaQuote {
  symbol: string; // "BENJI" | "USDY" | "OUSG"
  priceUsd: number; // plain float, e.g. 1.12
  ts: number; // Unix ms when the source published this
  source: string; // "coingecko" | "coinmarketcap" | "ondo-nav" | "franklin-nav" | "static"
}

/** Hardcoded CoinGecko IDs for the supported RWA symbols. */
export const COINGECKO_IDS: Record<string, string> = {
  USDY: "ondo-us-dollar-yield",
  OUSG: "ondo-short-term-us-government-bond-fund",
  BENJI: "franklin-onchain-u-s-government-money-fund",
};

/** Static fallback NAVs — last-resort when every live source fails. */
export const STATIC_FALLBACK_PRICES: Record<string, number> = {
  BENJI: 1.053,
  USDY: 1.12,
  OUSG: 101.5,
  USDC: 1.00,
};

function isValidQuote(q: { priceUsd: number; ts: number }): boolean {
  return (
    Number.isFinite(q.priceUsd) &&
    q.priceUsd > 0 &&
    q.ts > Date.now() - MAX_QUOTE_AGE_MS &&
    q.ts <= Date.now() + 60_000 // reject obvious clock skew
  );
}

async function timedFetch(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const ctrl = new AbortController();
  const handle = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(handle);
  }
}

/**
 * CoinGecko `/simple/price` returns a JSON map keyed by gecko id, e.g.:
 *   { "ondo-us-dollar-yield": { "usd": 1.12, "last_updated_at": 1746012345 } }
 */
export async function fetchCoinGecko(
  idMap: Record<string, string> = COINGECKO_IDS,
  fetchImpl: typeof fetch = fetch,
): Promise<RwaQuote[]> {
  const ids = Object.values(idMap);
  if (ids.length === 0) return [];
  const url =
    `https://api.coingecko.com/api/v3/simple/price` +
    `?ids=${encodeURIComponent(ids.join(","))}` +
    `&vs_currencies=usd&include_last_updated_at=true`;
  try {
    const r = await timedFetch(
      url,
      { method: "GET", headers: { accept: "application/json" } },
      fetchImpl,
    );
    if (!r.ok) {
      log.warn({ status: r.status }, "coingecko non-2xx");
      return [];
    }
    const body = (await r.json()) as Record<
      string,
      { usd?: number; last_updated_at?: number }
    >;
    const out: RwaQuote[] = [];
    for (const [symbol, geckoId] of Object.entries(idMap)) {
      const entry = body[geckoId];
      if (!entry || typeof entry.usd !== "number") continue;
      const ts = (entry.last_updated_at ?? Math.floor(Date.now() / 1000)) * 1000;
      const q: RwaQuote = {
        symbol: symbol.toUpperCase(),
        priceUsd: entry.usd,
        ts,
        source: "coingecko",
      };
      if (isValidQuote(q)) out.push(q);
    }
    return out;
  } catch (err) {
    log.warn({ err: (err as Error).message }, "coingecko fetch failed");
    return [];
  }
}

/**
 * CoinMarketCap `/v2/cryptocurrency/quotes/latest?symbol=USDY,OUSG`. Skipped
 * when no API key is configured.
 */
export async function fetchCoinMarketCap(
  symbolMap: Record<string, string>,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RwaQuote[]> {
  if (!apiKey) return [];
  const symbols = Object.values(symbolMap);
  if (symbols.length === 0) return [];
  const url =
    `https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest` +
    `?symbol=${encodeURIComponent(symbols.join(","))}&convert=USD`;
  try {
    const r = await timedFetch(
      url,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          "X-CMC_PRO_API_KEY": apiKey,
        },
      },
      fetchImpl,
    );
    if (!r.ok) {
      log.warn({ status: r.status }, "coinmarketcap non-2xx");
      return [];
    }
    const body = (await r.json()) as {
      data?: Record<
        string,
        Array<{ quote?: { USD?: { price?: number; last_updated?: string } } }>
      >;
    };
    const out: RwaQuote[] = [];
    for (const [symbol, cmcSymbol] of Object.entries(symbolMap)) {
      const arr = body.data?.[cmcSymbol];
      const entry = Array.isArray(arr) ? arr[0] : undefined;
      const price = entry?.quote?.USD?.price;
      const ts = entry?.quote?.USD?.last_updated
        ? Date.parse(entry.quote.USD.last_updated)
        : Date.now();
      if (typeof price !== "number") continue;
      const q: RwaQuote = {
        symbol: symbol.toUpperCase(),
        priceUsd: price,
        ts: Number.isFinite(ts) ? ts : Date.now(),
        source: "coinmarketcap",
      };
      if (isValidQuote(q)) out.push(q);
    }
    return out;
  } catch (err) {
    log.warn({ err: (err as Error).message }, "coinmarketcap fetch failed");
    return [];
  }
}

const NAV_PRICE_KEYS = ["nav", "price", "navPrice", "nav_price", "navPerShare"];
const NAV_TS_KEYS = ["ts", "timestamp", "asOf", "as_of", "navDate"];

function pickNumber(value: unknown, keys: readonly string[]): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const n = Number(value.replace(/[$,]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (value !== null && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    for (const k of keys) {
      if (k in rec) {
        const n = pickNumber(rec[k], keys);
        if (n !== null) return n;
      }
    }
    for (const v of Object.values(rec)) {
      const n = pickNumber(v, keys);
      if (n !== null) return n;
    }
  }
  return null;
}

function pickTs(value: unknown): number | null {
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value > 10_000_000_000 ? Math.floor(value) : Math.floor(value * 1000);
  }
  if (value !== null && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    for (const k of NAV_TS_KEYS) {
      if (k in rec) {
        const t = pickTs(rec[k]);
        if (t !== null) return t;
      }
    }
    for (const v of Object.values(rec)) {
      const t = pickTs(v);
      if (t !== null) return t;
    }
  }
  return null;
}

/**
 * Generic issuer NAV fetcher used for Ondo USDY/OUSG endpoints.
 */
export async function fetchOndoNav(
  urlMap: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<RwaQuote[]> {
  const out: RwaQuote[] = [];
  for (const [symbol, url] of Object.entries(urlMap)) {
    if (!url) continue;
    try {
      const r = await timedFetch(
        url,
        {
          method: "GET",
          headers: { accept: "application/json", "cache-control": "no-cache" },
        },
        fetchImpl,
      );
      if (!r.ok) {
        log.warn({ symbol, status: r.status }, "ondo NAV non-2xx");
        continue;
      }
      const body = (await r.json()) as unknown;
      const price = pickNumber(body, NAV_PRICE_KEYS);
      const ts = pickTs(body) ?? Date.now();
      if (price === null) continue;
      const q: RwaQuote = {
        symbol: symbol.toUpperCase(),
        priceUsd: price,
        ts,
        source: "ondo-nav",
      };
      if (isValidQuote(q)) out.push(q);
    } catch (err) {
      log.warn(
        { err: (err as Error).message, symbol, url },
        "ondo NAV fetch failed",
      );
    }
  }
  return out;
}

/**
 * Franklin Templeton NAV fetcher for BENJI / FOBXX. Endpoint may return
 * JSON or HTML — we tolerate both shapes via `pickNumber`.
 */
export async function fetchFranklinNav(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RwaQuote | null> {
  if (!url) return null;
  try {
    const r = await timedFetch(
      url,
      {
        method: "GET",
        headers: {
          accept: "application/json,text/html;q=0.5",
          "cache-control": "no-cache",
        },
      },
      fetchImpl,
    );
    if (!r.ok) {
      log.warn({ status: r.status }, "franklin NAV non-2xx");
      return null;
    }
    const text = await r.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // leave as text; pickNumber falls through
    }
    const price = pickNumber(body, NAV_PRICE_KEYS);
    const ts = pickTs(body) ?? Date.now();
    if (price === null) return null;
    const q: RwaQuote = {
      symbol: "BENJI",
      priceUsd: price,
      ts,
      source: "franklin-nav",
    };
    return isValidQuote(q) ? q : null;
  } catch (err) {
    log.warn({ err: (err as Error).message }, "franklin NAV fetch failed");
    return null;
  }
}

/**
 * Static fallback quotes (stamped at "now") — only consulted when every live
 * source has failed. Caller controls which symbols receive a fallback.
 */
export function staticFallback(
  priceMap: Record<string, number> = STATIC_FALLBACK_PRICES,
): RwaQuote[] {
  const now = Date.now();
  return Object.entries(priceMap).map(([symbol, priceUsd]) => ({
    symbol: symbol.toUpperCase(),
    priceUsd,
    ts: now,
    source: "static",
  }));
}
