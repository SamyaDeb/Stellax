/**
 * PauseBanner — shown at the top of TradePage and VaultsPage whenever
 * either the perp-engine or the risk contract is paused on-chain.
 *
 * Polls `is_paused()` on both contracts every 30 s (using the same
 * `usePerpIsPaused` / `useRiskIsPaused` query hooks as the rest of the app).
 * Renders nothing when both contracts are live.
 */

import { usePerpIsPaused, useRiskIsPaused } from "@/hooks/queries";

export function PauseBanner() {
  const perp = usePerpIsPaused();
  const risk = useRiskIsPaused();

  const perpPaused = perp.data === true;
  const riskPaused = risk.data === true;

  if (!perpPaused && !riskPaused) return null;

  const who = perpPaused && riskPaused
    ? "Trading and liquidations are"
    : perpPaused
      ? "Trading is"
      : "Liquidations are";

  return (
    <div className="flex items-center gap-3 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-400">
      <span className="shrink-0 text-base">⚠</span>
      <span>
        <strong>{who} currently paused</strong> by the protocol guardian.
        Existing positions are safe; you cannot open new positions until
        trading is resumed. Follow{" "}
        <a
          href="https://twitter.com/StellaXFi"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:text-red-300"
        >
          @StellaXFi
        </a>{" "}
        for updates.
      </span>
    </div>
  );
}
