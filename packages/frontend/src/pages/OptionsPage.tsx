import { useEffect, useState } from "react";
import { OptionWriterPanel } from "./options/OptionWriterPanel";
import { OptionsPortfolio } from "./options/OptionsPortfolio";
import { useOptionsMarkets } from "@/hooks/queries";
import { WalletRequiredBanner } from "@/ui/WalletRequiredBanner";

export function OptionsPage() {
  const marketsQ = useOptionsMarkets();
  const [underlying, setUnderlying] = useState<string | null>(null);

  // Default to first market when list loads.
  useEffect(() => {
    if (underlying === null && marketsQ.data && marketsQ.data.length > 0) {
      setUnderlying(marketsQ.data[0] ?? null);
    }
  }, [marketsQ.data, underlying]);

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6">
      <header>
        <h1 className="text-2xl font-semibold text-white">Options</h1>
        <p className="text-sm text-stella-muted">
          European-style covered calls and cash-secured puts. Premiums
          quoted by Black-Scholes with oracle-supplied IV.
        </p>
      </header>

      <WalletRequiredBanner />

      <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
        <OptionWriterPanel
          underlying={underlying}
          onUnderlyingChange={setUnderlying}
        />
        <OptionsPortfolio />
      </div>
    </div>
  );
}
