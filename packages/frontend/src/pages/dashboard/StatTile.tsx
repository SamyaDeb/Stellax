import type { ReactNode } from "react";
import clsx from "clsx";

interface Props {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "default" | "ok" | "warn";
}

export function StatTile({ label, value, sub, tone = "default" }: Props) {
  return (
    <div className="glass-card p-5">
      <div className="space-y-1">
        <div className="text-[11px] uppercase tracking-wider text-stella-muted">
          {label}
        </div>
        <div
          className={clsx(
            "num text-2xl font-semibold",
            tone === "ok" && "text-stella-long",
            tone === "warn" && "text-stella-accent",
            tone === "default" && "text-stella-gold",
          )}
        >
          {value}
        </div>
        {sub !== undefined && (
          <div className="text-xs text-stella-muted">{sub}</div>
        )}
      </div>
    </div>
  );
}
