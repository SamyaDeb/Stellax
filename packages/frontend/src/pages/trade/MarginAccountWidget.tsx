/**
 * MarginAccountWidget — compact read-only margin summary for the Trade page sidebar.
 *
 * Shows the user's current Total / Free / Locked balance at a glance.
 * Deposit and withdrawal are handled on the Portfolio page (/portfolio)
 * so this sidebar stays focused on trading, not fund management.
 */

import { useNavigate } from "react-router-dom";
import clsx from "clsx";
import { formatUsd } from "@/ui/format";
import {
  useVaultBalance,
  useAccountHealth,
} from "@/hooks/queries";

interface Props {
  address: string | null;
}

export function MarginAccountWidget({ address }: Props) {
  const navigate = useNavigate();

  const balanceQ = useVaultBalance(address);
  const healthQ  = useAccountHealth(address);

  const isLoading = balanceQ.isPending;
  const isError   = balanceQ.isError;

  const rawBalance = balanceQ.data?.free ?? 0n;
  const locked     = healthQ.data?.totalMarginRequired ?? 0n;
  const free       = rawBalance > locked ? rawBalance - locked : 0n;
  const total      = rawBalance;

  const fmtTotal  = isLoading ? "—" : isError ? "Err" : formatUsd(total);
  const fmtFree   = isLoading ? "—" : isError ? "Err" : formatUsd(free);
  const fmtLocked = isLoading ? "—" : isError ? "Err" : formatUsd(locked);

  return (
    <div className="terminal-card rounded-none">
      {/* Header */}
      <div className="flex items-center justify-between border-b terminal-divider px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-white">
          Margin
        </span>
        <button
          onClick={() => navigate("/portfolio")}
          className="text-[10px] text-stella-gold/70 hover:text-stella-gold transition-colors font-medium"
        >
          Fund Account →
        </button>
      </div>

      <div className="p-3 space-y-3">
        {/* Balance cells */}
        <div className="grid grid-cols-3 gap-2">
          <BalanceCell label="Total"  value={fmtTotal}  accent />
          <BalanceCell label="Free"   value={fmtFree}   tone="ok" />
          <BalanceCell label="Locked" value={fmtLocked} tone="warn" />
        </div>

        {isError && (
          <p className="text-[10px] text-stella-short">
            Could not load balance — check connection.
          </p>
        )}

        {/* CTA to Portfolio page */}
        <button
          onClick={() => navigate("/portfolio")}
          className="w-full rounded border border-stella-gold/20 bg-stella-gold/5 py-2 text-xs font-semibold text-stella-gold hover:bg-stella-gold/10 transition-colors"
        >
          Deposit · Withdraw · Earn Yield
        </button>
      </div>
    </div>
  );
}

function BalanceCell({
  label,
  value,
  tone,
  accent,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn";
  accent?: boolean;
}) {
  const color = tone === "ok"
    ? "text-stella-long"
    : tone === "warn"
      ? "text-stella-accent"
      : accent
        ? "text-stella-gold"
        : "text-white";
  return (
    <div className="rounded border border-white/5 bg-black/20 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-stella-muted mb-0.5">
        {label}
      </div>
      <div className={clsx("num text-xs font-semibold truncate", color)}>
        {value}
      </div>
    </div>
  );
}
