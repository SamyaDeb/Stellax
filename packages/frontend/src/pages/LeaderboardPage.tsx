import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { shortAddress } from "@/ui/format";
import { Card, CardHeader, CardTitle } from "@/ui/Card";
import { Table } from "@/ui/Table";
import { config } from "@/config";

type LeaderboardPeriod = "daily" | "weekly" | "all";

interface LeaderboardEntry {
  rank: number;
  address: string;
  pnlUsd: number;
  pnlPct: number;
  tradeCount: number;
  winRate: number;
}

async function fetchLeaderboard(period: LeaderboardPeriod): Promise<LeaderboardEntry[]> {
  if (!config.indexer.enabled) return [];
  const base = config.indexer.url.replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/leaderboard?period=${period}&limit=50`);
    if (!res.ok) return [];
    return (await res.json()) as LeaderboardEntry[];
  } catch {
    return [];
  }
}

export function LeaderboardPage() {
  const [period, setPeriod] = useState<LeaderboardPeriod>("daily");

  const { data: entries, isLoading } = useQuery({
    queryKey: ["leaderboard", period],
    queryFn: () => fetchLeaderboard(period),
    refetchInterval: 30_000,
    enabled: config.indexer.enabled,
  });

  const rows = entries ?? [];
  const empty = !config.indexer.enabled
    ? "Indexer is not configured"
    : isLoading
      ? "Loading..."
      : "No data available";

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", fontFamily: "'JetBrains Mono', monospace" }}>
      <div className="page-header">
        <h1>Leaderboard</h1>
        <p>Top traders by realized PnL</p>
      </div>

      {/* Period tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
        {(["daily", "weekly", "all"] as const).map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={`order-type-tab ${period === p ? "active" : "inactive"}`}
            style={{ flex: "0 0 auto", minWidth: 80 }}
          >
            {p === "daily" ? "24h" : p === "weekly" ? "7D" : "All Time"}
          </button>
        ))}
      </div>

      <Card padded={false}>
        <CardHeader>
          <CardTitle>Top Traders</CardTitle>
          <span className="text-xs text-stella-muted">
            {rows.length} ranked
          </span>
        </CardHeader>
        <div className="p-4">
          <Table
            rows={rows}
            rowKey={(r) => r.address}
            empty={empty}
            columns={[
              {
                key: "rank",
                header: "#",
                render: (r) => {
                  if (r.rank <= 3) {
                    const colors = ["#f0a742", "#8892a4", "#8B6914"];
                    return (
                      <span style={{ color: colors[r.rank - 1], fontWeight: 700, fontSize: 14 }}>
                        {r.rank}
                      </span>
                    );
                  }
                  return <span className="text-stella-muted">{r.rank}</span>;
                },
              },
              {
                key: "address",
                header: "Trader",
                render: (r) => (
                  <span className="text-sm text-stella-muted">{shortAddress(r.address)}</span>
                ),
              },
              {
                key: "pnl",
                header: "Realized PnL",
                align: "right",
                render: (r) => (
                  <span
                    className={r.pnlUsd >= 0 ? "text-stella-long" : "text-stella-short"}
                  >
                    {r.pnlUsd >= 0 ? "+" : ""}${r.pnlUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                ),
              },
              {
                key: "pnlPct",
                header: "ROI",
                align: "right",
                render: (r) => (
                  <span className={r.pnlPct >= 0 ? "text-stella-long" : "text-stella-short"}>
                    {r.pnlPct >= 0 ? "+" : ""}{r.pnlPct.toFixed(2)}%
                  </span>
                ),
              },
              {
                key: "trades",
                header: "Trades",
                align: "right",
                render: (r) => <span>{r.tradeCount}</span>,
              },
              {
                key: "winRate",
                header: "Win Rate",
                align: "right",
                render: (r) => (
                  <span>{r.winRate.toFixed(1)}%</span>
                ),
              },
            ]}
          />
        </div>
      </Card>
    </div>
  );
}
