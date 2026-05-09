/**
 * Phase U — Treasury lending dashboard (admin-only writes).
 *
 * Reads:
 *   • treasury.getLendingPool()       → currently configured adapter
 *   • treasury.getLendingDeposited(USDC) → principal in adapter
 *
 * Writes (admin = `config.contracts.adminAddress`):
 *   • setLendingPool(addr)
 *   • depositToLending(USDC, amount)
 *   • withdrawFromLending(USDC, amount)
 *
 * Non-admin viewers see an info card explaining the feature.
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

type Action = "deposit" | "withdraw";

const NATIVE_DECIMALS = 7n;

function internalToNative(internal: bigint): bigint {
  return internal / 10n ** (18n - NATIVE_DECIMALS);
}

export function LendingCard() {
  const { run, pending, connected, address } = useTx();
  const [action, setAction] = useState<Action>("deposit");
  const [amount, setAmount] = useState("");
  const [poolAddr, setPoolAddr] = useState("");

  const isAdmin =
    address !== null && address === config.contracts.adminAddress;

  const poolQ = useQuery({
    queryKey: ["treasury-lending-pool"],
    queryFn: () => getClients().treasury.getLendingPool(),
    enabled: hasContract(config.contracts.treasury),
    refetchInterval: 30_000,
  });

  const depositedQ = useQuery({
    queryKey: ["treasury-lending-deposited", config.contracts.usdcSac],
    queryFn: () =>
      getClients().treasury.getLendingDeposited(config.contracts.usdcSac),
    enabled: hasContract(config.contracts.treasury),
    refetchInterval: 30_000,
  });

  if (!hasContract(config.contracts.treasury)) return null;

  const pool = poolQ.data ?? null;
  const deposited = depositedQ.data ?? 0n;
  const parsed = toFixed(amount || "0");

  const canSet = isAdmin && !pending && /^C[A-Z2-7]{55}$/.test(poolAddr);
  const canMove =
    isAdmin && !pending && pool !== null && parsed > 0n;

  async function setPool() {
    if (!canSet) return;
    await run(
      `Set lending pool → ${poolAddr.slice(0, 6)}…`,
      (source) =>
        getClients().treasury.setLendingPool(poolAddr, { sourceAccount: source }),
      { invalidate: [["treasury-lending-pool"], qk.vaultTotal()] },
    );
    setPoolAddr("");
  }

  async function moveFunds() {
    if (!canMove) return;
    const human = fromFixed(parsed).toFixed(2);
    const native = internalToNative(parsed);
    const label =
      action === "deposit"
        ? `Deposit ${human} USDC → lending`
        : `Withdraw ${human} USDC ← lending`;
    await run(
      label,
      (source) =>
        action === "deposit"
          ? getClients().treasury.depositToLending(
              config.contracts.usdcSac,
              native,
              { sourceAccount: source },
            )
          : getClients().treasury.withdrawFromLending(
              config.contracts.usdcSac,
              native,
              { sourceAccount: source },
            ),
      {
        invalidate: [
          ["treasury-lending-deposited", config.contracts.usdcSac],
          ["treasury-balance", config.contracts.usdcSac],
          qk.vaultTotal(),
          qk.treasuryStaker(config.contracts.usdcSac),
        ],
      },
    );
    setAmount("");
  }

  return (
    <div className="glass-card flex flex-col h-full">
      <div className="border-b border-stella-gold/10 px-6 py-5">
        <h3 className="text-xl font-semibold text-white tracking-tight">
          Treasury Lending
        </h3>
        <p className="text-sm text-stella-gold mt-1 drop-shadow-md">
          Phase U · Idle USDC → external yield
        </p>
      </div>

      <div className="flex-1 space-y-5 p-6">
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Pool" value={pool ? `${pool.slice(0, 6)}…${pool.slice(-4)}` : "Not set"} />
          <Stat label="Principal" value={formatUsd(deposited)} highlight />
        </div>

        {!connected && (
          <p className="text-sm text-stella-muted">
            Connect a wallet to use this card.
          </p>
        )}

        {connected && !isAdmin && (
          <div className="rounded-lg border border-stella-border/50 bg-[#0a0b10]/60 p-4 text-sm text-stella-muted leading-relaxed">
            Admin-only controls. Configure the lending adapter and route idle
            treasury USDC to it from the deployer key.
          </div>
        )}

        {connected && isAdmin && (
          <>
            <div className="space-y-2">
              <label className="text-xs uppercase tracking-wider text-stella-muted">
                Lending pool address
              </label>
              <input
                type="text"
                placeholder="C...."
                value={poolAddr}
                onChange={(e) => setPoolAddr(e.target.value.trim())}
                className="glass-input px-3 text-sm"
              />
              <Button
                variant="ghost"
                className="w-full h-9 border border-stella-border text-sm"
                disabled={!canSet}
                onClick={() => void setPool()}
              >
                {pool ? "Update lending pool" : "Set lending pool"}
              </Button>
            </div>

            <div className="flex gap-2 p-1 bg-[#0a0b10] rounded-xl border border-stella-border/50">
              {(["deposit", "withdraw"] as Action[]).map((a) => (
                <button
                  key={a}
                  onClick={() => setAction(a)}
                  className={clsx(
                    "flex-1 rounded-lg py-2 text-xs font-semibold capitalize transition-all",
                    action === a
                      ? "bg-stella-surface text-white border border-stella-gold/20"
                      : "text-stella-muted hover:text-white",
                  )}
                >
                  {a}
                </button>
              ))}
            </div>

            <div>
              <label className="text-xs uppercase tracking-wider text-stella-muted">
                Amount (USDC)
              </label>
              <div className="relative flex items-center mt-1">
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
            </div>

            <Button
              variant="primary"
              className="w-full h-11 text-base font-semibold shadow-xl"
              disabled={!canMove}
              onClick={() => void moveFunds()}
            >
              {pending
                ? "Submitting…"
                : pool === null
                  ? "Set pool first"
                  : action === "deposit"
                    ? "Deposit to lending"
                    : "Withdraw from lending"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={clsx(
        "rounded-xl border p-3",
        highlight
          ? "bg-stella-surface/80 border-stella-gold/20"
          : "bg-[#0a0b10]/60 border-stella-border/50",
      )}
    >
      <div className="text-[11px] uppercase tracking-wider text-stella-muted mb-1">
        {label}
      </div>
      <div
        className={clsx(
          "text-base font-semibold num truncate",
          highlight ? "text-stella-gold" : "text-white",
        )}
      >
        {value}
      </div>
    </div>
  );
}
