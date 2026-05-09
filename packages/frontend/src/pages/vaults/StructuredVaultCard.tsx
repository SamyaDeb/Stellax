import { useState } from "react";
import clsx from "clsx";
import { Button } from "@/ui/Button";
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

  const canDeposit = mode === "deposit" && parsed > 0n;
  const canWithdraw = mode === "withdraw" && parsed > 0n && parsed <= shares;

  const canRollEpoch =
    connected &&
    !pending &&
    epoch !== undefined &&
    !epoch.settled &&
    epoch.endTime * 1000n < BigInt(Date.now());

  function setMax() {
    if (mode === "withdraw") {
      setAmount(fromFixed(shares).toString());
    }
  }

  async function rollEpoch() {
    await run(
      "Roll epoch",
      (source) =>
        getClients().structured.rollEpoch({ sourceAccount: source }),
      {
        invalidate: [qk.currentEpoch(), qk.vaultNav(), qk.userShares(address ?? "")],
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
        const amount7dec = parsed / 10n ** 11n;
        return mode === "deposit"
          ? client.deposit(source, amount7dec, opts)
          : client.withdraw(source, parsed, opts);
      },
      {
        invalidate: [
          qk.userShares(address),
          qk.vaultNav(),
          qk.currentEpoch(),
          qk.vaultBalance(address),
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
        : "Active Vault"
    : "—";

  return (
    <div className="glass-card flex flex-col h-full">
      <div className="border-b border-stella-gold/10 px-6 py-5 flex items-center justify-between">
        <div>
          <h3 className="text-xl font-semibold text-white tracking-tight">Yield Vault</h3>
          <p className="text-sm text-stella-gold mt-1 drop-shadow-md">Covered Calls</p>
        </div>
        <span
          className={clsx(
            "rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-wider",
            epoch?.settled
              ? "bg-[#1e2030] text-stella-muted"
              : "bg-stella-long/10 text-stella-long border border-stella-long/20 shadow-[0_0_10px_rgba(46,189,133,0.2)]",
          )}
        >
          {epochStatus}
        </span>
      </div>

      <div className="flex-1 space-y-6 p-6">
        <div className="grid grid-cols-2 gap-3">
          <StatBox label="Your Shares" value={formatNumber(shares)} highlight />
          <StatBox label="Vault NAV" value={formatUsd(nav)} />
          <StatBox label="Epoch ID" value={epoch ? `#${epoch.epochId}` : "—"} />
          <StatBox label="Premium Earned" value={epoch ? formatUsd(epoch.totalPremium) : "—"} tone="ok" />
        </div>

        {epoch && (
          <div className="space-y-2 py-3 border-y border-stella-gold/5">
            <Row label="Epoch start" value={new Date(Number(epoch.startTime) * 1000).toLocaleString()} />
            <Row label="Epoch end" value={new Date(Number(epoch.endTime) * 1000).toLocaleString()} />
            <Row label="Total deposits" value={formatUsd(epoch.totalDeposits)} />
          </div>
        )}

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
              {mode === "deposit" ? "Deposit amount" : "Shares to redeem"}
            </label>
            {mode === "withdraw" && (
              <span className="text-xs text-stella-muted cursor-pointer hover:text-white transition-colors" onClick={setMax}>
                Max: {formatNumber(shares)}
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
              className="glass-input pl-4 pr-20 num"
            />
            <div className="absolute right-4 text-stella-muted font-semibold">
              {mode === "deposit" ? "USD" : "SHARES"}
            </div>
          </div>
          {mode === "withdraw" && parsed > shares && (
            <p className="absolute -bottom-6 left-0 text-xs text-stella-short font-medium">
              Exceeds your share balance.
            </p>
          )}
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
                  ? "Deposit to Vault"
                  : "Redeem Shares"}
          </Button>

          {canRollEpoch && (
            <Button
              variant="ghost"
              className="w-full mt-3 h-10 border border-stella-border"
              disabled={pending}
              onClick={() => void rollEpoch()}
            >
              Roll epoch (expired · settle now)
            </Button>
          )}
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

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-sm text-stella-muted">{label}</span>
      <span className="text-sm font-medium text-white num">{value}</span>
    </div>
  );
}
