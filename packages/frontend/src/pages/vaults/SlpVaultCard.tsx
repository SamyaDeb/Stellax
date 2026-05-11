/**
 * SlpVaultCard — UI for the StellaX Stability Liquidity Provider (SLP) vault.
 *
 * Behaviour:
 *  • Deposit: calls `slpVault.deposit(user, amountNative)` — no approve needed
 *    because the SLP contract pulls USDC directly from the user's wallet.
 *  • Withdraw: calls `slpVault.withdraw(user, shares)` — shares burned in
 *    proportion to the amount entered. Blocked until cooldown expires.
 *  • Displays NAV / share, DEX price, user's share balance (converted to USDC),
 *    total TVL, share%, cooldown countdown, and a NAV sparkline.
 */

import { useState, useEffect } from "react";
import clsx from "clsx";
import { addToken } from "@stellar/freighter-api";
import { Button } from "@/ui/Button";
import { NavSparkline } from "@/ui/NavSparkline";
import { formatUsd, toFixed, fromFixed } from "@/ui/format";
import { useTx } from "@/wallet";
import { getClients } from "@/stellar/clients";
import {
  qk,
  useSlpNavPerShare,
  useSlpTotalAssets,
  useSlpTotalShares,
  useSlpShareBalance,
  useSlpUnlockAt,
} from "@/hooks/queries";
import { useSlpNavHistory } from "@/hooks/useSlpNavHistory";
import { useDexPrice } from "@/hooks/useDexPrice";
import { config } from "@/config";

const PRECISION = 10n ** 18n;
const NATIVE_DECIMALS = 10n ** 7n; // USDC 7-decimal

/** Convert 18-decimal internal to 7-decimal native (rounds down). */
function internalToNative(v: bigint): bigint {
  return v / (PRECISION / NATIVE_DECIMALS);
}

