/**
 * useLandingStats — real on-chain aggregates for the landing page stat ticker.
 *
 * Fetches:
 *   - market count + max leverage   → perpEngine.listMarkets()
 *   - total open interest (USD)     → perpEngine.getOpenInterest(id) per market
 *   - protocol TVL                  → vault.getTotalDeposits() + slpVault.totalAssets()
 *   - insurance fund                → risk.getInsuranceFundBalance()
 *
 * All values are 18-dec bigint on chain; converted to human numbers here.
 * Falls back to null while loading or if the RPC is unreachable.
 */

import { useQueries, useQuery } from "@tanstack/react-query";
import { getClients } from "@/stellar/clients";
import { config, hasContract } from "@/config";
import { qk } from "./queries";

const PRECISION = 10n ** 18n;

function fromFixed18(v: bigint): number {
  return Number(v) / Number(PRECISION);
}

/** 7-decimal Stellar/Soroban USDC → number. */
function fromFixed7(v: bigint): number {
  return Number(v) / 1e7;
}

export interface LandingStats {
  /** Number of active markets. */
  marketCount: number;
  /** Highest max-leverage across all markets. */
  maxLeverage: number;
  /**
   * Total notional open interest in USD (long + short across all markets).
   * Null while fetching or if unavailable.
   */
  totalOiUsd: number | null;
  /**
   * Protocol TVL: collateral vault deposits + SLP vault assets (USD).
   * Null while fetching.
   */
  tvlUsd: number | null;
  /** Insurance fund balance in USD. Null while fetching. */
  insuranceFundUsd: number | null;
  /** True while any of the main queries are still loading. */
  loading: boolean;
}

export function useLandingStats(): LandingStats {
  // ── Markets list ───────────────────────────────────────────────────────────
  const marketsQ = useQuery({
    queryKey: qk.markets(),
    queryFn: () => getClients().perpEngine.listMarkets(),
    staleTime: 60_000,
    retry: 1,
  });

  const markets = marketsQ.data ?? [];
  const activeMarkets = markets.filter((m) => m.isActive);

  // ── Per-market OI (parallel) ───────────────────────────────────────────────
  const oiQueries = useQueries({
    queries: activeMarkets.map((m) => ({
      queryKey: qk.openInterest(m.marketId),
      queryFn: () => getClients().perpEngine.getOpenInterest(m.marketId),
      staleTime: 10_000,
      retry: 1,
    })),
  });

  const totalOiUsd: number | null = (() => {
    if (activeMarkets.length === 0) return null;
    // Only compute once all OI queries have resolved
    if (oiQueries.some((q) => q.isPending)) return null;
    let sum = 0;
    for (const q of oiQueries) {
      if (q.data === undefined) return null;
      sum += fromFixed18(q.data.long + q.data.short);
    }
    return sum;
  })();

  // ── Vault TVL: collateral vault ────────────────────────────────────────────
  const vaultTotalQ = useQuery({
    queryKey: qk.vaultTotal(),
    queryFn: () => getClients().vault.getTotalDeposits(),
    enabled: hasContract(config.contracts.vault),
    staleTime: 30_000,
    retry: 1,
  });

  // ── SLP vault total assets ─────────────────────────────────────────────────
  const slpAssetsQ = useQuery({
    queryKey: qk.slpTotalAssets(),
    queryFn: () => getClients().slpVault.totalAssets(),
    enabled: hasContract(config.contracts.slpVault),
    staleTime: 30_000,
    retry: 1,
  });

  const tvlUsd: number | null = (() => {
    // Collateral vault uses 7-dec USDC; SLP vault uses 18-dec
    const collateral =
      vaultTotalQ.data !== undefined ? fromFixed7(vaultTotalQ.data) : null;
    const slp =
      slpAssetsQ.data !== undefined ? fromFixed18(slpAssetsQ.data) : 0;
    if (collateral === null) return null;
    return collateral + slp;
  })();

  // ── Insurance fund ─────────────────────────────────────────────────────────
  const insuranceQ = useQuery({
    queryKey: qk.insuranceFund(),
    queryFn: () => getClients().risk.getInsuranceFundBalance(),
    enabled: hasContract(config.contracts.risk),
    staleTime: 30_000,
    retry: 1,
  });

  const insuranceFundUsd: number | null =
    insuranceQ.data !== undefined ? fromFixed18(insuranceQ.data) : null;

  // ── Derived ────────────────────────────────────────────────────────────────
  const maxLeverage =
    activeMarkets.length > 0
      ? Math.max(...activeMarkets.map((m) => m.maxLeverage))
      : 20;

  const loading =
    marketsQ.isPending ||
    vaultTotalQ.isPending ||
    oiQueries.some((q) => q.isPending);

  return {
    marketCount: activeMarkets.length,
    maxLeverage,
    totalOiUsd,
    tvlUsd,
    insuranceFundUsd,
    loading,
  };
}
