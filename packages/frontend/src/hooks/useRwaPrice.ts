/**
 * useRwaPrice — composite RWA NAV price hook.
 *
 * Priority:
 *   1. Pyth Hermes  — sub-second, includes signed VAA for on-chain submission
 *   2. Pyth Lazer   — real-time NAV price (no VAA); needs VITE_PYTH_LAZER_TOKEN
 *   3. On-chain oracle (usePrice) — 5s poll, depends on keeper being live
 *   4. Indexer ticker (useRwaTicker) — derived from oracle candle history
 *
 * The hook never throws. Any unavailable source is silently skipped.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePrice } from "@/hooks/queries";
import { useRwaTicker } from "@/hooks/useBinanceOHLC";
import { fetchPythRwaData, fetchPythLazerData, PYTH_RWA_FEED_IDS, PYTH_LAZER_SYMBOLS } from "@/pyth";
import { fromFixed } from "@/ui/format";
import { config } from "@/config";

const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 min

export interface RwaPriceResult {
  price: number | undefined;
  price18: bigint | undefined;
  pythVaa: Uint8Array | undefined;
  source: "pyth" | "lazer" | "oracle" | "indexer" | undefined;
  ageMs: number | undefined;
  isStale: boolean;
}

export function useRwaPrice(asset: string | null): RwaPriceResult {
  const assetUpper = asset?.toUpperCase() ?? null;
  const hasPythFeed   = assetUpper !== null && PYTH_RWA_FEED_IDS[assetUpper] !== undefined;
  const hasLazerFeed  = assetUpper !== null && PYTH_LAZER_SYMBOLS[assetUpper] !== undefined;
  const lazerToken    = config.pyth.lazerToken;

  // 1. Pyth Hermes — price + VAA for on-chain trading
  const pythQuery = useQuery({
    queryKey: ["pyth-rwa", asset],
    queryFn: () => fetchPythRwaData(asset!),
    enabled: hasPythFeed,
    refetchInterval: 5_000,
    staleTime: 3_000,
    retry: 1,
  });

  // 2. Pyth Lazer — price only (no VAA), requires bearer token
  const lazerQuery = useQuery({
    queryKey: ["pyth-lazer", asset],
    queryFn: () => fetchPythLazerData(asset!, lazerToken),
    enabled: hasLazerFeed && lazerToken.length > 0 && !pythQuery.data,
    refetchInterval: 5_000,
    staleTime: 3_000,
    retry: 1,
  });

  // 3. On-chain oracle (5s poll via queries.ts)
  const oracleQuery = usePrice(asset);

  // 4. Indexer 24h ticker
  const tickerQuery = useRwaTicker(asset);

  return useMemo((): RwaPriceResult => {
    const now = Date.now();

    // ── Source 1: Pyth Hermes (has VAA) ─────────────────────────────────
    if (pythQuery.data) {
      const d = pythQuery.data;
      const ageMs = now - d.publishTime * 1000;
      return {
        price: d.price,
        price18: d.price18,
        pythVaa: d.vaa,
        source: "pyth",
        ageMs,
        isStale: ageMs > STALE_THRESHOLD_MS,
      };
    }

    // ── Source 2: Pyth Lazer (price display only, no VAA) ───────────────
    if (lazerQuery.data) {
      const d = lazerQuery.data;
      const ageMs = now - d.publishTime * 1000;
      return {
        price: d.price,
        price18: d.price18,
        pythVaa: undefined,
        source: "lazer",
        ageMs,
        isStale: ageMs > STALE_THRESHOLD_MS,
      };
    }

    // ── Source 3: on-chain oracle ────────────────────────────────────────
    if (oracleQuery.data?.price !== undefined && oracleQuery.data.price > 0n) {
      const p = oracleQuery.data;
      const ageMs = typeof p.writeTimestamp === "bigint"
        ? now - Number(p.writeTimestamp) * 1000
        : undefined;
      return {
        price: fromFixed(p.price),
        price18: p.price,
        pythVaa: undefined,
        source: "oracle",
        ageMs,
        isStale: ageMs !== undefined && ageMs > STALE_THRESHOLD_MS,
      };
    }

    // ── Source 4: indexer ticker ─────────────────────────────────────────
    if (tickerQuery.data?.lastPrice !== undefined) {
      const p = tickerQuery.data.lastPrice;
      const price18 = BigInt(Math.round(p * 1e18));
      return {
        price: p,
        price18,
        pythVaa: undefined,
        source: "indexer",
        ageMs: undefined,
        isStale: false,
      };
    }

    // ── No data ──────────────────────────────────────────────────────────
    return { price: undefined, price18: undefined, pythVaa: undefined, source: undefined, ageMs: undefined, isStale: false };
  }, [pythQuery.data, lazerQuery.data, oracleQuery.data, tickerQuery.data]);
}
