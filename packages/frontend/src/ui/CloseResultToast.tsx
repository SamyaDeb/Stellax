/**
 * CloseResultToast — top-right 6-second overlay that appears after a
 * position close is confirmed on-chain.  It reads from the session store
 * so any component that calls `recordClose()` will trigger it automatically.
 *
 * Supports two variants:
 *   "user"        — voluntary close; shows Profit / Loss badge + PnL grid.
 *   "liquidation" — keeper-triggered; always red with a Liquidated badge.
 */

import { useEffect, useRef, useState } from "react";
import { useSessionStore, type ClosedTrade } from "@/stores/sessionStore";
import { formatUsd } from "@/ui/format";

const EXPLORER_BASE = "https://stellar.expert/explorer/testnet/tx";
const TOAST_DURATION_MS = 6_000;

export function CloseResultToast() {
  const closedTrades = useSessionStore((s) => s.closedTrades);
  const [visible, setVisible] = useState(false);
  const [current, setCurrent] = useState<ClosedTrade | null>(null);
  const lastIdRef = useRef<bigint | null>(null);

  useEffect(() => {
    const newest = closedTrades[0];
    if (newest === undefined) return;
    // Skip if we already toasted this trade
    if (lastIdRef.current === newest.positionId) return;
    lastIdRef.current = newest.positionId;
    setCurrent(newest);
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [closedTrades]);

  if (!visible || current === null) return null;

  const isLiquidation = current.kind === "liquidation";
  const isProfit = !isLiquidation && current.netPnl >= 0n;
  const pnlSign = current.netPnl >= 0n ? "+" : "";

  // Border and accent colour
  const accentRgb = isLiquidation || !isProfit
    ? "rgb(var(--stella-short-rgb, 248 113 113) / 0.6)"
    : "rgb(var(--stella-long-rgb, 74 222 128) / 0.6)";

  return (
    <div
      className="pointer-events-auto fixed top-4 right-4 z-50 w-72 card p-3 text-sm shadow-lg"
      style={{ borderColor: accentRgb }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {/* Header */}
          <div className="flex items-center gap-2">
            {isLiquidation ? (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide bg-stella-short/20 text-stella-short">
                Liquidated
              </span>
            ) : (
              <span
                className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide ${
                  isProfit
                    ? "bg-stella-long/20 text-stella-long"
                    : "bg-stella-short/20 text-stella-short"
                }`}
              >
                {isProfit ? "Profit" : "Loss"}
              </span>
            )}
            <span className="font-medium text-white">
              {isLiquidation ? "Position Liquidated" : "Position Closed"}
            </span>
          </div>

          {/* Net PnL / remaining margin */}
          <div
            className={`num mt-1.5 text-base font-semibold ${
              current.netPnl >= 0n ? "text-stella-long" : "text-stella-short"
            }`}
          >
            {pnlSign}
            {formatUsd(current.netPnl)}
            {isLiquidation && (
              <span className="ml-1 text-[10px] font-normal opacity-70">
                returned
              </span>
            )}
          </div>

          {/* Detail grid */}
          <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] text-stella-muted">
            <span>
              Entry:{" "}
              <span className="num text-white">{formatUsd(current.entryPrice)}</span>
            </span>
            <span>
              Exit:{" "}
              <span className="num text-white">{formatUsd(current.exitPrice)}</span>
            </span>
            <span className="col-span-2">
              {isLiquidation ? "Keeper reward:" : "Fee:"}{" "}
              <span className="num">{formatUsd(current.closeFee)}</span>
            </span>
          </div>

          {/* Tx link */}
          <a
            href={`${EXPLORER_BASE}/${current.txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="num mt-1.5 inline-block text-[10px] text-stella-accent/70 hover:text-stella-accent underline underline-offset-2"
          >
            {current.txHash.slice(0, 16)}… ↗
          </a>
        </div>

        {/* Dismiss */}
        <button
          onClick={() => setVisible(false)}
          className="shrink-0 text-stella-muted hover:text-white"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
}
