/**
 * Phase T — Atomic spot swap panel.
 *
 * Settles a matched spot trade between two parties via
 * `vault.atomicSwap(caller, partyA, partyB, tokenA, amountA, tokenB, amountB)`.
 *
 * Note: `caller` must be an authorized vault caller (CLOB / matching engine).
 * For the demo UX, this panel signs `partyA = connected user` and accepts a
 * pasted `partyB` address. Submitting requires the connected wallet to be
 * registered as an authorized caller — typically the keeper relayer.
 */

import { useState } from "react";
import { Button } from "@/ui/Button";
import { toFixed, fromFixed } from "@/ui/format";
import { useTx } from "@/wallet";
import { getClients } from "@/stellar/clients";
import { config, hasContract, isTestnet } from "@/config";
import { qk } from "@/hooks/queries";

export function SpotSwapPanel() {
  const { run, pending, connected, address } = useTx();

  const [partyB, setPartyB] = useState("");
  const [tokenA, setTokenA] = useState(config.contracts.usdcSac);
  const [amountA, setAmountA] = useState("");
  const [tokenB, setTokenB] = useState(config.contracts.stlxSac);
  const [amountB, setAmountB] = useState("");

  const parsedA = toFixed(amountA || "0");
  const parsedB = toFixed(amountB || "0");

  const validParty = /^[GC][A-Z2-7]{55}$/.test(partyB);
  const validTokens =
    /^C[A-Z2-7]{55}$/.test(tokenA) && /^C[A-Z2-7]{55}$/.test(tokenB);
  const canSubmit =
    connected &&
    !pending &&
    validParty &&
    validTokens &&
    parsedA > 0n &&
    parsedB > 0n &&
    address !== null;

  async function submit() {
    if (!canSubmit || !address) return;
    const aHuman = fromFixed(parsedA).toFixed(4);
    const bHuman = fromFixed(parsedB).toFixed(4);
    await run(
      `Spot swap ${aHuman} ↔ ${bHuman}`,
      (source) =>
        getClients().vault.atomicSwap(
          source, // caller (must be authorized)
          address as string, // partyA
          partyB,
          tokenA,
          parsedA,
          tokenB,
          parsedB,
          { sourceAccount: source },
        ),
      {
        invalidate: [
          qk.vaultBalance(address),
          qk.vaultTokenBalance(address, tokenA),
          qk.vaultTokenBalance(address, tokenB),
          qk.accountHealth(address),
        ],
      },
    );
  }

  if (!hasContract(config.contracts.vault) || !isTestnet()) return null;

  return (
    <div className="glass-card p-6 space-y-5">
      <div>
        <h3 className="text-xl font-semibold text-white tracking-tight">
          Spot Swap
        </h3>
        <p className="text-sm text-stella-gold mt-1 drop-shadow-md">
          Phase T · Atomic two-party token swap
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SwapLeg
          title="You give"
          token={tokenA}
          onTokenChange={setTokenA}
          amount={amountA}
          onAmountChange={setAmountA}
        />
        <SwapLeg
          title="You receive"
          token={tokenB}
          onTokenChange={setTokenB}
          amount={amountB}
          onAmountChange={setAmountB}
        />
      </div>

      <div>
        <label className="text-xs uppercase tracking-wider text-stella-muted">
          Counterparty (party B address)
        </label>
        <input
          type="text"
          placeholder="G... or C..."
          value={partyB}
          onChange={(e) => setPartyB(e.target.value.trim())}
          className="glass-input mt-1 px-3 text-sm"
        />
        {partyB.length > 0 && !validParty && (
          <p className="mt-1 text-xs text-stella-short">
            Invalid Stellar address.
          </p>
        )}
      </div>

      <div className="rounded-lg border border-stella-border/50 bg-[#0a0b10]/60 p-3 text-[11px] text-stella-muted leading-relaxed">
        Note: <code>caller</code> must be a vault-authorized address (CLOB or
        keeper relayer). If your wallet is not authorized this transaction
        will fail at simulation.
      </div>

      <Button
        variant="primary"
        className="w-full h-11 text-base font-semibold shadow-xl"
        disabled={!canSubmit}
        onClick={() => void submit()}
      >
        {pending
          ? "Submitting…"
          : !connected
            ? "Connect Wallet"
            : "Execute spot swap"}
      </Button>
    </div>
  );
}

function SwapLeg({
  title,
  token,
  onTokenChange,
  amount,
  onAmountChange,
}: {
  title: string;
  token: string;
  onTokenChange: (v: string) => void;
  amount: string;
  onAmountChange: (v: string) => void;
}) {
  const sym =
    token === config.contracts.usdcSac
      ? "USDC"
      : token === config.contracts.stlxSac
        ? "STLX"
        : "TOKEN";
  return (
    <div className="rounded-xl border border-stella-border/50 bg-[#0a0b10]/60 p-4 space-y-3">
      <div className="text-[11px] uppercase tracking-wider text-stella-muted">
        {title}
      </div>
      <div className="flex gap-2">
        <select
          value={
            token === config.contracts.usdcSac
              ? "usdc"
              : token === config.contracts.stlxSac
                ? "stlx"
                : "custom"
          }
          onChange={(e) => {
            if (e.target.value === "usdc") onTokenChange(config.contracts.usdcSac);
            else if (e.target.value === "stlx") onTokenChange(config.contracts.stlxSac);
            else onTokenChange("");
          }}
          className="glass-input px-3 text-sm w-24"
        >
          <option value="usdc">USDC</option>
          <option value="stlx">STLX</option>
          <option value="custom">Custom</option>
        </select>
        <input
          type="text"
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={(e) => onAmountChange(e.target.value)}
          className="glass-input pl-3 pr-3 num flex-1"
        />
      </div>
      {sym === "TOKEN" && (
        <input
          type="text"
          placeholder="Custom SAC address (C…)"
          value={token}
          onChange={(e) => onTokenChange(e.target.value.trim())}
          className="glass-input px-3 text-xs"
        />
      )}
    </div>
  );
}
