/**
 * ClosedTradesTable — history blotter for closed perpetual positions.
 * Data is sourced from the localStorage session store merged with recent
 * on-chain Soroban events via `useClosedTradesOnChain`.
 * Renders both user-initiated closes (kind = "user") and keeper-triggered
 * liquidations (kind = "liquidation") with distinct styling.
 */

import type { Market } from "@stellax/sdk";
import type { ClosedTrade } from "@/stores/sessionStore";
import { Table } from "@/ui/Table";
import { formatUsd } from "@/ui/format";

const EXPLORER_BASE = "https://stellar.expert/explorer/testnet/tx";

interface Props {
  trades: readonly ClosedTrade[];
  markets: readonly Market[];
}

export function ClosedTradesTable({ trades, markets }: Props) {
  const marketOf = (id: number): Market | undefined =>
    markets.find((m) => m.marketId === id);

  return (
    <div>
      <Table
        dense
        rowKey={(t) => t.positionId.toString()}
        rows={trades as ClosedTrade[]}
        empty="No closed trades this session"
        columns={[
          {
            key: "mkt",
            header: "Market",
            render: (t) => {
              const m = marketOf(t.marketId);
              return m !== undefined
                ? `${m.baseAsset}-${m.quoteAsset}`
                : `#${t.marketId}`;
            },
          },
          {
            key: "side",
            header: "Side",
            render: (t) => {
              if (t.kind === "liquidation") {
                return (
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide bg-stella-short/20 text-stella-short">
                    LIQUIDATED
                  </span>
                );
              }
              return (
                <span className={t.isLong ? "text-stella-long" : "text-stella-short"}>
                  {t.isLong ? "LONG" : "SHORT"} {t.leverage}x
                </span>
              );
            },
          },
          {
            key: "size",
            header: "Size",
            align: "right",
            render: (t) => formatUsd(t.size),
          },
          {
            key: "entry",
            header: "Entry",
            align: "right",
            render: (t) => formatUsd(t.entryPrice),
          },
          {
            key: "exit",
            header: "Exit",
            align: "right",
            render: (t) => formatUsd(t.exitPrice),
          },
          {
            key: "pnl",
            header: "Net PnL",
            align: "right",
            render: (t) => (
              <span className={t.netPnl >= 0n ? "text-stella-long" : "text-stella-short"}>
                {t.netPnl >= 0n ? "+" : ""}
                {formatUsd(t.netPnl)}
              </span>
            ),
          },
          {
            key: "fee",
            header: "Fee / Penalty",
            align: "right",
            render: (t) => (
              <span className="text-stella-muted">
                {formatUsd(t.closeFee)}
                {t.kind === "liquidation" && (
                  <span
                    className="ml-1 text-[9px] text-stella-short/70"
                    title={
                      t.keeperReward !== undefined
                        ? `Keeper: ${formatUsd(t.keeperReward)} · Insurance: ${formatUsd(t.insuranceDelta ?? t.keeperReward)}`
                        : "Liquidation penalty (50bps)"
                    }
                  >
                    liq
                  </span>
                )}
              </span>
            ),
          },
          {
            key: "time",
            header: "Time",
            align: "right",
            render: (t) => (
              <a
                href={`${EXPLORER_BASE}/${t.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] text-stella-accent/70 hover:text-stella-accent underline underline-offset-2"
              >
                {new Date(t.closedAt).toLocaleTimeString()} ↗
              </a>
            ),
          },
        ]}
      />
      <p className="border-t terminal-divider px-3 py-2 text-[10px] text-stella-muted">
        History is persisted locally and supplemented from on-chain events (last ~200 ledgers).
      </p>
    </div>
  );
}
