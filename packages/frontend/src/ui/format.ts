/**
 * Number formatting helpers. Consistent across the app.
 * All on-chain values are i128 or u128 encoded with PRECISION = 10^18.
 */

import { PRECISION, BPS_DENOMINATOR } from "@stellax/sdk";

/** Convert i128 nanoUSD-style (10^18) to floating USD, precision-limited. */
export function fromFixed(v: bigint, decimals = 18): number {
  const sign = v < 0n ? -1 : 1;
  const abs = v < 0n ? -v : v;
  const denom = 10n ** BigInt(decimals);
  const intPart = abs / denom;
  const fracPart = abs % denom;
  // Limit float precision; beyond 1e15 USD we lose digits but that's fine for UI.
  return sign * (Number(intPart) + Number(fracPart) / Number(denom));
}

/** Convert human number → fixed i128 with PRECISION. */
export function toFixed(n: number | string, decimals = 18): bigint {
  const s = typeof n === "number" ? n.toString() : n;
  if (s.trim() === "" || Number.isNaN(Number(s))) return 0n;
  const [whole, frac = ""] = s.split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const sign = s.trim().startsWith("-") ? -1n : 1n;
  const abs = BigInt((whole ?? "0").replace("-", "") || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
  return sign * abs;
}

export function formatUsd(v: bigint | number, opts: { decimals?: number } = {}): string {
  const n = typeof v === "bigint" ? fromFixed(v) : v;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: opts.decimals ?? 2,
  }).format(n);
}

export function formatNumber(v: bigint | number, decimals = 4): string {
  const n = typeof v === "bigint" ? fromFixed(v) : v;
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: decimals,
    minimumFractionDigits: Math.min(2, decimals),
  }).format(n);
}

export function formatPct(v: bigint | number, decimals = 2): string {
  // If given bigint, interpret as bps (10_000 = 100%); else as fraction.
  const n =
    typeof v === "bigint" ? Number(v) / Number(BPS_DENOMINATOR) : v;
  return `${(n * 100).toFixed(decimals)}%`;
}

export function shortAddress(addr: string): string {
  if (addr.length < 10) return addr;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

export { PRECISION };
