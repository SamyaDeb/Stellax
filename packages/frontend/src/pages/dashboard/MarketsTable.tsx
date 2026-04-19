import { useQueries } from "@tanstack/react-query";
import type { Market } from "@stellax/sdk";
import { Card, CardHeader, CardTitle } from "@/ui/Card";
import { Table } from "@/ui/Table";
import { formatUsd, formatPct, fromFixed } from "@/ui/format";
import { getClients } from "@/stellar/clients";
import { qk, useMarkets } from "@/hooks/queries";
import { config, hasContract } from "@/config";

interface Row {
  market: Market;
  mark: bigint | undefined;
  oiLong: bigint | undefined;
  oiShort: bigint | undefined;
  fundingBps: bigint | undefined;
}

export function MarketsTable() {
  const marketsQ = useMarkets();
  const markets = marketsQ.data ?? [];

  const markQ = useQueries({
    queries: markets.map((m) => ({
      queryKey: qk.markPrice(m.marketId),
      queryFn: () => getClients().perpEngine.getMarkPrice(m.marketId),
      enabled: hasContract(config.contracts.perpEngine),
      refetchInterval: 5_000,
    })),
  });

  const oiQ = useQueries({
    queries: markets.map((m) => ({
      queryKey: qk.openInterest(m.marketId),
      queryFn: () => getClients().perpEngine.getOpenInterest(m.marketId),
      enabled: hasContract(config.contracts.perpEngine),
      refetchInterval: 10_000,
    })),
  });

  const fundingQ = useQueries({
    queries: markets.map((m) => ({
      queryKey: qk.fundingRate(m.marketId),
      queryFn: () => getClients().funding.getCurrentFundingRate(m.marketId),
      enabled: hasContract(config.contracts.funding),
      refetchInterval: 15_000,
    })),
  });

  const rows: Row[] = markets.map((m, i) => ({
    market: m,
    mark: markQ[i]?.data,
    oiLong: oiQ[i]?.data?.long,
    oiShort: oiQ[i]?.data?.short,
    fundingBps: fundingQ[i]?.data,
  }));

  return (
    <Card padded={false}>
      <CardHeader>
        <CardTitle>Markets</CardTitle>
        <span className="text-xs text-stella-muted">
          {markets.length} listed
        </span>
      </CardHeader>
      <div className="p-4">
        <Table
          rows={rows}
          rowKey={(r) => r.market.marketId.toString()}
          empty={marketsQ.isLoading ? "Loading…" : "No markets configured"}
          columns={[
            {
              key: "market",
              header: "Market",
              render: (r) => (
                <div>
                  <div className="font-medium text-white">
                    {r.market.baseAsset}-{r.market.quoteAsset}
                  </div>
                  <div className="text-xs text-stella-muted">
                    max {r.market.maxLeverage}x
                  </div>
                </div>
              ),
            },
            {
              key: "mark",
              header: "Mark",
              align: "right",
              render: (r) => (r.mark !== undefined ? formatUsd(r.mark) : "—"),
            },
            {
              key: "oi-long",
              header: "OI long",
              align: "right",
              render: (r) =>
                r.oiLong !== undefined ? (
                  <span className="text-stella-long">
                    {formatUsd(r.oiLong)}
                  </span>
                ) : (
                  "—"
                ),
            },
            {
              key: "oi-short",
              header: "OI short",
              align: "right",
              render: (r) =>
                r.oiShort !== undefined ? (
                  <span className="text-stella-short">
                    {formatUsd(r.oiShort)}
                  </span>
                ) : (
                  "—"
                ),
            },
            {
              key: "skew",
              header: "Skew",
              align: "right",
              render: (r) => {
                const l =
                  r.oiLong !== undefined ? fromFixed(r.oiLong) : 0;
                const s =
                  r.oiShort !== undefined ? fromFixed(r.oiShort) : 0;
                const total = l + s;
                if (total === 0) return "—";
                const skew = (l - s) / total;
                return (
                  <span
                    className={
                      skew >= 0 ? "text-stella-long" : "text-stella-short"
                    }
                  >
                    {(skew * 100).toFixed(1)}%
                  </span>
                );
              },
            },
            {
              key: "funding",
              header: "Funding (1h)",
              align: "right",
              render: (r) =>
                r.fundingBps !== undefined ? (
                  <span
                    className={
                      r.fundingBps >= 0n
                        ? "text-stella-long"
                        : "text-stella-short"
                    }
                  >
                    {formatPct(Number(r.fundingBps) / 1e18, 4)}
                  </span>
                ) : (
                  "—"
                ),
            },
          ]}
        />
      </div>
    </Card>
  );
}
