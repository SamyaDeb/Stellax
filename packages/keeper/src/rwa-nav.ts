/**
 * Tier 1 — Continuous multi-source RWA price aggregator.
 *
 * `DefaultRwaNavFetcher` fans out to every configured live source
 * (CoinGecko, CoinMarketCap, issuer NAV APIs, Franklin NAV) in parallel,
 * applies a median + deviation filter via `selectBestPrice`, and returns a
 * single `RwaNavSample` ready for `admin_push_price`. Static fallbacks are
 * consulted only when every live source fails.
 *
 * The 18-decimal fixed-point conversion matches `stellax-math::PriceData` so
 * the oracle contract stores RWA NAVs alongside RedStone-sourced prices.
 */

import { scVal, type StellarClient } from "./stellar.js";
import { getLogger } from "./logger.js";
import {
  COINGECKO_IDS,
  STATIC_FALLBACK_PRICES,
  fetchCoinGecko,
  fetchCoinMarketCap,
  fetchFranklinNav,
  fetchOndoNav,
  staticFallback,
  type RwaQuote,
} from "./sources/rwa-prices.js";

const PRECISION_18 = 10n ** 18n;
const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000; // 5 min
const DEFAULT_MAX_DEVIATION_BPS = 100; // 1%

function toFixed18(price: number): bigint {
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`invalid price ${price}`);
  }
  // 9-decimal intermediate avoids float drift; scale to 18 decimals.
  const intermediate = Math.round(price * 1e9);
  return BigInt(intermediate) * 10n ** 9n;
}

export interface RwaNavSample {
  feedId: string;
  /** 18-decimal fixed-point price. */
  price18: bigint;
  /** Issuer-published timestamp in milliseconds. */
  timestampMs: number;
  /** Source label for diagnostics — e.g. `"coingecko"`, `"median(3)"`. */
  source: string;
}

export interface RwaNavFetcher {
  fetch(feedId: string): Promise<RwaNavSample>;
}

export interface DefaultRwaNavFetcherOptions {
  /** CoinMarketCap pro API key — blank disables the source. */
  cmcApiKey?: string;
  /** Per-symbol issuer NAV URLs. */
  ondoNavUrl?: string; // USDY
  ousgNavUrl?: string; // OUSG
  benjiNavUrl?: string; // BENJI / FOBXX
  /** Optional secondary endpoint for BENJI. */
  defiLlamaFallback?: string;
  fetchImpl?: typeof fetch;
  /** Override CoinGecko id mapping (mostly for tests). */
  coingeckoIds?: Record<string, string>;
  /** Quotes older than this are dropped before median selection. */
  maxAgeMs?: number;
  /** Source quotes diverging from the median by more than this are rejected. */
  maxDeviationBps?: number;
}

/**
 * Median-plus-deviation selector for an array of quotes for a single symbol.
 *
 * 1. Drop quotes older than `maxAgeMs`.
 * 2. If 0 remain → null (caller decides whether to fall back).
 * 3. Sort by price, pick the middle element as the candidate median.
 * 4. Reject quotes whose price diverges by more than `maxDeviationBps` from
 *    that median.
 * 5. Recompute median across surviving quotes.
 */
export function selectBestPrice(
  quotes: readonly RwaQuote[],
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
  maxDeviationBps: number = DEFAULT_MAX_DEVIATION_BPS,
): { priceUsd: number; sources: RwaQuote[] } | null {
  const cutoff = Date.now() - maxAgeMs;
  const fresh = quotes.filter(
    (q) => q.ts >= cutoff && Number.isFinite(q.priceUsd) && q.priceUsd > 0,
  );
  if (fresh.length === 0) return null;
  if (fresh.length === 1) {
    return { priceUsd: fresh[0].priceUsd, sources: [fresh[0]] };
  }

  const median = (xs: number[]): number => {
    const sorted = [...xs].sort((a, b) => a - b);
    const m = sorted.length >> 1;
    return sorted.length % 2 === 0
      ? (sorted[m - 1] + sorted[m]) / 2
      : sorted[m];
  };

  const candidate = median(fresh.map((q) => q.priceUsd));
  const tolerance = (candidate * maxDeviationBps) / 10_000;
  const survivors = fresh.filter(
    (q) => Math.abs(q.priceUsd - candidate) <= tolerance,
  );
  if (survivors.length === 0) return null;
  return {
    priceUsd: median(survivors.map((q) => q.priceUsd)),
    sources: survivors,
  };
}

/**
 * Multi-source aggregator. Each `fetch(feedId)` triggers parallel calls to
 * every configured source and runs them through `selectBestPrice`.
 */