/** Format a cooldown unlock timestamp as a human-readable countdown. */
function formatCooldown(unlockAt: bigint): string {
  const remaining = Number(unlockAt) - Math.floor(Date.now() / 1000);
  if (remaining <= 0) return "Unlocked";
  const h = Math.floor(remaining / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Format a raw 18dp bigint as a share count string: "12.3456 sxSLP" */
function fmtShares(shares: bigint): string {
  const n = fromFixed(shares);
  // Show up to 6 decimal places, trim trailing zeros
  const str = n.toFixed(6).replace(/\.?0+$/, "");
  return `${str} sxSLP`;
}

type Mode = "deposit" | "withdraw";

export function SlpVaultCard() {
  const { run, pending, connected, address } = useTx();
  const [mode, setMode] = useState<Mode>("deposit");
  const [amount, setAmount] = useState("");
  const parsed = toFixed(amount || "0"); // 18-decimal

  // ── Remote data ──────────────────────────────────────────────────────────

  const navQ = useSlpNavPerShare();
  const totalAssetsQ = useSlpTotalAssets();
  const totalSharesQ = useSlpTotalShares();
  const sharesQ = useSlpShareBalance(address);
  const unlockQ = useSlpUnlockAt(address);
  const dexPriceQ = useDexPrice();
  const navHistory = useSlpNavHistory();

  // Countdown ticker — re-render every 30 s while locked.
  const [_tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // ── Derived values ────────────────────────────────────────────────────────

  const nav = navQ.data ?? PRECISION;
  const userShares = sharesQ.data ?? 0n;
  // True while the share-balance query is in-flight (initial load OR post-tx refetch).
  const sharesLoading = sharesQ.isFetching;
  // True when the query failed (e.g. RPC latency after deposit) and has no data yet.
  const sharesError = sharesQ.isError && userShares === 0n;
  // Show skeleton whenever we have no balance and the query is either loading or errored.
  const sharesBlank = (sharesLoading || sharesError) && userShares === 0n;
  const totalShares = totalSharesQ.data ?? 0n;
  const unlockAt = unlockQ.data ?? 0n;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const cooldownActive = unlockAt > now;

  /** User's balance in 18-decimal USDC equivalent: shares * nav / PRECISION */
  const userUsdcEquiv = userShares > 0n ? (userShares * nav) / PRECISION : 0n;

  /** User's share % of the total pool */
  const userSharePct =
    totalShares > 0n && userShares > 0n
      ? Number((userShares * 10000n) / totalShares) / 100
      : 0;

  /** Shares to burn for the amount entered (18-decimal input / nav per share). */
  const sharesToBurn =
    parsed > 0n && nav > 0n ? (parsed * PRECISION) / nav : 0n;

  const canDeposit = mode === "deposit" && parsed > 0n;
  const canWithdraw =
    mode === "withdraw" && parsed > 0n && sharesToBurn <= userShares && !cooldownActive;
  const canSubmit = connected && !pending && (canDeposit || canWithdraw);

  function setMax() {
    if (mode === "withdraw") {
      setAmount(fromFixed(userUsdcEquiv).toString());
    }
  }

  async function submit() {
    if (!canSubmit || !address) return;
    const label =
      mode === "deposit"
        ? `Deposit ${fromFixed(parsed).toFixed(2)} USDC into SLP Vault`
        : `Withdraw ${fromFixed(parsed).toFixed(2)} USDC from SLP Vault`;

    await run(
      label,
      (source) => {
        const client = getClients().slpVault;
        const opts = { sourceAccount: source };
        if (mode === "deposit") {
          const native = internalToNative(parsed);
          return client.deposit(source, native, opts);
        } else {
          return client.withdraw(source, sharesToBurn, opts);
        }
      },
      {
        invalidate: [
          qk.slpNavPerShare(),
          qk.slpTotalAssets(),
          qk.slpTotalShares(),
          qk.slpShareBalance(address),
          qk.slpUnlockAt(address),
        ],
      },
    );

    // After a successful deposit, register the sxSLP SEP-41 token in the
    // connected Freighter wallet so the balance appears immediately.
    // Freighter opens its native "Add Token" confirmation modal.
    // Errors are swallowed — the deposit already succeeded.
    if (mode === "deposit" && config.contracts.slpVault.length > 0) {
      try {
        await addToken({
          contractId: config.contracts.slpVault,
          networkPassphrase: config.network.passphrase,
        });
      } catch {
        // Freighter not installed or user dismissed — non-fatal.
      }
    }

    setAmount("");
  }

  // ── Formatted display values ──────────────────────────────────────────────

  // Change 2: NAV label is "price of 1 sxSLP"
  const fmtNav = `$${fromFixed(nav).toFixed(6)}`;
  const fmtTvl =
    totalAssetsQ.data !== undefined ? formatUsd(totalAssetsQ.data) : "—";

  // USD value of the user's sxSLP position (shares × NAV)
  const fmtPositionUsd =
    userShares > 0n
      ? formatUsd(userUsdcEquiv)
      : connected
        ? "$0.00"
        : "—";

  const dexPrice = dexPriceQ.data;
  const dexListed =
    dexPrice !== null && dexPrice !== undefined && dexPrice > 0n &&
    config.contracts.slpTokenCode.length > 0;

  return (
    <div className="glass-card flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-stella-gold/10 px-6 py-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h3 className="text-xl font-semibold text-white tracking-tight">SLP Vault</h3>
            <span className="rounded border border-stella-gold/30 bg-stella-gold/10 px-1.5 py-0.5 text-[10px] font-bold text-stella-gold">
              LP
            </span>
          </div>
          {/* NAV sparkline in header */}
          {navHistory.length >= 2 && (
            <NavSparkline
              points={navHistory.map((p) => p.nav)}
              width={80}
              height={28}
            />
          )}
        </div>
        <p className="text-sm text-stella-gold mt-1 drop-shadow-md">
          Stability Liquidity Provider — earn trading fees &amp; funding
        </p>
      </div>

      <div className="flex-1 space-y-6 p-6">

        {/* ── Change 2: Token price block — NAV labelled as sxSLP price ── */}
        <div className="rounded-xl border border-stella-gold/15 bg-stella-surface/40 p-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-stella-muted mb-1">
                sxSLP Price (NAV)
              </div>
              <div className="text-2xl font-bold num text-stella-gold">{fmtNav}</div>
              {/* Change 2: sub-label makes it unambiguous */}
              <div className="text-[11px] text-stella-muted mt-0.5">= price of 1 sxSLP</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-stella-muted mb-1">DEX Price</div>
              {dexListed ? (
                <>
                  <div className="text-2xl font-bold num text-white">
                    ${fromFixed(dexPrice!).toFixed(6)}
                  </div>
                  {navQ.data !== undefined && navQ.data > 0n && (
                    <div className={clsx(
                      "text-[11px] mt-0.5 font-semibold",
                      dexPrice! >= navQ.data ? "text-stella-long" : "text-stella-short",
                    )}>
                      {(() => {
                        const pct = Number((dexPrice! - navQ.data) * 10000n / navQ.data) / 100;
                        return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% vs NAV`;
                      })()}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="text-xl font-bold text-stella-muted">—</div>
                  <div className="text-[11px] text-stella-muted mt-0.5">not listed on DEX</div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* ── Change 1: Your sxSLP Position block ── */}
        {connected && (
          <div className={clsx(
            "rounded-xl border p-4",
            userShares > 0n
              ? "border-stella-gold/25 bg-stella-surface/60"
              : "border-stella-border/40 bg-[#0a0b10]/50",
          )}>
            <div className="text-[11px] uppercase tracking-wider text-stella-muted mb-2">
              Your sxSLP Position
            </div>
            <div className="flex items-end justify-between gap-2">
              {/* Left: token amount */}
              <div>
                {sharesBlank ? (
                  // In-flight or error with no prior balance — show skeleton
                  <>
                    <div className="h-8 w-36 rounded bg-stella-surface/60 animate-pulse mb-1" />
                    <div className="h-3 w-24 rounded bg-stella-surface/40 animate-pulse" />
                  </>
                ) : (
                  <>
                    <div className={clsx(
                      "text-2xl font-bold num transition-opacity",
                      userShares > 0n ? "text-white" : "text-stella-muted",
                      sharesLoading && "opacity-50 animate-pulse",
                    )}>
                      {userShares > 0n ? fmtShares(userShares) : "0 sxSLP"}
                    </div>
                    <div className="text-[11px] text-stella-muted mt-0.5">
                      {userShares > 0n
                        ? `${userSharePct.toFixed(3)}% of pool`
                        : "no position yet"}
                    </div>
                  </>
                )}
              </div>
              {/* Right: live USD value */}
              <div className="text-right">
                {sharesBlank ? (
                  <>
                    <div className="h-8 w-24 rounded bg-stella-surface/60 animate-pulse mb-1" />
                    <div className="h-3 w-20 rounded bg-stella-surface/40 animate-pulse" />
                  </>
                ) : (
                  <>
                    <div className={clsx(
                      "text-2xl font-bold num transition-opacity",
                      userShares > 0n ? "text-stella-gold" : "text-stella-muted",
                      sharesLoading && "opacity-50 animate-pulse",
                    )}>
                      {fmtPositionUsd}
                    </div>
                    <div className="text-[11px] text-stella-muted mt-0.5">
                      {userShares > 0n
                        ? `@ ${fmtNav} / sxSLP`
                        : "current value"}
                    </div>
                  </>
                )}
              </div>
            </div>
            {/* Syncing notice — shown when the RPC hasn't returned the balance yet */}
            {sharesError && (
              <div className="mt-3 flex items-center justify-between rounded-lg border border-stella-gold/20 bg-stella-gold/5 px-3 py-2">
                <span className="text-[11px] text-stella-gold">
                  Syncing balance from chain…
                </span>
                <button
                  onClick={() => void sharesQ.refetch()}
                  className="text-[11px] font-semibold text-stella-gold underline underline-offset-2 hover:opacity-80"
                >
                  Retry
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── Change 3: Stats row — TVL + Share% only (balance moved above) ── */}
        <div className="grid grid-cols-2 gap-3">
          <StatBox label="Total TVL" value={fmtTvl} />
          <StatBox
            label="Your Share %"
            value={userShares > 0n ? `${userSharePct.toFixed(3)}%` : "—"}
            {...(userShares > 0n ? { tone: "ok" as const } : {})}
          />
        </div>

        {/* Cooldown notice */}
        {cooldownActive && (
          <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/8 px-3 py-2 text-xs text-yellow-400">
            Withdrawal cooldown active — unlocks in{" "}
            <strong>{formatCooldown(unlockAt)}</strong>.
          </div>
        )}

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
                Max: {formatUsd(userUsdcEquiv)}
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
          {mode === "withdraw" && sharesToBurn > userShares && (
            <p className="absolute -bottom-6 left-0 text-xs text-stella-short font-medium">
              Exceeds share balance.
            </p>
          )}
          {mode === "withdraw" && cooldownActive && parsed > 0n && (
            <p className="absolute -bottom-6 left-0 text-xs text-yellow-400 font-medium">
              Cooldown not yet met.
            </p>
          )}
        </div>

        {/* ── Change 4: Info rows — current price + position rows added ── */}
        <div className="space-y-2 mt-4 pt-4 border-t border-stella-gold/5">
          {/* Change 4a: current price row */}
          <Row
            label="Current price"
            value={`${fmtNav} / sxSLP`}
            note="= NAV"
          />
          {/* Change 4b: your position in USD */}
          {connected && (
            <Row
              label="Your position value"
              value={userShares > 0n
                ? `${fmtShares(userShares)} = ${fmtPositionUsd}`
                : fmtPositionUsd}
            />
          )}
          <Row
            label="Total shares"
            value={totalShares > 0n ? fromFixed(totalShares).toFixed(4) : "—"}
          />
          <Row
            label="Cooldown status"
            value={unlockAt === 0n ? "—" : cooldownActive ? `Locked (${formatCooldown(unlockAt)})` : "Unlocked"}
          />
          <Row
            label="Strategy"
            value="Protocol counterparty pool — earns taker fees + funding"
            note="risk"
          />
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
                  ? "Deposit to SLP Vault"
                  : "Withdraw from SLP Vault"}
          </Button>
        </div>

        <p className="text-[10px] text-stella-muted leading-relaxed">
          SLP deposits are the protocol's counterparty pool. When traders are
          net profitable, LP NAV decreases; when traders lose, it increases.
          A {config.contracts.slpVault.length > 0 ? "1-hour" : "24-hour"}{" "}
          withdrawal cooldown applies. Skew-cap may temporarily block
          withdrawals when open interest exceeds NAV limits.
        </p>
      </div>
    </div>
  );
}

function StatBox({
  label,
  value,
  tone,
  highlight,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn";
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
          "text-lg font-semibold num",
          tone === "ok" && "text-stella-long",
          tone === "warn" && "text-stella-accent",
          !tone && highlight && "text-stella-gold",
          !tone && !highlight && "text-white",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-sm text-stella-muted">{label}</span>
      <span className="text-sm font-medium text-white num">
        {value}
        {note && (
          <span className="ml-1 text-[10px] text-stella-muted opacity-70">
            ({note})
          </span>
        )}
      </span>
    </div>
  );
}
