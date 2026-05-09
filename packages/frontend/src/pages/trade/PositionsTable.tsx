import { useEffect, useRef } from "react";
import type { Market } from "@stellax/sdk";
import type { SessionPosition } from "@/stores/sessionStore";
import { useSessionStore } from "@/stores/sessionStore";
import { Button } from "@/ui/Button";
import { Table } from "@/ui/Table";
import { formatNumber, formatUsd, fromFixed } from "@/ui/format";
import { useTx } from "@/wallet";
import { useTxStore, nextTxId } from "@/wallet/tx-store";
import { getClients } from "@/stellar/clients";
import { qk } from "@/hooks/queries";
import { parseCloseEvents, parseLiqEventsForUser } from "@/stellar/parseCloseEvents";
import { MAINTENANCE_MARGIN_RATIO } from "@/constants";

interface Props {
  positions: readonly SessionPosition[];
  markets: readonly Market[];
  marks: Readonly<Record<number, bigint | undefined>>;
  /** On-chain unrealized PnL per positionId string (includes funding). */
  onChainPnl?: Readonly<Record<string, bigint | undefined>>;
  address: string | null;
}

/** Estimated liquidation price (simple maintenance-margin approximation). */
function calcLiqPrice(p: SessionPosition): number | undefined {
  if (p.leverage <= 1) return undefined;
  const entry = fromFixed(p.entryPrice);
  if (entry === 0) return undefined;
  return p.isLong
    ? entry * (1 - 1 / p.leverage + MAINTENANCE_MARGIN_RATIO)
    : entry * (1 + 1 / p.leverage - MAINTENANCE_MARGIN_RATIO);
}

/**
 * Polls the risk contract's `liq` events every 5 s for keeper-initiated
 * liquidations matching any position currently in the session store.
 * When a match is found the position is removed and recorded in the history
 * blotter (kind = "liquidation") — triggering the red toast automatically.
 */
function useLiquidationWatcher(
  positions: readonly SessionPosition[],
  address: string | null,
) {
  const removePosition = useSessionStore((s) => s.removePosition);
  const recordClose = useSessionStore((s) => s.recordClose);
  // Track already-processed txHashes across re-renders so we never
  // double-record the same liquidation event.
  const processedTxs = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (address === null || positions.length === 0) return;

    // Build a lookup for fast positionId → position data access.
    const posMap = new Map(positions.map((p) => [p.positionId, p]));

    const poll = async () => {
      const events = await parseLiqEventsForUser(address);
      for (const ev of events) {
        if (processedTxs.current.has(ev.txHash)) continue;
        const pos = posMap.get(ev.positionId);
        if (pos === undefined) continue; // not a session-tracked position

        processedTxs.current.add(ev.txHash);
        removePosition(ev.positionId);
        recordClose({
          positionId: ev.positionId,
          marketId: pos.marketId,
          isLong: pos.isLong,
          leverage: pos.leverage,
          entryPrice: pos.entryPrice,
          size: pos.size,
          exitPrice: ev.oraclePrice,
          // Net PnL from the user's perspective: collateral returned minus what
          // was locked. Negative because liquidation always means a loss.
          netPnl: ev.remainingMargin - pos.margin,
          closeFee: ev.keeperReward,
          txHash: ev.txHash,
          closedAt: Date.now(),
          kind: "liquidation",
          keeperReward: ev.keeperReward,
        });
      }
    };

    void poll();
    const interval = setInterval(() => void poll(), 5_000);
    return () => clearInterval(interval);
  }, [address, positions, removePosition, recordClose]);
}

