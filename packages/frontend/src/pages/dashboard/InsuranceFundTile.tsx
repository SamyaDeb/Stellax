import clsx from "clsx";
import { formatUsd } from "@/ui/format";
import { useInsuranceFund, useInsuranceTarget } from "@/hooks/queries";

/**
 * Phase P — Insurance Fund tile with auto-growth target progress.
 *
 * Shows the live insurance balance, a progress bar against the configured
 * soft/hard cap band, and a status badge:
 *
 *   • below 50 % of soft cap  → red "Under-funded" warning
 *   • below soft cap          → amber "Building"
 *   • soft ≤ bal < hard       → emerald "Auto-growth · half"
 *   • ≥ hard cap              → blue "Capped · routing to stakers"
 *
 * When no `InsuranceTarget` is configured, falls back to the simple
 * value-only tile so the legacy 60/20/20 split keeps rendering cleanly.
 */
export function InsuranceFundTile() {
  const balQ = useInsuranceFund();
  const tgtQ = useInsuranceTarget();
  const balance = balQ.data ?? 0n;
  const target = tgtQ.data ?? null;

  if (!target) {
    return (
      <div className="glass-card p-5">
        <div className="space-y-1">
          <div className="text-[11px] uppercase tracking-wider text-stella-muted">
            Insurance fund
          </div>
          <div className="num text-2xl font-semibold text-stella-long">
            {formatUsd(balance)}
          </div>
          <div className="text-xs text-stella-muted">
            Auto-growth target unset · legacy 60 / 20 / 20 split
          </div>
        </div>
      </div>
    );
  }

  const { softCap, hardCap } = target;
  const pctOfSoft = softCap > 0n ? Number((balance * 100n) / softCap) : 0;
  const pctOfHard = hardCap > 0n ? Number((balance * 100n) / hardCap) : 0;

  let badge: { label: string; className: string };
  if (balance < softCap / 2n) {
    badge = {
      label: "Under-funded",
      className:
        "bg-red-500/15 text-red-300 border border-red-500/30",
    };
  } else if (balance < softCap) {
    badge = {
      label: "Building",
      className:
        "bg-amber-500/15 text-amber-200 border border-amber-500/30",
    };
  } else if (balance < hardCap) {
    badge = {
      label: "Auto-growth · half-rate",
      className:
        "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30",
    };
  } else {
    badge = {
      label: "Capped · staker routing",
      className:
        "bg-sky-500/15 text-sky-300 border border-sky-500/30",
    };
  }

  // Bar fills proportionally to hard cap; soft-cap mark drawn at its position.
  const barFillPct = Math.min(100, pctOfHard);
  const softMarkPct = hardCap > 0n
    ? Math.min(100, Number((softCap * 100n) / hardCap))
    : 0;

  return (
    <div className="glass-card p-5">
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="text-[11px] uppercase tracking-wider text-stella-muted">
            Insurance fund
          </div>
          <span
            className={clsx(
              "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
              badge.className,
            )}
          >
            {badge.label}
          </span>
        </div>

        <div className="num text-2xl font-semibold text-stella-long">
          {formatUsd(balance)}
        </div>

        <div className="relative mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/5">
          <div
            className="absolute inset-y-0 left-0 bg-emerald-500/60"
            style={{ width: `${barFillPct}%` }}
          />
          <div
            className="absolute top-0 h-full w-px bg-stella-muted/60"
            style={{ left: `${softMarkPct}%` }}
            title="Soft cap"
          />
        </div>

        <div className="flex justify-between text-[10px] text-stella-muted">
          <span>{pctOfSoft}% of soft</span>
          <span>{pctOfHard}% of hard</span>
        </div>

        <div className="text-xs text-stella-muted">
          Soft {formatUsd(softCap)} · Hard {formatUsd(hardCap)}
        </div>
      </div>
    </div>
  );
}
