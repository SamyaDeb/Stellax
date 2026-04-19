import { useState } from "react";
import clsx from "clsx";
import { Card, CardHeader, CardTitle } from "@/ui/Card";
import { Button } from "@/ui/Button";
import { Input } from "@/ui/Input";
import { formatUsd, toFixed, fromFixed, formatNumber } from "@/ui/format";
import { useTx } from "@/wallet";
import { getClients } from "@/stellar/clients";
import {
  qk,
  useCurrentEpoch,
  useUserShares,
  useVaultNav,
} from "@/hooks/queries";

type Mode = "deposit" | "withdraw";

/**
 * Structured vault card — users deposit USD-equivalent and receive
 * vault shares. Vault writes covered-calls at epoch start and settles
 * at epoch end, distributing premium pro-rata.
 */
export function StructuredVaultCard() {
  const { run, pending, connected, address } = useTx();
  const epochQ = useCurrentEpoch();
  const sharesQ = useUserShares(address);
  const navQ = useVaultNav();

  const [mode, setMode] = useState<Mode>("deposit");
  const [amount, setAmount] = useState("");
  const parsed = toFixed(amount || "0");

  const shares = sharesQ.data ?? 0n;
  const nav = navQ.data ?? 0n;
  const epoch = epochQ.data;

  // Share price = NAV / totalShares — we don't have totalShares here; skip.
  // Preview: depositing X gives proportional shares vs. total deposits.
  const canDeposit = mode === "deposit" && parsed > 0n;
  const canWithdraw = mode === "withdraw" && parsed > 0n && parsed <= shares;
  // Roll epoch: permissionless — anyone can call once epoch has expired but not settled.
  const canRollEpoch =
    connected &&
    !pending &&
    epoch !== undefined &&
    !epoch.settled &&
    epoch.endTime * 1000n < BigInt(Date.now());

  async function rollEpoch() {
    await run(
      "Roll epoch",
      (source) =>
        getClients().structured.rollEpoch({ sourceAccount: source }),
      {
        invalidate: [qk.currentEpoch(), qk.vaultNav()],
      },
    );
  }

  const canSubmit = connected && !pending && (canDeposit || canWithdraw);

  async function submit() {
    if (!canSubmit || !address) return;
    const label =
      mode === "deposit"
        ? `Deposit ${fromFixed(parsed).toFixed(2)} USD → vault`
        : `Redeem ${fromFixed(parsed).toFixed(4)} shares`;
    await run(
      label,
      (source) => {
        const client = getClients().structured;
        const opts = { sourceAccount: source };
        // Contract expects 7-decimal USDC native; UI uses 18-dec fixed-point.
        // Divide by 10^11 to convert: 1 USD (1e18) → 1_000_000_0 (1e7).
        const amount7dec = parsed / 10n ** 11n;
        return mode === "deposit"
          ? client.deposit(source, amount7dec, opts)
          : client.withdraw(source, parsed, opts); // withdraw takes shares (18-dec)
      },
      {
        invalidate: [
          qk.userShares(address),
          qk.vaultNav(),
          qk.currentEpoch(),
        ],
      },
    );
    setAmount("");
  }

  const epochStatus = epoch
    ? epoch.settled
      ? "Settled"
      : epoch.endTime * 1000n < BigInt(Date.now())
        ? "Expired · awaiting settle"
        : "Active"
    : "—";

  return (
    <Card padded={false}>
      <CardHeader>
        <CardTitle>Structured Vault · Covered Calls</CardTitle>
        <span
          className={clsx(
            "rounded px-2 py-0.5 text-xs",
            epoch?.settled
              ? "bg-stella-surface text-stella-muted"
              : "bg-stella-long/20 text-stella-long",
          )}
        >
          {epochStatus}
        </span>
      </CardHeader>
      <div className="space-y-4 p-4">
        <div className="grid grid-cols-2 gap-3 rounded-md bg-stella-bg px-3 py-3 text-xs">
          <Stat
            label="Your shares"
            value={formatNumber(shares)}
          />
          <Stat label="Vault NAV" value={formatUsd(nav)} />
          <Stat
            label="Epoch id"
            value={epoch ? `#${epoch.epochId}` : "—"}
          />
          <Stat
            label="Premium earned"
            value={epoch ? formatUsd(epoch.totalPremium) : "—"}
            tone="ok"
          />
        </div>

        {epoch && (
          <div className="space-y-1.5 rounded-md bg-stella-bg px-3 py-3 text-xs">
            <Row
              label="Epoch start"
              value={new Date(Number(epoch.startTime) * 1000).toLocaleString()}
            />
            <Row
              label="Epoch end"
              value={new Date(Number(epoch.endTime) * 1000).toLocaleString()}
            />
            <Row
              label="Total deposits"
              value={formatUsd(epoch.totalDeposits)}
            />
          </div>
        )}

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
          label={mode === "deposit" ? "Deposit amount" : "Shares to redeem"}
          suffix={mode === "deposit" ? "USD" : "shares"}
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />

        {mode === "withdraw" && parsed > shares && (
          <p className="text-xs text-stella-short">
            Exceeds your share balance.
          </p>
        )}

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
                ? "Deposit to vault"
                : "Redeem shares"}
        </Button>

        {canRollEpoch && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            disabled={pending}
            onClick={() => void rollEpoch()}
            title="Permissionless: settle the expired epoch and start a new one"
          >
            Roll epoch (expired · settle now)
          </Button>
        )}
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
  tone?: "ok";
}) {
  return (
    <div>
      <div className="text-stella-muted">{label}</div>
      <div
        className={clsx(
          "num mt-0.5 font-medium",
          tone === "ok" ? "text-stella-long" : "text-white",
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
