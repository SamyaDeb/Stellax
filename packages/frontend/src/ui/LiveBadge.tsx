/**
 * Pulsing "LIVE" badge — confirms real-time data polling is active.
 * Uses the IsFetching state from TanStack Query.
 */
import { useIsFetching } from "@tanstack/react-query";
import clsx from "clsx";

export function LiveBadge() {
  const isFetching = useIsFetching();

  return (
    <div className="flex items-center gap-1.5">
      <span
        className={clsx(
          "inline-block h-2 w-2 rounded-full transition-colors",
          isFetching > 0
            ? "animate-pulse bg-stella-accent"
            : "bg-stella-long",
        )}
      />
      <span className="text-[10px] uppercase tracking-wider text-stella-muted">
        {isFetching > 0 ? "Syncing" : "Live"}
      </span>
    </div>
  );
}
