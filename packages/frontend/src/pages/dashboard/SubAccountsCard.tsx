/**
 * Phase S — Sub-accounts card.
 *
 * Reads & mutates the user's sub-account USDC balance through `VaultClient`.
 * Sub-accounts are silo'd: their balances do NOT count toward
 * `getTotalCollateralValue` / margin. `subId` ≥ 1 is required (0 = master).
 *
 * Operations:
 *   • Deposit (master → sub)         → vault.depositSub(...)
 *   • Withdraw (sub → wallet)        → vault.withdrawSub(...)
 *   • Transfer between two sub-ids   → vault.transferBetweenSubs(...)
 */

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import clsx from "clsx";
import { Button } from "@/ui/Button";
import { formatUsd, fromFixed, toFixed } from "@/ui/format";
import { useTx } from "@/wallet";
import { getClients } from "@/stellar/clients";
import { config, hasContract } from "@/config";
import { qk } from "@/hooks/queries";
import type { InvokeResult } from "@stellax/sdk";

type Mode = "deposit" | "withdraw" | "transfer";

const PRECISION = 10n ** 18n;
const NATIVE_DECIMALS = 7n;

/** Convert 18-dec internal precision → 7-dec native USDC stroops. */
function internalToNative(internal: bigint): bigint {
  return internal / 10n ** (18n - NATIVE_DECIMALS);
}

