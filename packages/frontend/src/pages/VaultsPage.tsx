import { CollateralVaultCard } from "./vaults/CollateralVaultCard";
import { StructuredVaultCard } from "./vaults/StructuredVaultCard";
import { EpochHistory } from "./vaults/EpochHistory";
import { WalletRequiredBanner } from "@/ui/WalletRequiredBanner";

export function VaultsPage() {
  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6">
      <header>
        <h1 className="text-2xl font-semibold text-white">Vaults</h1>
        <p className="text-sm text-stella-muted">
          Deposit collateral for margin trading, or earn yield from the
          covered-call structured vault.
        </p>
      </header>

      <WalletRequiredBanner />

      <div className="grid gap-4 lg:grid-cols-2">
        <CollateralVaultCard />
        <StructuredVaultCard />
      </div>

      <EpochHistory />
    </div>
  );
}
