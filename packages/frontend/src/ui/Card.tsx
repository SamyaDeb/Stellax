import clsx from "clsx";
import type { HTMLAttributes, ReactNode } from "react";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  padded?: boolean;
}

export function Card({ children, padded = true, className, ...rest }: CardProps) {
  return (
    <div {...rest} className={clsx("card", padded && "p-4", className)}>
      {children}
    </div>
  );
}

export function CardHeader({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={clsx(
        "flex items-center justify-between border-b border-stella-gold/10 px-5 py-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-sm font-semibold text-white">{children}</h3>;
}