export function SubAccountsCard() {
  const { run, pending, connected, address } = useTx();
  const [subId, setSubId] = useState(1);
  const [toSubId, setToSubId] = useState(2);
  const [mode, setMode] = useState<Mode>("deposit");
  const [amount, setAmount] = useState("");

  const balQ = useQuery({
    queryKey: qk.subBalance(address ?? "", subId),
    queryFn: () =>
        getClients().vault.getSubBalance(
        address as string,
        subId,
        config.contracts.usdcSac,
      ),
    retry: 1,
    enabled: address !== null && hasContract(config.contracts.vault) && subId >= 1,
    refetchInterval: 10_000,
  });

  const toBalQ = useQuery({
    queryKey: qk.subBalance(address ?? "", toSubId),
    queryFn: () =>
      getClients().vault.getSubBalance(
        address as string,
        toSubId,
        config.contracts.usdcSac,
      ),
    retry: 1,
    enabled:
      address !== null &&
      hasContract(config.contracts.vault) &&
      mode === "transfer" &&
      toSubId >= 1,
    refetchInterval: 15_000,
  });

  const balance = balQ.data ?? 0n;
  const parsed = toFixed(amount || "0"); // 18-dec internal precision

  const validSub = subId >= 1;
  const validToSub = toSubId >= 1 && toSubId !== subId;
  const canDeposit = mode === "deposit" && parsed > 0n && validSub;
  const canWithdraw = mode === "withdraw" && parsed > 0n && parsed <= balance && validSub;
  const canTransfer =
    mode === "transfer" && parsed > 0n && parsed <= balance && validSub && validToSub;
  const canSubmit =
    connected && !pending && (canDeposit || canWithdraw || canTransfer);

  function setMax() {
    if (mode === "withdraw" || mode === "transfer") {
      setAmount(fromFixed(balance).toString());
    }
  }

  async function submit() {
    if (!canSubmit || !address) return;
    const human = fromFixed(parsed).toFixed(2);
    const token = config.contracts.usdcSac;

    let label: string;
    let action: (source: string) => Promise<InvokeResult>;
    if (mode === "deposit") {
      label = `Deposit ${human} USDC → sub#${subId}`;
      action = (source) =>
        getClients().vault.depositSub(
          source,
          subId,
          token,
          internalToNative(parsed),
          { sourceAccount: source },
        );
    } else if (mode === "withdraw") {
      label = `Withdraw ${human} USDC ← sub#${subId}`;
      action = (source) =>
        getClients().vault.withdrawSub(
          source,
          subId,
          token,
          internalToNative(parsed),
          { sourceAccount: source },
        );
    } else {
      label = `Transfer ${human} USDC sub#${subId} → sub#${toSubId}`;
      action = (source) =>
        getClients().vault.transferBetweenSubs(
          source,
          subId,
          toSubId,
          token,
          internalToNative(parsed),
          { sourceAccount: source },
        );
    }

    await run(label, action, {
      invalidate: [
        qk.subBalance(address, subId),
        qk.subBalance(address, toSubId),
        qk.vaultBalance(address),
        qk.vaultTokenBalance(address, token),
        qk.accountHealth(address),
      ],
    });
    await Promise.all([
      balQ.refetch(),
      mode === "transfer" ? toBalQ.refetch() : Promise.resolve(),
    ]);
    setAmount("");
  }

  if (!hasContract(config.contracts.vault)) return null;

  return (
    <div className="glass-card flex flex-col h-full">
      <div className="border-b border-stella-gold/10 px-6 py-5">
        <h3 className="text-xl font-semibold text-white tracking-tight">
          Sub-accounts
        </h3>
        <p className="text-sm text-stella-gold mt-1 drop-shadow-md">
          Phase S · Silo'd USDC buckets
        </p>
      </div>

      <div className="flex-1 space-y-5 p-6">
        <div className="grid grid-cols-3 gap-2 items-end">
          <div className="col-span-2">
            <label className="text-xs uppercase tracking-wider text-stella-muted">
              Sub-account ID
            </label>
            <input
              type="number"
              min={1}
              value={subId}
              onChange={(e) => setSubId(Math.max(1, Number(e.target.value) || 1))}
              className="glass-input mt-1 px-3 num"
            />
          </div>
          <div className="text-right">
            <div className="text-[11px] uppercase tracking-wider text-stella-muted">
              Balance
            </div>
            <div className="num text-lg font-semibold text-stella-gold">
              {formatUsd(balance)}
            </div>
          </div>
        </div>

        <div className="flex gap-2 p-1 bg-[#0a0b10] rounded-xl border border-stella-border/50">
          {(["deposit", "withdraw", "transfer"] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={clsx(
                "flex-1 rounded-lg py-2 text-xs font-semibold tracking-wide capitalize transition-all",
                mode === m
                  ? "bg-stella-surface text-white shadow-md border border-stella-gold/20"
                  : "text-stella-muted hover:text-white",
              )}
            >
              {m}
            </button>
          ))}
        </div>

        {mode === "transfer" && (
          <div>
            <label className="text-xs uppercase tracking-wider text-stella-muted">
              Destination sub-id
            </label>
            <div className="flex items-center gap-2 mt-1">
              <input
                type="number"
                min={1}
                value={toSubId}
                onChange={(e) =>
                  setToSubId(Math.max(1, Number(e.target.value) || 1))
                }
                className="glass-input px-3 num flex-1"
              />
              <span className="text-xs text-stella-muted whitespace-nowrap">
                {toBalQ.data !== undefined ? formatUsd(toBalQ.data) : "—"}
              </span>
            </div>
            {!validToSub && (
              <p className="mt-1 text-xs text-stella-short">
                Destination must differ and be ≥ 1.
              </p>
            )}
          </div>
        )}

        <div>
          <div className="flex items-end justify-between mb-1">
            <label className="text-xs uppercase tracking-wider text-stella-muted">
              Amount
            </label>
            {(mode === "withdraw" || mode === "transfer") && (
              <span
                className="text-xs text-stella-muted cursor-pointer hover:text-white"
                onClick={setMax}
              >
                Max: {formatUsd(balance)}
              </span>
            )}
          </div>
          <div className="relative flex items-center">
            <input
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="glass-input pl-4 pr-16 num"
            />
            <div className="absolute right-4 text-stella-muted font-semibold">
              USDC
            </div>
          </div>
          {(mode === "withdraw" || mode === "transfer") && parsed > balance && (
            <p className="mt-1 text-xs text-stella-short">
              Exceeds sub#{subId} balance.
            </p>
          )}
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
              : mode === "deposit"
                ? `Deposit to sub#${subId}`
                : mode === "withdraw"
                  ? `Withdraw from sub#${subId}`
                  : `Transfer #${subId} → #${toSubId}`}
        </Button>

        <p className="text-[11px] text-stella-muted opacity-70 leading-relaxed">
          Sub-accounts are isolated from your master margin. Funds parked here
          are not counted as collateral.
          {PRECISION === 10n ** 18n ? "" : ""}
        </p>
      </div>
    </div>
  );
}
