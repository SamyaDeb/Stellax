import { useQueries } from "@tanstack/react-query";
import { StatTile } from "./dashboard/StatTile";
import { MarketsTable } from "./dashboard/MarketsTable";
import { TreasuryPanel } from "./dashboard/TreasuryPanel";
import { formatUsd, fromFixed } from "@/ui/format";
import {
  useVaultTotal,
  useVaultNav,
  useInsuranceFund,
  useMarkets,
  qk,
} from "@/hooks/queries";
import { getClients } from "@/stellar/clients";
import { config, hasContract } from "@/config";

/**
 * Protocol-level overview: TVL across vaults, insurance fund, aggregate
 * open interest, markets table, and treasury fee accounting.
 */
export function DashboardPage() {
  const collateralQ = useVaultTotal();
  const structuredNavQ = useVaultNav();
  const insuranceQ = useInsuranceFund();
  const marketsQ = useMarkets();
  const markets = marketsQ.data ?? [];

  const oiQ = useQueries({
    queries: markets.map((m) => ({
      queryKey: qk.openInterest(m.marketId),
      queryFn: () => getClients().perpEngine.getOpenInterest(m.marketId),
      enabled: hasContract(config.contracts.perpEngine),
      refetchInterval: 10_000,
    })),
  });

  const totalOi = oiQ.reduce((acc, q) => {
    const d = q.data;
    if (d === undefined) return acc;
    return acc + d.long + d.short;
  }, 0n);

  const collateral = collateralQ.data ?? 0n;
  const structured = structuredNavQ.data ?? 0n;
  const tvl = collateral + structured;

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6">
      <header>
        <h1 className="text-2xl font-semibold text-white">Dashboard</h1>
        <p className="text-sm text-stella-muted">
          Protocol-wide metrics. Prices and open interest refresh every 5–15 seconds.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="TVL"
          value={formatUsd(tvl)}
          sub={`${fromFixed(collateral).toLocaleString("en-US", { maximumFractionDigits: 0 })} collateral + ${fromFixed(structured).toLocaleString("en-US", { maximumFractionDigits: 0 })} structured`}
        />
        <StatTile
          label="Open interest"
          value={formatUsd(totalOi)}
          sub={`${markets.length} markets`}
        />
        <StatTile
          label="Insurance fund"
          value={formatUsd(insuranceQ.data ?? 0n)}
          tone="ok"
          sub="Backstop for liquidation shortfalls"
        />
        <StatTile
          label="Structured NAV"
          value={formatUsd(structured)}
          sub="Covered-call vault"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_400px]">
        <MarketsTable />
        <TreasuryPanel />
      </div>
    </div>
  );
}
