import type { EpochState } from "@stellax/sdk";
import { Table } from "@/ui/Table";
import { formatUsd } from "@/ui/format";
import { useCurrentEpochState } from "@/hooks/queries";

/** Format a 7-decimal oracle price as USD (e.g. 1_000_000 → $0.10). */
function fmtStrike(strike: bigint): string {
  if (strike === 0n) return "—";
  return `$${(Number(strike) / 1e7).toFixed(4)}`;
}

export function EpochHistory() {
  const currentQ = useCurrentEpochState();
  const current = currentQ.data;

  const rows: EpochState[] = current !== undefined ? [current] : [];

  return (
    <div className="glass-card">
      <div className="border-b border-stella-gold/10 px-6 py-5 flex items-center justify-between">
        <h3 className="text-xl font-semibold text-white tracking-tight">Current Epoch</h3>
        <span className="text-xs text-stella-muted uppercase tracking-wider font-semibold">Structured Vault</span>
      </div>
      <div className="p-6">
        {rows.length === 0 ? (
          <p className="text-sm text-stella-muted text-center py-8">
            {currentQ.isLoading ? "Loading epoch parameters…" : "No epoch data available."}
          </p>
        ) : (
          <div className="rounded-xl overflow-hidden border border-white/10 bg-black/20">
            <Table
              rows={rows}
              rowKey={(r) => r.epochId.toString()}
              columns={[
                {
                  key: "id",
                  header: "Epoch",
                  render: (r) => <span className="num font-semibold">#{r.epochId}</span>,
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
                    <span className="num">{formatUsd(r.totalAssets)}</span>
                  ),
                  align: "right",
                },
                {
                  key: "premium",
                  header: "Premium",
                  render: (r) => (
                    <span className="num text-stella-long font-medium">
                      {formatUsd(r.premium)}
                    </span>
                  ),
                  align: "right",
                },
                {
                  key: "strike",
                  header: "Strike",
                  render: (r) => (
                    <span className="num text-stella-gold font-medium">
                      {fmtStrike(r.strike)}
                    </span>
                  ),
                  align: "right",
                },
                {
                  key: "optionId",
                  header: "Option ID",
                  render: (r) => (
                    <span className="num text-stella-muted">
                      {r.optionId > 0n ? `#${r.optionId}` : "—"}
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
                        r.settled ? "text-stella-muted font-medium" : "text-stella-long font-bold"
                      }
                    >
                      {r.settled ? "Settled" : "Active"}
                    </span>
                  ),
                },
              ]}
            />
          </div>
        )}
      </div>
    </div>
  );
}
