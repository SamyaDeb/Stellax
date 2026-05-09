/**
 * OpenOrdersTable — shows the connected user's open limit orders on the
 * hybrid CLOB, with a Cancel action per row.
 *
 * Data source: `useOrders({ trader: address, status: "open" })` → indexer.
 * Cancel: `clob.cancelOrder(caller, orderId)` through the standard useTx wrapper.
 *
 * The table is hidden when the CLOB contract isn't configured or the user
 * has no open orders (keeps the trading pane uncluttered).
 */

import { Button } from "@/ui/Button";
import { Table } from "@/ui/Table";
import { fromFixed } from "@/ui/format";
import { useTx } from "@/wallet";
import { getClients } from "@/stellar/clients";
import { useOrders, type IndexerOrderRow } from "@/hooks/useOrders";
import { qk } from "@/hooks/queries";
import { config } from "@/config";
import type { Market } from "@stellax/sdk";

interface Props {
  address: string | null;
  markets: readonly Market[];
}

export function OpenOrdersTable({ address, markets }: Props) {
  const { orders } = useOrders({ trader: address, status: "open" });
  const { run, pending, connected } = useTx();

  if (config.contracts.clob.length === 0) {
    return <div className="px-3 py-6 text-center text-sm text-stella-muted">CLOB unavailable</div>;
  }
  if (address === null) {
    return <div className="px-3 py-6 text-center text-sm text-stella-muted">Connect wallet to view open orders</div>;
  }

  const marketOf = (id: number): Market | undefined =>
    markets.find((m) => m.marketId === id);

  async function cancel(o: IndexerOrderRow) {
    const m = marketOf(o.marketId);
    const label = m !== undefined ? `${m.baseAsset}-${m.quoteAsset}` : `#${o.marketId}`;
    await run(
      `Cancel ${label} limit ${o.isLong ? "buy" : "sell"}`,
      (source) =>
        getClients().clob.cancelOrder(source, BigInt(o.orderId), {
          sourceAccount: source,
        }),
      {
        invalidate: [
          qk.userPositions(address ?? ""),
          qk.accountHealth(address ?? ""),
          qk.vaultBalance(address ?? ""),
        ],
      },
    );
    // Indexer WebSocket triggers useOrders refetch automatically.
  }

  return (
    <div>
      <Table
        dense
        rowKey={(o) => o.orderId}
        rows={orders}
        empty="No open orders"
        columns={[
          {
            key: "mkt",
            header: "Market",
            render: (o) => {
              const m = marketOf(o.marketId);
              return m !== undefined ? `${m.baseAsset}-${m.quoteAsset}` : `#${o.marketId}`;
            },
          },
          {
            key: "side",
            header: "Side",
            render: (o) => (
              <span className={o.isLong === 1 ? "text-stella-long" : "text-stella-short"}>
                {o.isLong === 1 ? "BUY" : "SELL"}
              </span>
            ),
          },
          {
            key: "price",
            header: "Limit",
            align: "right",
            render: (o) => fromFixed(BigInt(o.price)).toFixed(2),
          },
          {
            key: "size",
            header: "Size",
            align: "right",
            render: (o) => fromFixed(BigInt(o.size)).toFixed(4),
          },
          {
            key: "filled",
            header: "Filled",
            align: "right",
            render: (o) => {
              const total = BigInt(o.size);
              const filled = BigInt(o.filledSize);
              const pct = total > 0n
                ? Number((filled * 10_000n) / total) / 100
                : 0;
              return `${pct.toFixed(1)}%`;
            },
          },
          {
            key: "id",
            header: "ID",
            align: "right",
            render: (o) => (
              <span className="text-[10px] text-stella-muted">#{o.orderId}</span>
            ),
          },
          {
            key: "actions",
            header: "",
            align: "right",
            render: (o) => (
              <Button
                size="sm"
                variant="ghost"
                disabled={!connected || pending}
                onClick={() => void cancel(o)}
              >
                Cancel
              </Button>
            ),
          },
        ]}
      />
    </div>
  );
}
