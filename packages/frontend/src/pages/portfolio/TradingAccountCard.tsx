/**
 * TradingAccountCard — full-page glass-card for managing perp trading margin.
 *
 * This card lives on the Portfolio page and is the single place users
 * deposit / withdraw collateral for perpetuals trading.
 *
 * The deposited USDC becomes trading margin that backs open positions.
 * It is NOT yield-bearing — to earn yield, use the SLP Vault on this page.
 */

import { useState } from "react";
import clsx from "clsx";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/ui/Button";
import { formatUsd, toFixed, fromFixed } from "@/ui/format";
import { useTx } from "@/wallet";
import { getClients } from "@/stellar/clients";
import {
  qk,
  useVaultBalance,
  useAccountHealth,
} from "@/hooks/queries";
import { config } from "@/config";

type Mode = "deposit" | "withdraw";

interface Props {
  address: string | null;
}

export function TradingAccountCard({ address }: Props) {
  const { run, pending, connected } = useTx();
  const qc = useQueryClient();

  const balanceQ = useVaultBalance(address);
  const healthQ  = useAccountHealth(address);

  const [mode, setMode]     = useState<Mode>("deposit");
  const [amount, setAmount] = useState("");
  const parsed = toFixed(amount || "0");

  const isLoading = balanceQ.isPending;
  const isError   = balanceQ.isError;

  const rawBalance = balanceQ.data?.free ?? 0n;
  const locked     = healthQ.data?.totalMarginRequired ?? 0n;
  const free       = rawBalance > locked ? rawBalance - locked : 0n;
  const total      = rawBalance;

  const fmtTotal  = isLoading ? "—" : isError ? "Err" : formatUsd(total);
  const fmtFree   = isLoading ? "—" : isError ? "Err" : formatUsd(free);
  const fmtLocked = isLoading ? "—" : isError ? "Err" : formatUsd(locked);

  const canWithdraw = mode === "withdraw" && parsed > 0n && parsed <= free;
  const canDeposit  = mode === "deposit"  && parsed > 0n;
  const canSubmit   = connected && !pending && (canDeposit || canWithdraw);

  function setMax() {
    if (mode === "withdraw") setAmount(fromFixed(free).toString());
  }

  async function submit() {
    if (!canSubmit || !address) return;
    const label =
      mode === "deposit"
        ? `Deposit ${fromFixed(parsed).toFixed(2)} USDC into Trading Account`
        : `Withdraw ${fromFixed(parsed).toFixed(2)} USDC from Trading Account`;

    const result = await run(
      label,
      (source) => {
        const client  = getClients().vault;
        const opts    = { sourceAccount: source };
        const token   = config.contracts.usdcSac;
        const amt7    = parsed / 10n ** 11n;
        return mode === "deposit"
          ? client.deposit(source, token, amt7, opts)
          : client.withdraw(source, token, amt7, opts);
      },
      {
        invalidate: [
          qk.vaultBalance(address),
          qk.vaultTokenBalance(address, config.contracts.usdcSac),
          qk.vaultTotal(),
          qk.accountHealth(address),
        ],
      },
    );

    if (result?.status === "SUCCESS") {
      qc.setQueryData<{ free: bigint; locked: bigint }>(
        qk.vaultBalance(address),
        (prev) => {
          const f = prev?.free ?? 0n;
          const l = prev?.locked ?? 0n;
          return mode === "deposit"
            ? { free: f + parsed, locked: l }
            : { free: f - parsed < 0n ? 0n : f - parsed, locked: l };
        },
      );
    }

    setAmount("");
  }

  return (
    <div className="glass-card flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-stella-gold/10 px-6 py-5">
        <div className="flex items-center gap-2">
          <h3 className="text-xl font-semibold text-white tracking-tight">
            Trading Account
          </h3>
          <span className="rounded border border-white/20 bg-white/5 px-1.5 py-0.5 text-[10px] font-bold text-stella-muted">
            MARGIN
          </span>
        </div>
        <p className="text-sm text-stella-muted mt-1">
          Deposit USDC to open perpetual positions with cross-margin
        </p>
      </div>

      <div className="flex-1 space-y-6 p-6">

        {/* Balance summary */}
        <div className="rounded-xl border border-white/8 bg-stella-surface/40 p-4">
          <div className="grid grid-cols-3 gap-4">
            <BalBox label="Total" value={fmtTotal} accent />
            <BalBox label="Free" value={fmtFree} tone="ok" />
            <BalBox label="Locked" value={fmtLocked} tone="warn" />
          </div>
          {isError && (
            <p className="mt-2 text-[11px] text-stella-short">
              Could not load balance — check connection.
            </p>
          )}
        </div>

        {/* What Free / Locked means */}
        <div className="space-y-1.5">
          <InfoRow label="Free" note="Available to trade or withdraw" />
          <InfoRow label="Locked" note="Reserved as margin for open positions" />
          <InfoRow label="Total" note="Free + Locked = your full account balance" />
        </div>

        {/* Mode toggle */}
        <div className="flex gap-2 p-1 bg-[#0a0b10] rounded-xl border border-stella-border/50">
          {(["deposit", "withdraw"] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={clsx(
                "flex-1 rounded-lg py-2.5 text-sm font-semibold tracking-wide capitalize transition-all",
                mode === m
                  ? "bg-stella-surface text-white shadow-md border border-stella-gold/20"
                  : "text-stella-muted hover:text-white",
              )}
            >
              {m}
            </button>
          ))}
        </div>

        {/* Amount input */}
        <div className="relative">
          <div className="flex justify-between items-end mb-2">
            <label className="text-xs font-medium uppercase tracking-wider text-stella-muted">
              {mode === "deposit" ? "Amount to deposit" : "Amount to withdraw"}
            </label>
            {mode === "withdraw" && (
              <span
                className="text-xs text-stella-muted cursor-pointer hover:text-white transition-colors"
                onClick={setMax}
              >
                Max: {fmtFree}
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
            <div className="absolute right-4 text-stella-muted font-semibold">USDC</div>
          </div>
          {mode === "withdraw" && parsed > free && parsed > 0n && (
            <p className="mt-1 text-xs text-stella-short font-medium">
              Exceeds free balance — close positions to unlock margin.
            </p>
          )}
        </div>

        {/* CTA */}
        <div className="pt-2">
          <Button
            variant="primary"
            className="w-full h-12 text-base font-semibold shadow-xl"
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {pending
              ? "Submitting to Stellar..."
              : !connected
                ? "Connect Wallet"
                : mode === "deposit"
                  ? "Deposit to Trading Account"
                  : "Withdraw from Trading Account"}
          </Button>
        </div>

        <p className="text-[10px] text-stella-muted leading-relaxed">
          Deposited USDC is your trading margin. It backs open perpetual
          positions and can be liquidated if your margin ratio falls below
          the maintenance threshold. It earns no yield — to earn fees and
          funding as a liquidity provider, use the SLP Vault.
        </p>
      </div>
    </div>
  );
}

function BalBox({
  label,
  value,
  tone,
  accent,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn";
  accent?: boolean;
}) {
  const color = tone === "ok"
    ? "text-stella-long"
    : tone === "warn"
      ? "text-stella-accent"
      : accent
        ? "text-stella-gold"
        : "text-white";
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-stella-muted mb-1">
        {label}
      </div>
      <div className={clsx("text-2xl font-bold num", color)}>{value}</div>
    </div>
  );
}

function InfoRow({ label, note }: { label: string; note: string }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-sm text-stella-muted">{label}</span>
      <span className="text-sm text-white/60">{note}</span>
    </div>
  );
}
