import { useEffect, useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { Card } from "@/ui/Card";
import { Button } from "@/ui/Button";
import { WalletRequiredBanner } from "@/ui/WalletRequiredBanner";
import { formatPct, formatUsd } from "@/ui/format";
import {
  useFundingRate,
  useMarkPrice,
  useMarkets,
  useOpenInterest,
  usePrice,
  qk,
} from "@/hooks/queries";
import { getClients } from "@/stellar/clients";
import { useWallet, useTx } from "@/wallet";
import { useSessionStore } from "@/stores/sessionStore";
import { MarketSelector } from "./trade/MarketSelector";
import { PriceChart } from "./trade/PriceChart";
import { OrderForm } from "./trade/OrderForm";
import { PositionsTable } from "./trade/PositionsTable";
import { AccountSummary } from "./trade/AccountSummary";
import { config, hasContract } from "@/config";

export function TradePage() {
  const { address } = useWallet();
  const { run, pending: txPending } = useTx();
  const markets = useMarkets();
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // Auto-select first market when list loads.
  useEffect(() => {
    if (selectedId === null && markets.data !== undefined && markets.data.length > 0) {
      const first = markets.data[0];
      if (first !== undefined) setSelectedId(first.marketId);
    }
  }, [markets.data, selectedId]);

  const selected = useMemo(
    () => markets.data?.find((m) => m.marketId === selectedId) ?? null,
    [markets.data, selectedId],
  );

  const price = usePrice(selected?.baseAsset ?? null);
  const mark = useMarkPrice(selected?.marketId ?? null);
  const oi = useOpenInterest(selected?.marketId ?? null);
  const funding = useFundingRate(selected?.marketId ?? null);

  // Session-local positions (in-memory; resets on page refresh).
  const allPositions = useSessionStore((s) => s.positions);
  const positions = allPositions.filter((p) => p.owner === (address ?? ""));

  // Fetch mark price for every position market so the table can render PnL.
  const positionMarketIds = useMemo(
    () => Array.from(new Set(positions.map((p) => p.marketId))),
    [positions],
  );
  const allMarks = useQueries({
    queries: positionMarketIds.map((id) => ({
      queryKey: qk.markPrice(id),
      queryFn: () => getClients().perpEngine.getMarkPrice(id),
      enabled: hasContract(config.contracts.perpEngine),
      refetchInterval: 10_000,
    })),
  });
  const marksMap = useMemo(() => {
    const m: Record<number, bigint | undefined> = {};
    positionMarketIds.forEach((id, i) => {
      m[id] = allMarks[i]?.data as bigint | undefined;
    });
    return m;
  }, [positionMarketIds, allMarks]);

  if (!hasContract(config.contracts.perpEngine) || !hasContract(config.contracts.oracle)) {
    return (
      <Card>
        <p className="text-sm text-stella-muted">
          Contracts not yet deployed. Populate <code>VITE_*_CONTRACT_ID</code> in
          <code> .env</code> after Phase 14 deployment.
        </p>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
      <div className="space-y-4">
        <WalletRequiredBanner />
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="w-64">
            <MarketSelector
              markets={markets.data ?? []}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          </div>
          <div className="flex flex-wrap items-center gap-6 text-sm">
            <Stat label="Mark" value={mark.data !== undefined ? formatUsd(mark.data) : "—"} />
            <Stat
              label="Oracle"
              value={price.data !== undefined ? formatUsd(price.data.price) : "—"}
            />
            <Stat
              label="OI Long"
              value={oi.data !== undefined ? formatUsd(oi.data.long) : "—"}
            />
            <Stat
              label="OI Short"
              value={oi.data !== undefined ? formatUsd(oi.data.short) : "—"}
            />
            <Stat
              label="Funding / hr"
              value={funding.data !== undefined ? formatPct(Number(funding.data) / 1e18, 4) : "—"}
            />
            {selectedId !== null && (
              <Button
                variant="ghost"
                size="sm"
                disabled={txPending}
                title="Permissionless keeper: refreshes the on-chain funding rate"
                onClick={() =>
                  void run(
                    "Update funding",
                    (source) =>
                      getClients().funding.updateFunding(selectedId, {
                        sourceAccount: source,
                      }),
                    { invalidate: [qk.fundingRate(selectedId)] },
                  )
                }
              >
                ↻ Funding
              </Button>
            )}
          </div>
        </div>

        <Card>
          <PriceChart
            price={price.data?.price}
            timestamp={price.data?.writeTimestamp}
            title={
              selected !== null
                ? `${selected.baseAsset}-${selected.quoteAsset}`
                : "No market"
            }
          />
        </Card>

        <PositionsTable
          positions={positions}
          markets={markets.data ?? []}
          marks={marksMap}
          address={address}
        />
      </div>

      <div className="space-y-4">
        <AccountSummary address={address} />
        {selected !== null && (
          <OrderForm market={selected} markPrice={mark.data} />
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-stella-muted">
        {label}
      </div>
      <div className="num text-white">{value}</div>
    </div>
  );
}
