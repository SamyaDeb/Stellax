/**
 * AccountSummary — shows the connected user's **portfolio-margin** health
 * snapshot, computed across perps + options by `risk.getPortfolioHealth`.
 *
 * Falls back to legacy per-contract AccountHealth fields if the portfolio
 * query is unavailable (e.g. risk contract upgrade not yet applied).
 *
 * Fields surfaced:
 *   - Total collateral    (vault equity + unrealized PnL)
 *   - Portfolio margin    (SPAN-style requirement; V2 cross-margining)
 *   - Free collateral     (= total − margin)
 *   - Net Δ USD           (portfolio delta vs. underlying in USD)
 *   - Margin savings %    (1 − portfolioMargin / sumIsolatedMargin), if deducible
 */

import { Link } from "react-router-dom";
import { Card, CardHeader, CardTitle } from "@/ui/Card";
import { formatUsd, shortAddress } from "@/ui/format";
import {
  useMaintenanceMargin,
  usePortfolioHealth,
  useVaultBalance,
} from "@/hooks/queries";

interface Props {
  address: string | null;
}

export function AccountSummary({ address }: Props) {
  const vault = useVaultBalance(address);
  const health = usePortfolioHealth(address);
  const isolatedMaint = useMaintenanceMargin(address);

  const ph = health.data;

  // Margin savings: portfolio margin vs. isolated maintenance requirement.
  // Positive means portfolio cross-margining is cheaper.
  const savingsPct =
    ph !== undefined && isolatedMaint.data !== undefined && isolatedMaint.data > 0n
      ? computeSavings(ph.portfolioMarginRequired, isolatedMaint.data)
      : null;

  return (
    <Card padded={false} className="terminal-card rounded-none">
      <CardHeader className="px-3 py-2">
        <CardTitle>Margin Account</CardTitle>
        {address !== null && (
          <span className="num text-xs text-stella-muted">{shortAddress(address)}</span>
        )}
      </CardHeader>

      <div className="grid grid-cols-2 gap-3 p-3 text-sm">
        <Cell
          label="Equity"
          value={ph !== undefined ? formatUsd(ph.totalCollateralValue) : "—"}
        />
        <Cell
          label="Margin used"
          value={ph !== undefined ? formatUsd(ph.portfolioMarginRequired) : "—"}
        />
        <Cell
          label="Free collateral"
          value={ph !== undefined ? formatUsd(ph.freeCollateral) : "—"}
          accent={ph !== undefined && ph.freeCollateral < 0n}
        />
        <Cell
          label="Net Δ (USD)"
          value={ph !== undefined ? formatUsd(ph.netDeltaUsd) : "—"}
          positive={ph !== undefined && ph.netDeltaUsd > 0n}
          negative={ph !== undefined && ph.netDeltaUsd < 0n}
        />

        <Cell label="Vault free"   value={vault.data !== undefined ? formatUsd(vault.data.free)   : "—"} />
        <Cell label="Vault locked" value={vault.data !== undefined ? formatUsd(vault.data.locked) : "—"} />

        {vault.data !== undefined && (
          <div className="col-span-2 -mt-1 flex gap-3">
            <Link
              to="/deposit"
              className="text-[10px] text-stella-gold/80 hover:text-stella-gold underline underline-offset-2"
            >
              Deposit →
            </Link>
            <Link
              to="/vaults?action=withdraw"
              className="text-[10px] text-stella-accent/70 hover:text-stella-accent underline underline-offset-2"
            >
              Withdraw →
            </Link>
          </div>
        )}

        {vault.data !== undefined && vault.data.free > 0n && (
          <div className="col-span-2 rounded border border-stella-long/30 bg-stella-long/10 px-3 py-2 text-xs">
            <span className="text-stella-muted">Available to withdraw: </span>
            <Link
              to="/vaults?action=withdraw"
              className="font-medium text-stella-long hover:text-stella-long/80 underline underline-offset-2"
            >
              {formatUsd(vault.data.free)} →
            </Link>
          </div>
        )}

        {savingsPct !== null && (
          <Cell
            label="Cross-margin savings"
            value={`${savingsPct >= 0 ? "+" : ""}${savingsPct.toFixed(1)}%`}
            span={2}
            positive={savingsPct > 0}
            negative={savingsPct < 0}
          />
        )}

        {ph !== undefined && (
          <div className="col-span-2">
            <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-stella-muted">
              <span>Health</span>
              <span>{ph.liquidatable ? "Critical" : "Healthy"}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
              <div
                className={ph.liquidatable ? "h-full bg-stella-short" : "h-full bg-stella-long"}
                style={{ width: `${healthWidth(ph.freeCollateral, ph.portfolioMarginRequired)}%` }}
              />
            </div>
          </div>
        )}

        {ph !== undefined && ph.liquidatable && (
          <div className="col-span-2 rounded border border-stella-short/40 bg-stella-short/10 px-3 py-2 text-xs text-stella-short">
            Account is liquidatable. Add collateral or reduce exposure.
          </div>
        )}
      </div>

      {address === null && (
        <p className="px-4 pb-4 text-xs text-stella-muted">
          Connect a wallet to view your portfolio.
        </p>
      )}
    </Card>
  );
}

function healthWidth(freeCollateral: bigint, marginRequired: bigint): number {
  if (marginRequired <= 0n) return 100;
  const pct = Number((freeCollateral * 100n) / marginRequired);
  return Math.max(5, Math.min(100, pct));
}

function computeSavings(portfolio: bigint, isolated: bigint): number {
  // savings = 1 − portfolio / isolated   (as percent)
  // Use fractional math at 6 decimals of precision.
  const scale = 1_000_000n;
  const ratio = Number((portfolio * scale) / isolated) / Number(scale);
  return (1 - ratio) * 100;
}

function Cell({
  label,
  value,
  span = 1,
  accent,
  positive,
  negative,
}: {
  label: string;
  value: string;
  span?: 1 | 2;
  accent?: boolean;
  positive?: boolean;
  negative?: boolean;
}) {
  const color = positive
    ? "text-stella-long"
    : negative
      ? "text-stella-short"
      : accent
        ? "text-stella-short"
        : "text-white";
  return (
    <div className={span === 2 ? "col-span-2" : undefined}>
      <div className="text-[10px] uppercase tracking-wide text-stella-muted">{label}</div>
      <div className={`num mt-0.5 text-sm ${color}`}>{value}</div>
    </div>
  );
}
