import type { VaultEpoch } from "@stellax/sdk";
import { Card, CardHeader, CardTitle } from "@/ui/Card";
import { Table } from "@/ui/Table";
import { formatUsd } from "@/ui/format";
import { useCurrentEpoch } from "@/hooks/queries";

/**
 * Renders the current structured vault epoch.
 *
 * Historical walk via getEpoch(id) is not supported by the on-chain ABI
 * (getEpoch() takes zero args and returns the current epoch only).
 * Full history should be served from an off-chain indexer in production.
 */
export function EpochHistory() {
  const currentQ = useCurrentEpoch();
  const current = currentQ.data;

  const rows: VaultEpoch[] = current !== undefined ? [current] : [];

  return (
    <Card padded={false}>
      <CardHeader>
        <CardTitle>Epoch history</CardTitle>
        <span className="text-xs text-stella-muted">Current epoch</span>
      </CardHeader>
      <div className="p-4">
        {rows.length === 0 ? (
          <p className="text-sm text-stella-muted">
            {currentQ.isLoading ? "Loading…" : "No epoch data available."}
          </p>
        ) : (
          <Table
            rows={rows}
            rowKey={(r) => r.epochId.toString()}
            columns={[
              {
                key: "id",
                header: "Epoch",
                render: (r) => <span className="num">#{r.epochId}</span>,
              },
              {
                key: "start",
                header: "Start",
                render: (r) =>
                  new Date(Number(r.startTime) * 1000).toLocaleDateString(),
              },
              {
                key: "end",
                header: "End",
                render: (r) =>
                  new Date(Number(r.endTime) * 1000).toLocaleDateString(),
              },
              {
                key: "deposits",
                header: "Deposits",
                render: (r) => (
                  <span className="num">{formatUsd(r.totalDeposits)}</span>
                ),
                align: "right",
              },
              {
                key: "premium",
                header: "Premium",
                render: (r) => (
                  <span className="num text-stella-long">
                    {formatUsd(r.totalPremium)}
                  </span>
                ),
                align: "right",
              },
              {
                key: "state",
                header: "State",
                render: (r) => (
                  <span
                    className={
                      r.settled ? "text-stella-muted" : "text-stella-accent"
                    }
                  >
                    {r.settled ? "settled" : "open"}
                  </span>
                ),
              },
            ]}
          />
        )}
      </div>
    </Card>
  );
}
