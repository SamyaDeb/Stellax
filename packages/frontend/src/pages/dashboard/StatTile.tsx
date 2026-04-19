import type { ReactNode } from "react";
import clsx from "clsx";
import { Card } from "@/ui/Card";

interface Props {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "default" | "ok" | "warn";
}

export function StatTile({ label, value, sub, tone = "default" }: Props) {
  return (
    <Card>
      <div className="space-y-1">
        <div className="text-xs uppercase tracking-wide text-stella-muted">
          {label}
        </div>
        <div
          className={clsx(
            "num text-2xl font-semibold",
            tone === "ok" && "text-stella-long",
            tone === "warn" && "text-stella-accent",
            tone === "default" && "text-white",
          )}
        >
          {value}
        </div>
        {sub !== undefined && (
          <div className="text-xs text-stella-muted">{sub}</div>
        )}
      </div>
    </Card>
  );
}
