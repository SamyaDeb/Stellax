import { SlpVaultCard } from "./vaults/SlpVaultCard";
import { VaultStatsHeader } from "./vaults/VaultStatsHeader";
import { WalletRequiredBanner } from "@/ui/WalletRequiredBanner";
import { PauseBanner } from "@/ui/PauseBanner";
import { TestnetFaucetBar } from "@/ui/TestnetFaucetBar";

export function VaultsPage() {
  return (
    <div className="mx-auto max-w-[1350px] space-y-8 px-4 py-8">
      <header className="mb-8 text-center text-balance flex flex-col items-center">
        <h1 className="text-3xl font-semibold text-white tracking-tight mb-2">Vaults</h1>
        <p className="text-base text-stella-muted max-w-2xl">
          Provide liquidity to the SLP counterparty pool and earn yield from
          trading fees, funding payments, and options premium — all in a single
          share class. Margin for trading is managed on the Trade page.
        </p>
      </header>

      <WalletRequiredBanner />
      <TestnetFaucetBar />
      <PauseBanner />

      {/* SLP yield summary bar */}
      <VaultStatsHeader />

      {/* Single vault hero — HLP-equivalent counterparty LP pool */}
      <SlpVaultCard />
    </div>
  );
}