export function PositionsTable({ positions, markets, marks, onChainPnl, address }: Props) {
  const { run, pending, connected } = useTx();
  const removePosition = useSessionStore((s) => s.removePosition);
  const recordClose = useSessionStore((s) => s.recordClose);
  const pushToast = useTxStore((s) => s.push);

  // Background poll for keeper-initiated liquidations.
  useLiquidationWatcher(positions, address);

  const marketOf = (id: number): Market | undefined =>
    markets.find((m) => m.marketId === id);

  async function close(p: SessionPosition) {
    const m = marketOf(p.marketId);
    if (m === undefined) return;
    const result = await run(
      `Close ${m.baseAsset} ${p.isLong ? "long" : "short"}`,
      (source) =>
        getClients().perpEngine.closePosition(
          source,
          p.positionId, // real on-chain position ID from the session store
          { sourceAccount: source },
        ),
      {
        invalidate: [
          qk.userPositions(address ?? ""),
          qk.openInterest(p.marketId),
          qk.accountHealth(address ?? ""),
          qk.portfolioHealth(address ?? ""),
          qk.vaultBalance(address ?? ""),
          qk.unrealizedPnl(p.positionId),
          qk.markPrice(p.marketId),
          qk.fundingRate(p.marketId),
        ],
      },
    );
    // Remove from session store on success so the row disappears immediately.
    // Then fetch on-chain events to capture exit price, net PnL, and fee.
    if (result?.status === "SUCCESS") {
      removePosition(p.positionId);
      if (result.latestLedger !== undefined) {
        const events = await parseCloseEvents(p.positionId, result.latestLedger);
        if (events !== null) {
          recordClose({
            positionId: p.positionId,
            marketId: p.marketId,
            isLong: p.isLong,
            leverage: p.leverage,
            entryPrice: p.entryPrice,
            size: p.size,
            exitPrice: events.exitPrice,
            netPnl: events.netPnl,
            closeFee: events.closeFee,
            txHash: result.hash,
            closedAt: Date.now(),
          });
          // Push a dedicated PnL summary toast with a withdraw shortcut.
          const pnlSign = events.netPnl >= 0n ? "+" : "";
          pushToast({
            id: nextTxId(),
            label: `Position closed — PnL ${pnlSign}${formatUsd(events.netPnl)}`,
            phase: "success",
            hash: result.hash,
            action: { label: "Withdraw →", href: "/vaults?action=withdraw" },
          });
        }
      }
    }
  }

  return (
    <div>
      <Table
        dense
        rowKey={(p) =>
          `${p.owner}-${p.positionId.toString()}`
        }
        rows={positions}
        empty="No open positions"
        columns={[
          {
            key: "mkt",
            header: "Market",
            render: (p) => {
              const m = marketOf(p.marketId);
              return m !== undefined
                ? `${m.baseAsset}-${m.quoteAsset}`
                : `#${p.marketId}`;
            },
          },
          {
            key: "side",
            header: "Side",
            render: (p) => (
              <span
                className={
                  p.isLong ? "text-stella-long" : "text-stella-short"
                }
              >
                {p.isLong ? "LONG" : "SHORT"} {p.leverage}x
              </span>
            ),
          },
          {
            key: "size",
            header: "Size",
            align: "right",
            render: (p) => formatUsd(p.size),
          },
          {
            key: "entry",
            header: "Entry",
            align: "right",
            render: (p) => formatUsd(p.entryPrice),
          },
          {
            key: "mark",
            header: "Mark",
            align: "right",
            render: (p) => {
              const mark = marks[p.marketId];
              return mark !== undefined ? formatUsd(mark) : "—";
            },
          },
          {
            key: "liq",
            header: "Liq. Price",
            align: "right",
            render: (p) => {
              const liq = calcLiqPrice(p);
              if (liq === undefined) return "—";
              return (
                <span className="text-stella-short">
                  ${liq.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              );
            },
          },
          {
            key: "margin",
            header: "Margin",
            align: "right",
            render: (p) => formatUsd(p.margin),
          },
          {
            key: "pnl",
            header: "PnL / ROE",
            align: "right",
            render: (p) => {
              // Prefer on-chain value (includes funding payments) when
              // available; fall back to client-side mark-price estimate.
              const onChain = onChainPnl?.[p.positionId.toString()];
              const mark = marks[p.marketId];
              let pnl: bigint | undefined;
              let isOnChain = false;
              if (onChain !== undefined) {
                pnl = onChain;
                isOnChain = true;
              } else if (mark !== undefined) {
                const dir = p.isLong ? 1n : -1n;
                pnl =
                  p.entryPrice === 0n
                    ? 0n
                    : (dir * (mark - p.entryPrice) * p.size) / p.entryPrice;
              }
              if (pnl === undefined) return "—";
              const roe =
                p.margin > 0n ? (fromFixed(pnl) / fromFixed(p.margin)) * 100 : 0;
              const cls =
                pnl >= 0n ? "text-stella-long" : "text-stella-short";
              return (
                <span className={cls}>
                  {formatUsd(pnl)}
                  <span className="ml-1 text-[10px] opacity-80">
                    ({roe >= 0 ? "+" : ""}{roe.toFixed(1)}%)
                  </span>
                  {!isOnChain && (
                    <span
                      className="ml-1 text-[9px] opacity-40"
                      title="Estimated from mark price — on-chain value loading"
                    >
                      ~
                    </span>
                  )}
                </span>
              );
            },
          },
          {
            key: "id",
            header: "ID",
            align: "right",
            render: (p) => (
              <span className="text-[10px] text-stella-muted">
                #{p.positionId.toString()}
              </span>
            ),
          },
          {
            key: "actions",
            header: "",
            align: "right",
            render: (p) => (
              <Button
                size="sm"
                variant="ghost"
                disabled={!connected || pending}
                onClick={() => void close(p)}
              >
                Close
              </Button>
            ),
          },
        ]}
      />
      <p className="border-t terminal-divider px-3 py-2 text-[10px] text-stella-muted">
        PnL is sourced on-chain from <code>get_unrealized_pnl</code> (oracle index price, includes funding).
        <span className="opacity-60"> ~ indicates estimated from mark while on-chain value loads.</span>
        Liq. price is client-side. Positions persist for this session only.
      </p>
    </div>
  );
}

export function sumMarginUsed(
  positions: readonly SessionPosition[],
): bigint {
  return positions.reduce((sum, p) => sum + p.margin, 0n);
}

export function formatPositionCount(n: number): string {
  return n === 1 ? "1 position" : `${n} positions`;
}

export { formatNumber };
