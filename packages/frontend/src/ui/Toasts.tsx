import clsx from "clsx";
import { Link } from "react-router-dom";
import { useTxStore } from "@/wallet/tx-store";

const EXPLORER_BASE = "https://stellar.expert/explorer/testnet/tx";

export function Toasts() {
  const { entries, dismiss } = useTxStore();
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      {entries.map((e) => (
        <div
          key={e.id}
          className={clsx(
            "pointer-events-auto card p-3 text-sm shadow-lg",
            e.phase === "pending" && "border-stella-accent/60",
            e.phase === "success" && "border-stella-long/60",
            e.phase === "failed" && "border-stella-short/60",
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                {e.phase === "pending" && (
                  <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-stella-accent border-t-transparent" />
                )}
                {e.phase === "success" && (
                  <span className="text-stella-long text-xs">✓</span>
                )}
                {e.phase === "failed" && (
                  <span className="text-stella-short text-xs">✗</span>
                )}
                <div className="font-medium text-white">{e.label}</div>
              </div>
              <div className="mt-0.5 text-xs text-stella-muted">
                {e.phase === "pending" && "Signing and submitting…"}
                {e.phase === "success" && "Confirmed on-chain"}
                {e.phase === "failed" && (e.message ?? "Transaction failed")}
              </div>
              {e.hash !== undefined && (
                <a
                  href={`${EXPLORER_BASE}/${e.hash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="num mt-1 inline-block text-[10px] text-stella-accent/70 hover:text-stella-accent underline underline-offset-2"
                >
                  {e.hash.slice(0, 16)}… ↗
                </a>
              )}
              {e.action !== undefined && e.phase === "success" && (
                <Link
                  to={e.action.href}
                  className="mt-1.5 inline-flex items-center gap-0.5 text-[11px] font-medium text-stella-gold hover:text-stella-gold/80 underline underline-offset-2"
                >
                  {e.action.label}
                </Link>
              )}
            </div>
            <button
              onClick={() => dismiss(e.id)}
              className="text-stella-muted hover:text-white"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
