/**
 * useSlpApr — derives an annualised return estimate from the in-memory
 * NAV-per-share history buffer produced by `useSlpNavHistory`.
 *
 * Formula:
 *   apr = ((navLast - navFirst) / navFirst)
 *         × (YEAR_MS / elapsed_ms)
 *         × 100          (percent)
 *
 * Returns `null` when:
 *   - Fewer than 2 distinct data points exist (page just loaded)
 *   - First and last timestamps are identical (< 1 poll cycle elapsed)
 *   - NAV history shows zero initial value (div-by-zero guard)
 *
 * Caveat: the buffer is in-memory only (resets on page reload). The APR
 * estimate becomes more representative as the session lengthens. Consumers
 * should show "—" when the return value is `null`.
 */

import { useSlpNavHistory } from "./useSlpNavHistory";

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Returns the estimated annualised return (e.g. `12.5` means 12.5% APR),
 * or `null` if there is not yet enough data to compute a meaningful estimate.
 */
export function useSlpApr(): number | null {
  const history = useSlpNavHistory();

  if (history.length < 2) return null;

  const first = history[0];
  const last  = history[history.length - 1];

  // Guard: noUncheckedIndexedAccess — history[0] / history[last] may be undefined
  if (first === undefined || last === undefined) return null;
  if (first.nav <= 0n) return null;

  const elapsed = last.timestamp - first.timestamp;
  if (elapsed <= 0) return null;

  // Work in floating-point; precision loss is fine for a UI estimate.
  const navFirst = Number(first.nav);
  const navLast  = Number(last.nav);

  const periodReturn = (navLast - navFirst) / navFirst;
  const apr = periodReturn * (YEAR_MS / elapsed) * 100;

  // Clamp to a sane display range (−999% … +9999%).
  return Math.max(-999, Math.min(9999, apr));
}
