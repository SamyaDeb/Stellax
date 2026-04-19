import { useState } from "react";
import clsx from "clsx";
import { Card, CardHeader, CardTitle } from "@/ui/Card";
import { Button } from "@/ui/Button";
import { Input } from "@/ui/Input";
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

/**
 * Collateral vault card — user deposits USDC-equivalent collateral used
 * as margin by the perp engine. Withdrawals are limited to the free
 * balance (not locked as margin).
 */
export function CollateralVaultCard() {
  const { run, pending, connected, address } = useTx();
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

  async function submit() {
    if (!canSubmit || !address) return;
    const label =
      mode === "deposit"
        ? `Deposit ${fromFixed(parsed).toFixed(2)} USD`
        : `Withdraw ${fromFixed(parsed).toFixed(2)} USD`;
    await run(
      label,
      (source) => {
        const client = getClients().vault;
        const opts = { sourceAccount: source };
        const token = config.contracts.usdcSac;
        // UI amount is 18-decimal; vault expects 7-decimal USDC native.
        const amount7dec = parsed / 10n ** 11n;
        return mode === "deposit"
          ? client.deposit(source, token, amount7dec, opts)
          : client.withdraw(source, token, amount7dec, opts);
      },
      {
        invalidate: [
          qk.vaultBalance(address),
          qk.vaultTotal(),
          qk.freeCollateral(address),
          qk.accountEquity(address),
        ],
      },
    );
    setAmount("");
  }

  return (
    <Card padded={false}>
      <CardHeader>
        <CardTitle>Collateral Vault</CardTitle>
        <span className="text-xs text-stella-muted">Margin for perps</span>
      </CardHeader>
      <div className="space-y-4 p-4">
        <div className="grid grid-cols-3 gap-3 rounded-md bg-stella-bg px-3 py-3 text-xs">
          <Stat label="Your total" value={formatUsd(total)} />
          <Stat label="Free" value={formatUsd(free)} tone="ok" />
          <Stat label="Locked" value={formatUsd(locked)} tone="warn" />
        </div>

        <div className="flex gap-2">
          {(["deposit", "withdraw"] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={clsx(
                "flex-1 rounded-md py-2 text-sm font-medium capitalize transition-colors",
                mode === m
                  ? "bg-stella-surface text-white"
                  : "bg-stella-bg text-stella-muted hover:text-white",
              )}
            >
              {m}
            </button>
          ))}
        </div>

        <Input
          label={mode === "deposit" ? "Amount to deposit" : "Amount to withdraw"}
          suffix="USD"
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />

        {mode === "withdraw" && parsed > free && (
          <p className="text-xs text-stella-short">
            Exceeds free balance. Close positions to unlock margin.
          </p>
        )}

        <div className="space-y-1.5 rounded-md bg-stella-bg px-3 py-3 text-xs">
          <Row
            label="Free collateral (risk)"
            value={freeCollQ.data !== undefined ? formatUsd(freeCollQ.data) : "—"}
          />
          <Row
            label="Total vault TVL"
            value={totalQ.data !== undefined ? formatUsd(totalQ.data) : "—"}
          />
        </div>

        <Button
          variant="primary"
          size="lg"
          className="w-full"
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {pending
            ? "Submitting…"
            : !connected
              ? "Connect wallet"
              : mode === "deposit"
                ? "Deposit"
                : "Withdraw"}
        </Button>
      </div>
    </Card>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn";
}) {
  return (
    <div>
      <div className="text-stella-muted">{label}</div>
      <div
        className={clsx(
          "num mt-0.5 font-medium",
          tone === "ok" && "text-stella-long",
          tone === "warn" && "text-stella-accent",
          !tone && "text-white",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-stella-muted">{label}</span>
      <span className="num text-white">{value}</span>
    </div>
  );
}
