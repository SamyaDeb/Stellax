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
  const vault  = useVaultBalance(address);
  const health = usePortfolioHealth(address);
  const isolatedMaint = useMaintenanceMargin(address);

  const ph = health.data;

  const savingsPct =
    ph !== undefined && isolatedMaint.data !== undefined && isolatedMaint.data > 0n
      ? computeSavings(ph.portfolioMarginRequired, isolatedMaint.data)
      : null;

  return (
    <div style={{ fontFamily: "'JetBrains Mono', monospace" }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span className="terminal-panel-title">Account</span>
        {address !== null && (
          <span className="num" style={{ fontSize: 9, color: "var(--t3)" }}>
            {shortAddress(address)}
          </span>
        )}
      </div>

      {address === null ? (
        <div style={{ padding: "16px 12px", fontSize: 11, color: "var(--t3)" }}>
          Connect a wallet to view your account.
        </div>
      ) : (
        <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 0 }}>
          {/* Stats grid */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 12px", marginBottom: 10 }}>
            <AccountCell
              label="Balance"
              value={ph !== undefined ? formatUsd(ph.totalCollateralValue) : "—"}
            />
            <AccountCell
              label="Used Margin"
              value={ph !== undefined ? formatUsd(ph.portfolioMarginRequired) : "—"}
            />
            <AccountCell
              label="Available"
              value={ph !== undefined ? formatUsd(ph.freeCollateral) : "—"}
              warn={ph !== undefined && ph.freeCollateral < 0n}
            />
            <AccountCell
              label="Unrealized PnL"
              value={ph !== undefined ? formatUsd(ph.netDeltaUsd) : "—"}
              positive={ph !== undefined && ph.netDeltaUsd > 0n}
              negative={ph !== undefined && ph.netDeltaUsd < 0n}
            />
          </div>

          {/* Vault row */}
          {vault.data !== undefined && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "6px 12px",
                marginBottom: 10,
                paddingTop: 8,
                borderTop: "1px solid var(--border)",
              }}
            >
              <AccountCell label="Vault Free"   value={formatUsd(vault.data.free)} />
              <AccountCell label="Vault Locked" value={formatUsd(vault.data.locked)} />
            </div>
          )}

          {/* Cross-margin savings */}
          {savingsPct !== null && (
            <div
              style={{
                paddingTop: 8,
                borderTop: "1px solid var(--border)",
                marginBottom: 8,
              }}
            >
              <AccountCell
                label="Cross-margin Savings"
                value={`${savingsPct >= 0 ? "+" : ""}${savingsPct.toFixed(1)}%`}
                positive={savingsPct > 0}
                negative={savingsPct < 0}
              />
            </div>
          )}

          {/* Health bar */}
          {ph !== undefined && (
            <div style={{ paddingTop: 8, borderTop: "1px solid var(--border)" }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginBottom: 5,
                  fontSize: 9,
                  textTransform: "uppercase",
                  letterSpacing: "0.07em",
                  color: "var(--t3)",
                }}
              >
                <span>Health</span>
                <span style={{ color: ph.liquidatable ? "var(--red)" : "var(--green)" }}>
                  {ph.liquidatable ? "Critical" : "Healthy"}
                </span>
              </div>
              <div
                style={{
                  height: 3,
                  background: "var(--bg3)",
                  borderRadius: 1,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${healthWidth(ph.freeCollateral, ph.portfolioMarginRequired)}%`,
                    background: ph.liquidatable ? "var(--red)" : "var(--green)",
                    borderRadius: 1,
                    transition: "width 0.3s",
                  }}
                />
              </div>
            </div>
          )}

          {/* Liquidatable warning */}
          {ph !== undefined && ph.liquidatable && (
            <div
              style={{
                marginTop: 8,
                padding: "7px 9px",
                border: "1px solid rgba(240,64,74,0.35)",
                background: "var(--red-dim)",
                borderRadius: 3,
                fontSize: 10,
                color: "var(--red)",
                lineHeight: 1.4,
              }}
            >
              Account below maintenance margin. Add collateral or reduce exposure.
            </div>
          )}

          {/* Deposit shortcut */}
          <a
            href="/deposit"
            style={{
              display: "block",
              marginTop: 10,
              padding: "6px 0",
              textAlign: "center",
              fontSize: 10,
              fontWeight: 600,
              color: "var(--accent)",
              border: "1px solid rgba(79,142,255,0.2)",
              borderRadius: 3,
              textDecoration: "none",
              background: "var(--accent-dim)",
              transition: "background 0.1s, border-color 0.1s",
              letterSpacing: "0.04em",
              textTransform: "uppercase",
            }}
          >
            Deposit / Withdraw
          </a>
        </div>
      )}
    </div>
  );
}

function healthWidth(freeCollateral: bigint, marginRequired: bigint): number {
  if (marginRequired <= 0n) return 100;
  const pct = Number((freeCollateral * 100n) / marginRequired);
  return Math.max(5, Math.min(100, pct));
}

function computeSavings(portfolio: bigint, isolated: bigint): number {
  const scale = 1_000_000n;
  const ratio = Number((portfolio * scale) / isolated) / Number(scale);
  return (1 - ratio) * 100;
}

function AccountCell({
  label,
  value,
  warn,
  positive,
  negative,
}: {
  label: string;
  value: string;
  warn?: boolean;
  positive?: boolean;
  negative?: boolean;
}) {
  const color = warn || negative
    ? "var(--red)"
    : positive
      ? "var(--green)"
      : "var(--t1)";

  return (
    <div>
      <div
        style={{
          fontSize: 9,
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          color: "var(--t3)",
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div className="num" style={{ fontSize: 12, fontWeight: 600, color }}>
        {value}
      </div>
    </div>
  );
}
