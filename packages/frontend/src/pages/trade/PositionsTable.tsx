import type { Market } from "@stellax/sdk";
import type { SessionPosition } from "@/stores/sessionStore";
import { useSessionStore } from "@/stores/sessionStore";
import { Button } from "@/ui/Button";
import { Card, CardHeader, CardTitle } from "@/ui/Card";
import { Table } from "@/ui/Table";
import { formatNumber, formatUsd } from "@/ui/format";
import { useTx } from "@/wallet";
import { getClients } from "@/stellar/clients";
import { qk } from "@/hooks/queries";

interface Props {
  positions: readonly SessionPosition[];
  markets: readonly Market[];
  marks: Readonly<Record<number, bigint | undefined>>;
  address: string | null;
}

export function PositionsTable({ positions, markets, marks, address }: Props) {
  const { run, pending, connected } = useTx();
  const removePosition = useSessionStore((s) => s.removePosition);

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
          qk.accountEquity(address ?? ""),
          qk.freeCollateral(address ?? ""),
        ],
      },
    );
    // Remove from session store on success so the row disappears immediately
    if (result?.status === "SUCCESS") {
      removePosition(p.positionId);
    }
  }

  return (
    <Card padded={false}>
      <CardHeader>
        <CardTitle>Positions</CardTitle>
        <span className="text-xs text-stella-muted">
          {positions.length} open
        </span>
      </CardHeader>
      <Table
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
            key: "margin",
            header: "Margin",
            align: "right",
            render: (p) => formatUsd(p.margin),
          },
          {
            key: "pnl",
            header: "Unrealized PnL",
            align: "right",
            render: (p) => {
              const mark = marks[p.marketId];
              if (mark === undefined) return "—";
              const dir = p.isLong ? 1n : -1n;
              const pnl =
                p.entryPrice === 0n
                  ? 0n
                  : (dir * (mark - p.entryPrice) * p.size) / p.entryPrice;
              const cls =
                pnl >= 0n ? "text-stella-long" : "text-stella-short";
              return <span className={cls}>{formatUsd(pnl)}</span>;
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
      <p className="px-4 py-2 text-[10px] text-stella-muted">
        PnL estimated client-side against mark price. On-chain close settles
        against oracle. Positions persist for this session only; reload resets
        the list (positions remain open on-chain).
      </p>
    </Card>
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
