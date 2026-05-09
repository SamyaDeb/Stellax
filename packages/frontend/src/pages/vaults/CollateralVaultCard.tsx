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
  useVaultTotal,
  useFreeCollateral,
} from "@/hooks/queries";
import { config } from "@/config";

type Mode = "deposit" | "withdraw";

export function CollateralVaultCard() {
  const { run, pending, connected, address } = useTx();
  const qc = useQueryClient();
  const balanceQ = useVaultBalance(address);
  const totalQ = useVaultTotal();
  const freeCollQ = useFreeCollateral(address);

  const [mode, setMode] = useState<Mode>("deposit");
  const [amount, setAmount] = useState("");
  const parsed = toFixed(amount || "0");

  const free = balanceQ.data?.free ?? 0n;
  const locked = balanceQ.data?.locked ?? 0n;
  const total = free + locked;

  const canWithdraw = mode === "withdraw" && parsed > 0n && parsed <= free;
  const canDeposit = mode === "deposit" && parsed > 0n;
  const canSubmit = connected && !pending && (canDeposit || canWithdraw);

  function setMax() {
    if (mode === "withdraw") {
      setAmount(fromFixed(free).toString());
    }
  }

  async function submit() {
    if (!canSubmit || !address) return;
    const label =
      mode === "deposit"
        ? `Deposit ${fromFixed(parsed).toFixed(2)} USD`
        : `Withdraw ${fromFixed(parsed).toFixed(2)} USD`;
    const result = await run(
      label,
      (source) => {
        const client = getClients().vault;
        const opts = { sourceAccount: source };
        const token = config.contracts.usdcSac;
        const amount7dec = parsed / 10n ** 11n;
        return mode === "deposit"
          ? client.deposit(source, token, amount7dec, opts)
          : client.withdraw(source, token, amount7dec, opts);
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

    // Optimistic cache update — instantly reflect the balance change so the
    // user doesn't wait for the next RPC poll cycle to see the new value.
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
      <div className="border-b border-stella-gold/10 px-6 py-5">
        <h3 className="text-xl font-semibold text-white tracking-tight">Collateral Vault</h3>
        <p className="text-sm text-stella-gold mt-1 drop-shadow-md">Perpetuals Margin Layer</p>
      </div>
      
      <div className="flex-1 space-y-6 p-6">
        <div className="grid grid-cols-3 gap-3">
          <StatBox label="Your Total" value={formatUsd(total)} highlight />
          <StatBox label="Free" value={formatUsd(free)} tone="ok" />
          <StatBox label="Locked" value={formatUsd(locked)} tone="warn" />
        </div>

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

        <div className="relative">
          <div className="flex justify-between items-end mb-2">
            <label className="text-xs font-medium uppercase tracking-wider text-stella-muted">
              {mode === "deposit" ? "Amount to deposit" : "Amount to withdraw"}
            </label>
            {mode === "withdraw" && (
              <span className="text-xs text-stella-muted cursor-pointer hover:text-white transition-colors" onClick={setMax}>
                Max: {formatUsd(free)}
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
            <div className="absolute right-4 text-stella-muted font-semibold">USD</div>
          </div>
          {mode === "withdraw" && parsed > free && (
            <p className="absolute -bottom-6 left-0 text-xs text-stella-short font-medium">
              Exceeds free balance. Close positions to unlock margin.
            </p>
          )}
        </div>

        <div className="space-y-2 mt-4 pt-4 border-t border-stella-gold/5">
          <Row label="Free collateral (risk)" value={freeCollQ.data !== undefined ? formatUsd(freeCollQ.data) : "—"} />
          <Row label="Total vault TVL" value={totalQ.data !== undefined ? formatUsd(totalQ.data) : "—"} note="simulated" />
        </div>

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
                  ? "Deposit Collateral"
                  : "Withdraw Collateral"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function StatBox({ label, value, tone, highlight }: { label: string; value: string; tone?: "ok" | "warn"; highlight?: boolean }) {
  return (
    <div className={clsx("rounded-xl border p-3", highlight ? "bg-stella-surface/80 border-stella-gold/20" : "bg-[#0a0b10]/60 border-stella-border/50")}>
      <div className="text-[11px] uppercase tracking-wider text-stella-muted mb-1">{label}</div>
      <div className={clsx("text-lg font-semibold num", tone === "ok" && "text-stella-long", tone === "warn" && "text-stella-accent", (!tone && highlight) && "text-stella-gold", (!tone && !highlight) && "text-white")}>
        {value}
      </div>
    </div>
  );
}

function Row({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-sm text-stella-muted">{label}</span>
      <span className="text-sm font-medium text-white num">
        {value}
        {note && <span className="ml-1 text-[10px] text-stella-muted opacity-70">({note})</span>}
      </span>
    </div>
  );
}
