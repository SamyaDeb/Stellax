/**
 * useDexPrice — fetch the SLP token DEX price from Horizon's order_book endpoint.
 *
 * Returns:
 *   • `bigint` (18-decimal USDC per SLP) — best bid price when a market exists
 *   • `null` — token not configured, not listed, or no bids available (not an error)
 *
 * Config: set `VITE_SLP_TOKEN_CODE` + `VITE_SLP_TOKEN_ISSUER` to enable.
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { config } from "@/config";

const PRECISION = 10n ** 18n;

/** Convert a Horizon price string (e.g. "1.0250000") to 18-decimal bigint. */
function horizonPriceToBigint(price: string): bigint {
  const f = parseFloat(price);
  if (!isFinite(f) || f <= 0) return 0n;
  // Scale to 18 decimals — use integer arithmetic to avoid float drift.
  return BigInt(Math.round(f * 1e9)) * (PRECISION / 10n ** 9n);
}

export function useDexPrice(): UseQueryResult<bigint | null> {
  const { slpTokenCode, slpTokenIssuer, usdcIssuer } = config.contracts;
  const { horizonUrl } = config.network;
  const enabled = slpTokenCode.length > 0 && slpTokenIssuer.length > 0;

  return useQuery({
    queryKey: ["slp-dex-price", slpTokenCode, slpTokenIssuer],
    queryFn: async (): Promise<bigint | null> => {
      // Determine asset type based on code length
      const slpType =
        slpTokenCode.length <= 4 ? "credit_alphanum4" : "credit_alphanum12";

      const params = new URLSearchParams({
        selling_asset_type: slpType,
        selling_asset_code: slpTokenCode,
        selling_asset_issuer: slpTokenIssuer,
        buying_asset_type: "credit_alphanum4",
        buying_asset_code: "USDC",
        buying_asset_issuer: usdcIssuer,
        limit: "1",
      });

      const res = await fetch(`${horizonUrl}/order_book?${params.toString()}`);
      if (!res.ok) return null;

      const data = (await res.json()) as {
        bids?: { price: string; amount: string }[];
        asks?: { price: string; amount: string }[];
      };

      const bids = data.bids ?? [];
      if (bids.length === 0) return null;

      const first = bids[0];
      if (!first) return null;
      return horizonPriceToBigint(first.price);
    },
    enabled,
    refetchInterval: 30_000,
    retry: false,
    // A missing DEX listing is not an error — return null without surfacing in UI.
    throwOnError: false,
  });
}
