import { CollateralVaultCard } from "./vaults/CollateralVaultCard";
import { StructuredVaultCard } from "./vaults/StructuredVaultCard";
import { EpochHistory } from "./vaults/EpochHistory";
import { WalletRequiredBanner } from "@/ui/WalletRequiredBanner";

export function VaultsPage() {
  return (
    <div className="mx-auto max-w-[1350px] space-y-8 px-4 py-8">
      <header className="mb-8 text-center text-balance flex flex-col items-center">
        <h1 className="text-3xl font-semibold text-white tracking-tight mb-2">Vaults</h1>
        <p className="text-base text-stella-muted max-w-2xl">
          Deposit USDC collateral for margin trading or earn auto-compounding yield from the covered-call structured vault.
        </p>
      </header>

      <WalletRequiredBanner />

      <div className="grid gap-6 lg:grid-cols-2 items-stretch">
        <CollateralVaultCard />
        <StructuredVaultCard />
      </div>

      <div className="pt-8">
        <EpochHistory />
      </div>
    </div>
  );
}
