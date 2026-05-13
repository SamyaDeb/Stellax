/**
 * PortfolioPage — the single hub for managing all user funds on StellaX.
 *
 * Two sections side by side:
 *   Left  — Trading Account: deposit / withdraw USDC as perpetual trading margin.
 *   Right — SLP Yield Vault: deposit USDC to earn yield as LP counterparty pool.
 *
 * A plain-text fee-flow callout at the top explains how money moves through
 * the protocol so users understand why there are two pools.
 */

import { SlpVaultCard } from "./vaults/SlpVaultCard";
import { TradingAccountCard } from "./portfolio/TradingAccountCard";
import { DepositHistoryCard } from "./portfolio/DepositHistoryCard";
import { WalletRequiredBanner } from "@/ui/WalletRequiredBanner";
import { PauseBanner } from "@/ui/PauseBanner";
import { TestnetFaucetBar } from "@/ui/TestnetFaucetBar";
import { useWallet } from "@/wallet";

export function PortfolioPage() {
  const { address } = useWallet();

  return (
    <div className="mx-auto max-w-[1200px] space-y-8 px-4 py-8">

      {/* Page header */}
      <header className="text-center flex flex-col items-center">
        <h1 className="text-3xl font-semibold text-white tracking-tight mb-2">
          Portfolio
        </h1>
        <p className="text-base text-stella-muted max-w-2xl">
          Manage all your funds in one place, deposit margin to trade, or
          provide liquidity to earn yield from trading fees and funding.
        </p>
      </header>

      <WalletRequiredBanner />
      <TestnetFaucetBar />
      <PauseBanner />

      
      {/* ── Two-column vault cards ────────────────────────────────────────── */}
      <div className="grid gap-6 lg:grid-cols-2">
        <TradingAccountCard address={address} />
        <SlpVaultCard />
      </div>

      {/* ── Deposit history (on-chain) ────────────────────────────────────── */}
      <DepositHistoryCard address={address} />

    </div>
  );
}