export class DefaultRwaNavFetcher implements RwaNavFetcher {
  private readonly cmcApiKey: string;
  private readonly ondoUrls: Record<string, string>;
  private readonly benjiUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly coingeckoIds: Record<string, string>;
  private readonly maxAgeMs: number;
  private readonly maxDeviationBps: number;
  private readonly log = getLogger("rwa-nav");

  constructor(opts: DefaultRwaNavFetcherOptions = {}) {
    this.cmcApiKey = opts.cmcApiKey ?? "";
    this.ondoUrls = {
      USDY: opts.ondoNavUrl ?? "",
      OUSG: opts.ousgNavUrl ?? "",
    };
    this.benjiUrl =
      opts.benjiNavUrl ??
      opts.defiLlamaFallback ??
      "";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.coingeckoIds = opts.coingeckoIds ?? COINGECKO_IDS;
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.maxDeviationBps = opts.maxDeviationBps ?? DEFAULT_MAX_DEVIATION_BPS;
  }

  /**
   * Run every configured source for the given symbol and return a single
   * sample. Throws only if **all** sources (live + static) fail to produce
   * a usable quote.
   */
  async fetch(feedId: string): Promise<RwaNavSample> {
    const symbol = feedId.toUpperCase();

    // Build per-symbol slices of source maps
    const geckoSlice: Record<string, string> = this.coingeckoIds[symbol]
      ? { [symbol]: this.coingeckoIds[symbol] }
      : {};
    const cmcSlice: Record<string, string> = { [symbol]: symbol };
    const ondoSlice: Record<string, string> = this.ondoUrls[symbol]
      ? { [symbol]: this.ondoUrls[symbol] }
      : {};

    const tasks: Promise<RwaQuote[]>[] = [];
    if (Object.keys(geckoSlice).length > 0) {
      tasks.push(fetchCoinGecko(geckoSlice, this.fetchImpl));
    }
    if (this.cmcApiKey) {
      tasks.push(fetchCoinMarketCap(cmcSlice, this.cmcApiKey, this.fetchImpl));
    }
    if (Object.keys(ondoSlice).length > 0) {
      tasks.push(fetchOndoNav(ondoSlice, this.fetchImpl));
    }
    if (symbol === "BENJI" && this.benjiUrl) {
      tasks.push(
        fetchFranklinNav(this.benjiUrl, this.fetchImpl).then((q) =>
          q ? [q] : [],
        ),
      );
    }

    const results = await Promise.all(tasks);
    const live: RwaQuote[] = results.flat();

    const selected = selectBestPrice(
      live,
      this.maxAgeMs,
      this.maxDeviationBps,
    );

    if (selected !== null) {
      const ts = Math.max(...selected.sources.map((q) => q.ts));
      const sourceLabel =
        selected.sources.length === 1
          ? selected.sources[0].source
          : `median(${selected.sources.map((q) => q.source).join(",")})`;
      this.log.debug(
        {
          feedId: symbol,
          priceUsd: selected.priceUsd,
          sources: selected.sources.map((q) => q.source),
        },
        "rwa price selected",
      );
      return {
        feedId: symbol,
        price18: toFixed18(selected.priceUsd),
        timestampMs: ts,
        source: sourceLabel,
      };
    }

    // Every live source failed — try static fallback for this symbol.
    const fallbackPrice = STATIC_FALLBACK_PRICES[symbol];
    if (typeof fallbackPrice === "number") {
      this.log.warn(
        { feedId: symbol, fallbackPrice, attemptedSources: live.length },
        "all live sources failed; using static fallback",
      );
      return {
        feedId: symbol,
        price18: toFixed18(fallbackPrice),
        timestampMs: Date.now(),
        source: "static",
      };
    }

    throw new Error(
      `no price available for ${symbol}: all live sources failed and no static fallback configured`,
    );
  }
}

/** Thin wrapper around `oracle.admin_push_price`. */
export async function pushRwaNavToOracle(args: {
  stellar: StellarClient;
  oracleContractId: string;
  sample: RwaNavSample;
}): Promise<string> {
  const { stellar, oracleContractId, sample } = args;
  // Use max(source_ts, now) so that stale/cached source timestamps (e.g.
  // CoinGecko's `last_updated_at`) never collide with the oracle's stored
  // monotonic timestamp.
  const oracleTimestampMs = Math.max(sample.timestampMs, Date.now());
  const res = await stellar.invoke(oracleContractId, "admin_push_price", [
    scVal.symbol(sample.feedId),
    scVal.i128(sample.price18),
    scVal.u64(BigInt(Math.floor(oracleTimestampMs))),
  ]);
  return res.hash;
}

/** Re-export so callers can build/test source maps without importing two files. */
export {
  COINGECKO_IDS,
  STATIC_FALLBACK_PRICES,
  staticFallback,
  type RwaQuote,
};

export const _internal = {
  toFixed18,
  PRECISION_18,
};
