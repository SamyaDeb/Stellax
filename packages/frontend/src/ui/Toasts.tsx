import clsx from "clsx";
import { useTxStore } from "@/wallet/tx-store";

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
              <div className="font-medium text-white">{e.label}</div>
              <div className="mt-0.5 text-xs text-stella-muted">
                {e.phase === "pending" && "Signing and submitting…"}
                {e.phase === "success" && "Confirmed"}
                {e.phase === "failed" && (e.message ?? "Transaction failed")}
              </div>
              {e.hash !== undefined && (
                <div className="num mt-1 text-[10px] text-stella-muted">
                  {e.hash.slice(0, 16)}…
                </div>
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
