/**
 * VaultStatsHeader — SLP vault summary bar shown at the top of the Vaults page.
 *
 * Three columns (yield-only framing; collateral / margin excluded):
 *   • Yield TVL    — SLP total assets
 *   • NAV / Share  — SLP intrinsic price (18-decimal)
 *   • DEX Price    — Stellar DEX best bid (or "Not listed" badge)
 *   • Est. APR     — annualised return derived from in-session NAV history
 */

import clsx from "clsx";
import {
  useSlpTotalAssets,
  useSlpNavPerShare,
} from "@/hooks/queries";
import { useDexPrice } from "@/hooks/useDexPrice";
import { useSlpApr } from "@/hooks/useSlpApr";
import { formatUsd, fromFixed } from "@/ui/format";
import { config } from "@/config";

interface StatProps {
  label: string;
  value: string;
  sub?: string;
  tone?: "ok" | "warn" | "muted";
  badge?: React.ReactNode;
}

function Stat({ label, value, sub, tone, badge }: StatProps) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-[11px] uppercase tracking-wider text-stella-muted font-medium truncate">
        {label}
      </span>
      <div className="flex items-center gap-2">
        <span
          className={clsx(
            "text-xl font-semibold num truncate",
            tone === "ok"   && "text-stella-long",
            tone === "warn" && "text-stella-accent",
            tone === "muted"&& "text-stella-muted",
            !tone           && "text-white",
          )}
        >
          {value}
        </span>
        {badge}
      </div>
      {sub && (
        <span className="text-[11px] text-stella-muted truncate">{sub}</span>
      )}
    </div>
  );
}

export function VaultStatsHeader() {
  const slpAssetsQ = useSlpTotalAssets();
  const slpNavQ    = useSlpNavPerShare();
  const dexPriceQ  = useDexPrice();
  const apr        = useSlpApr();

  const slpEnabled = config.contracts.slpVault.length > 0;

  // ── Yield TVL ──────────────────────────────────────────────────────────────
  const slpAssets = slpAssetsQ.data ?? 0n;

  // ── NAV / Share ────────────────────────────────────────────────────────────
  const slpNav    = slpNavQ.data;
  const fmtNav    = slpNav !== undefined ? `$${fromFixed(slpNav).toFixed(6)}` : "—";

  // ── DEX price ──────────────────────────────────────────────────────────────
  const dexPrice  = dexPriceQ.data;
  let fmtDex = "—";
  if (slpEnabled && dexPriceQ.isLoading) {
    fmtDex = "…";
  } else if (dexPrice !== null && dexPrice !== undefined && dexPrice > 0n) {
    fmtDex = `$${fromFixed(dexPrice).toFixed(6)}`;
  }

  const dexListed = slpEnabled && dexPrice !== null && dexPrice !== undefined && dexPrice > 0n;

  // NAV vs DEX premium / discount badge
  let premiumNode: React.ReactNode = null;
  if (dexListed && slpNav !== undefined && slpNav > 0n) {
    const diff = dexPrice - slpNav;
    const pct  = Number(diff * 10000n / slpNav) / 100;
    const sign = pct >= 0 ? "+" : "";
    premiumNode = (
      <span
        className={clsx(
          "text-[11px] font-semibold px-1.5 py-0.5 rounded",
          pct >= 0
            ? "bg-stella-long/10 text-stella-long"
            : "bg-stella-short/10 text-stella-short",
        )}
      >
        {sign}{pct.toFixed(2)}%
      </span>
    );
  }

  // ── Est. APR ───────────────────────────────────────────────────────────────
  const fmtApr = apr !== null
    ? `${apr >= 0 ? "+" : ""}${apr.toFixed(2)}%`
    : "—";
  const aprTone = apr === null
    ? ("muted" as const)
    : apr >= 0
      ? ("ok" as const)
      : ("warn" as const);
  const aprSub  = apr !== null ? "annualised · session est." : "accumulating…";

  return (
    <div className="glass-card px-6 py-5">
      <div className="grid grid-cols-2 gap-y-5 gap-x-6 sm:grid-cols-2 lg:grid-cols-4">
        {/* 1 — Yield TVL */}
        <Stat
          label="Yield TVL"
          value={slpAssetsQ.isLoading ? "—" : formatUsd(slpAssets)}
          sub="SLP vault"
          {...(!slpEnabled ? { tone: "muted" as const } : {})}
        />

        {/* 2 — NAV / Share */}
        <Stat
          label="NAV / Share"
          value={slpEnabled ? fmtNav : "—"}
          sub={slpEnabled ? "intrinsic value" : "not deployed"}
          {...(!slpEnabled ? { tone: "muted" as const } : {})}
        />

        {/* 3 — DEX Price */}
        <Stat
          label="DEX Price"
          value={fmtDex}
          {...(slpEnabled && !dexListed
            ? {
                badge: (
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border border-stella-muted/30 text-stella-muted uppercase tracking-wider">
                    Not listed
                  </span>
                ),
                tone: "muted" as const,
              }
            : premiumNode
              ? { badge: premiumNode }
              : {}
          )}
          {...(dexListed ? { sub: "Stellar DEX best bid" } : {})}
        />

        {/* 4 — Est. APR */}
        <Stat
          label="Est. APR"
          value={slpEnabled ? fmtApr : "—"}
          sub={slpEnabled ? aprSub : "not deployed"}
          tone={slpEnabled ? aprTone : "muted"}
        />
      </div>
    </div>
  );
}
