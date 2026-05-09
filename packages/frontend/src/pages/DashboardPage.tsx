import { useQueries } from "@tanstack/react-query";
import { StatTile } from "./dashboard/StatTile";
import { MarketsTable } from "./dashboard/MarketsTable";
import { TreasuryPanel } from "./dashboard/TreasuryPanel";
import { InsuranceFundTile } from "./dashboard/InsuranceFundTile";
import { SubAccountsCard } from "./dashboard/SubAccountsCard";
import { LendingCard } from "./dashboard/LendingCard";
import { formatUsd, fromFixed } from "@/ui/format";
import {
  useVaultTotal,
  useVaultNav,
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
    <div className="mx-auto max-w-[1350px] space-y-8 px-4 py-8">
      <header className="mb-8 text-center text-balance flex flex-col items-center">
        <h1 className="text-3xl font-semibold text-white tracking-tight mb-2">Dashboard</h1>
        <p className="text-base text-stella-muted max-w-2xl">
          Protocol-wide metrics. Prices and open interest refresh every 5–15 seconds.
        </p>
      </header>

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="TVL"
          value={formatUsd(tvl)}
          sub={`${fromFixed(collateral).toLocaleString("en-US", { maximumFractionDigits: 0 })} collateral + ${fromFixed(structured).toLocaleString("en-US", { maximumFractionDigits: 0 })} structured`}
        />
        <StatTile
          label="Open interest"
          value={formatUsd(totalOi)}
          sub={`${markets.length} markets · simulated`}
        />
        <InsuranceFundTile />
        <StatTile
          label="Structured NAV"
          value={formatUsd(structured)}
          sub="Covered-call vault"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_420px]">
        <MarketsTable />
        <TreasuryPanel />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <SubAccountsCard />
        <LendingCard />
      </div>
    </div>
  );
}
