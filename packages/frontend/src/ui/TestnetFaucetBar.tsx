/**
 * TestnetFaucetBar — dismissible top bar shown on testnet when the connected
 * wallet appears to have low USDC (< $10).
 *
 * Buttons:
 *   1. "Get XLM" — fires a Friendbot request to fund the connected address.
 *   2. "Deposit USDC" — navigates to /deposit?amount=500&asset=XLM so the
 *      DepositPage form is pre-filled for a XLM→USDC path-payment.
 *
 * The bar hides itself automatically once dismissed (persisted to
 * sessionStorage so it stays gone for the rest of the browser session).
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { isTestnet, config } from "@/config";
import { useWallet } from "@/wallet";

const DISMISS_KEY = "stellax:faucet-bar-dismissed";
const USDC_THRESHOLD = 10; // hide bar once user has ≥ $10 USDC

/** Fetch the user's USDC balance from Horizon (classic layer). */
async function fetchUsdcBalance(address: string): Promise<number> {
  const url = `${config.network.horizonUrl}/accounts/${address}`;
  const res = await fetch(url);
  if (!res.ok) return 0;
  const json = (await res.json()) as {
    balances?: { asset_type: string; asset_code?: string; asset_issuer?: string; balance: string }[];
  };
  const entry = (json.balances ?? []).find(
    (b) =>
      b.asset_code === "USDC" && b.asset_issuer === config.contracts.usdcIssuer,
  );
  return entry ? Number(entry.balance) : 0;
}

export function TestnetFaucetBar() {
  const { status, address } = useWallet();
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [botStatus, setBotStatus] = useState<"idle" | "loading" | "ok" | "err">("idle");

  const connected = status === "connected" && address !== null;

  const balanceQ = useQuery({
    queryKey: ["faucet-usdc-balance", address ?? ""],
    queryFn: () => fetchUsdcBalance(address!),
    enabled: connected && isTestnet() && !dismissed,
    refetchInterval: 15_000,
    staleTime: 10_000,
  });

  const hasEnough = (balanceQ.data ?? 0) >= USDC_THRESHOLD;

  function dismiss() {
    setDismissed(true);
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // ignore
    }
  }

  async function handleFriendbot() {
    if (address === null) return;
    setBotStatus("loading");
    try {
      const res = await fetch(
        `https://friendbot.stellar.org?addr=${encodeURIComponent(address)}`,
      );
      if (!res.ok && res.status !== 400) throw new Error(`HTTP ${res.status}`);
      // 400 means already funded — treat as success
      setBotStatus("ok");
      // Refetch balance after a short delay
      setTimeout(() => void balanceQ.refetch(), 2_000);
    } catch {
      setBotStatus("err");
    }
  }

  if (!isTestnet()) return null;
  if (!connected) return null;
  if (dismissed) return null;
  if (hasEnough) return null;

  return (
    <div className="relative flex items-center justify-between gap-3 border-b border-stella-gold/20 bg-stella-gold/5 px-4 py-2 text-[12px]">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="rounded bg-stella-gold/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-stella-gold">
          Testnet
        </span>
        <span className="text-white/70">
          {balanceQ.isLoading
            ? "Checking USDC balance…"
            : `You have $${(balanceQ.data ?? 0).toFixed(2)} USDC. Get testnet funds to start trading.`}
        </span>
        <button
          onClick={() => void handleFriendbot()}
          disabled={botStatus === "loading" || botStatus === "ok"}
          className="rounded border border-stella-gold/40 bg-stella-gold/10 px-3 py-1 text-[11px] font-semibold text-stella-gold hover:bg-stella-gold/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {botStatus === "loading"
            ? "Requesting…"
            : botStatus === "ok"
              ? "XLM sent ✓"
              : botStatus === "err"
                ? "Retry XLM"
                : "Get XLM from Friendbot"}
        </button>
        <Link
          to="/deposit?amount=500&asset=XLM"
          className="rounded border border-white/20 bg-white/5 px-3 py-1 text-[11px] font-semibold text-white/70 hover:text-white hover:bg-white/10 transition-colors"
        >
          Deposit USDC →
        </Link>
      </div>
      <button
        onClick={dismiss}
        className="shrink-0 text-white/30 hover:text-white/60 transition-colors"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
