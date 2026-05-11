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
  useMarkets,
  useSlpTotalAssets,
  qk,
} from "@/hooks/queries";
import { useSlpApr } from "@/hooks/useSlpApr";
import { getClients } from "@/stellar/clients";
import { config, hasContract } from "@/config";

/**
 * Protocol-level overview: TVL (margin + SLP), insurance fund, open interest,
 * estimated SLP APR, markets table, and treasury fee accounting.
 *
 * TVL = collateral (margin accounts) + SLP vault assets.
 * The structured vault is an internal protocol mechanism; it is not included.
 */
export function DashboardPage() {
  const collateralQ = useVaultTotal();
  const slpAssetsQ  = useSlpTotalAssets();
  const marketsQ    = useMarkets();
  const apr         = useSlpApr();
  const markets     = marketsQ.data ?? [];

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
  const slpAssets  = slpAssetsQ.data ?? 0n;
  // Option A: TVL = margin collateral + SLP vault assets
  const tvl = collateral + slpAssets;

  const slpEnabled = config.contracts.slpVault.length > 0;

  // Est. APR tile
  const fmtApr = apr !== null
    ? `${apr >= 0 ? "+" : ""}${apr.toFixed(2)}%`
    : "—";
  const aprSub = slpEnabled
    ? apr !== null
      ? "annualised · session est."
      : "accumulating…"
    : "SLP not deployed";

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
          sub={[
            `${fromFixed(collateral).toLocaleString("en-US", { maximumFractionDigits: 0 })} margin`,
            slpEnabled
              ? `${fromFixed(slpAssets).toLocaleString("en-US", { maximumFractionDigits: 0 })} SLP`
              : null,
          ].filter(Boolean).join(" + ")}
        />
        <StatTile
          label="Open interest"
          value={formatUsd(totalOi)}
          sub={`${markets.length} markets · simulated`}
        />
        <InsuranceFundTile />
        <StatTile
          label="SLP Est. APR"
          value={slpEnabled ? fmtApr : "—"}
          sub={aprSub}
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
