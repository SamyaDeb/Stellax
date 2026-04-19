import type { ReactNode } from "react";
import { Card } from "@/ui/Card";

export function PagePlaceholder({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-white">{title}</h1>
      <Card>
        <p className="text-sm text-stella-muted">
          {children ?? "Coming online — UI scaffolding in place, backend integration pending."}
        </p>
      </Card>
    </div>
  );
}
