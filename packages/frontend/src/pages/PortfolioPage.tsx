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
          Manage all your funds in one place — deposit margin to trade, or
          provide liquidity to earn yield from trading fees and funding.
        </p>
      </header>

      <WalletRequiredBanner />
      <TestnetFaucetBar />
      <PauseBanner />

      {/* ── How the money flows ─────────────────────────────────────────── */}
      <div className="rounded-xl border border-stella-gold/15 bg-stella-gold/5 px-5 py-4 space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-stella-gold">
          How fees &amp; profits flow
        </h2>
        <div className="grid gap-3 sm:grid-cols-3 text-sm text-stella-muted leading-relaxed">
          <div className="space-y-1">
            <div className="font-semibold text-white text-xs uppercase tracking-wide">
              Step 1 — Traders pay fees
            </div>
            Every time a trader opens or closes a position, a taker fee is
            charged and sent to the <span className="text-white/80">Treasury</span>.
          </div>
          <div className="space-y-1">
            <div className="font-semibold text-white text-xs uppercase tracking-wide">
              Step 2 — Keeper sweeps fees
            </div>
            A keeper bot periodically calls <code className="text-stella-gold/80 text-[11px]">sweep_fees()</code>,
            moving accumulated fees from the Treasury into the{" "}
            <span className="text-white/80">SLP Vault</span>. This increases
            <code className="text-stella-gold/80 text-[11px]"> total_assets</code> in
            the vault.
          </div>
          <div className="space-y-1">
            <div className="font-semibold text-white text-xs uppercase tracking-wide">
              Step 3 — NAV per sxSLP changes
            </div>
            <span className="text-stella-long">Traders lose</span> → SLP Vault
            gains → NAV per sxSLP rises.{" "}
            <span className="text-stella-short">Traders profit</span> → SLP Vault
            pays out → NAV per sxSLP falls. Fee sweeps always uplift NAV.
          </div>
        </div>
        <div className="pt-1 border-t border-stella-gold/10 text-[11px] text-stella-muted">
          <strong className="text-white/70">Trading Account vs SLP Vault:</strong>{" "}
          Your Trading Account margin can be liquidated if positions go
          underwater — it earns no yield. The SLP Vault earns fees and funding
          but NAV moves with aggregate trader P&amp;L.
        </div>
      </div>

      {/* ── Two-column vault cards ────────────────────────────────────────── */}
      <div className="grid gap-6 lg:grid-cols-2">
        <TradingAccountCard address={address} />
        <SlpVaultCard />
      </div>

    </div>
  );
}
