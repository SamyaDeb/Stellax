/**
 * StakingPage — Phase F / I.6
 *
 * STLX staking with epoch-based USDC rewards.
 *   - Stake / unstake STLX (7-dec SAC units)
 *   - Claim accrued rewards from closed epochs
 *   - Show current epoch, total staked, user's share, recent epoch pools
 *
 * All writes go through `useTx`; reads via staking query hooks.
 * Hidden when `config.contracts.staking` is empty.
 */

import { useMemo, useState } from "react";
import clsx from "clsx";
import { Button } from "@/ui/Button";
import { formatNumber, formatUsd } from "@/ui/format";
import { useTx } from "@/wallet";
import { getClients } from "@/stellar/clients";
import { config, hasContract } from "@/config";
import {
  qk,
  useStakingConfig,
  useStakingUser,
  useStakingCurrentEpoch,
  useStakingTotal,
  useStakingEpochPool,
} from "@/hooks/queries";

type Mode = "stake" | "unstake";

// STLX and USDC SACs both use 7 decimals on Stellar.
const STLX_DECIMALS = 7;
const USDC_DECIMALS = 7;

/** Convert human-string STLX amount → 7-dec bigint. */
function toStlxUnits(input: string): bigint {
  const s = input.trim();
  if (s === "" || Number.isNaN(Number(s))) return 0n;
  const [whole, frac = ""] = s.split(".");
  const padded = (frac + "0".repeat(STLX_DECIMALS)).slice(0, STLX_DECIMALS);
  return BigInt(whole || "0") * 10n ** BigInt(STLX_DECIMALS) + BigInt(padded || "0");
}

/** Convert 7-dec bigint → human-readable number. */
function fromStlxUnits(v: bigint): number {
  const denom = 10n ** BigInt(STLX_DECIMALS);
  const int = v / denom;
  const frac = v % denom;
  return Number(int) + Number(frac) / Number(denom);
}

function fromUsdcUnits(v: bigint): number {
  const denom = 10n ** BigInt(USDC_DECIMALS);
  const int = v / denom;
  const frac = v % denom;
  return Number(int) + Number(frac) / Number(denom);
}

export function StakingPage() {
  const { run, pending, connected, address } = useTx();
  const configQ = useStakingConfig();
  const stakeQ = useStakingUser(address);
  const epochQ = useStakingCurrentEpoch();
  const totalQ = useStakingTotal();

  const [mode, setMode] = useState<Mode>("stake");
  const [amount, setAmount] = useState("");

  if (!hasContract(config.contracts.staking)) {
    return (
      <div className="max-w-3xl mx-auto p-8">
        <div className="glass-card p-8 text-center">
          <h1 className="text-2xl font-semibold text-white mb-2">STLX Staking</h1>
          <p className="text-stella-muted">
            Staking is not yet deployed in this environment.
          </p>
        </div>
      </div>
    );
  }

  const userStake = stakeQ.data?.amount ?? 0n;
  const currentEpoch = epochQ.data ?? 0;
  const totalStaked = totalQ.data ?? 0n;
  const userStakeEpoch = stakeQ.data?.stakeEpoch ?? 0;
  const unstakeUnlocked = currentEpoch > userStakeEpoch;

  const share =
    totalStaked > 0n
      ? (Number(userStake) / Number(totalStaked)) * 100
      : 0;

  const parsed = toStlxUnits(amount);
  const canStake = mode === "stake" && parsed > 0n;
  const canUnstake =
    mode === "unstake" && parsed > 0n && parsed <= userStake && unstakeUnlocked;
  const canSubmit = connected && !pending && (canStake || canUnstake);

  function setMax() {
    if (mode === "unstake") setAmount(fromStlxUnits(userStake).toString());
  }

  async function submit() {
    if (!canSubmit || !address) return;
    const human = fromStlxUnits(parsed).toFixed(4);
    const label =
      mode === "stake" ? `Stake ${human} STLX` : `Unstake ${human} STLX`;
    await run(
      label,
      (source) => {
        const client = getClients().staking;
        const opts = { sourceAccount: source };
        return mode === "stake"
          ? client.stake(source, parsed, opts)
          : client.unstake(source, parsed, opts);
      },
      {
        invalidate: [
          qk.stakingUser(address),
          qk.stakingTotalStaked(),
          qk.stakingCurrentEpoch(),
        ],
      },
    );
    setAmount("");
  }

  async function claim() {
    if (!connected || !address || pending) return;
    await run(
      "Claim staking rewards",
      (source) => {
        const client = getClients().staking;
        return client.claimRewards(source, { sourceAccount: source });
      },
      {
        invalidate: [
          qk.stakingUser(address),
          qk.stakingCurrentEpoch(),
          qk.stakingTotalStaked(),
          // Rewards are paid in USDC — refresh vault token balance so the
          // wallet balance tile reflects the claim immediately.
          qk.vaultTokenBalance(address, config.contracts.usdcSac),
        ],
      },
    );
  }

  // Recent epoch pools: previous 5 closed epochs (requires currentEpoch ≥ 1).
  const recentEpochs = useMemo(() => {
    if (currentEpoch < 1) return [] as number[];
    const out: number[] = [];
    for (let i = 0; i < 5; i++) {
      const e = currentEpoch - 1 - i;
      if (e < 0) break;
      out.push(e);
    }
    return out;
  }, [currentEpoch]);

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-3xl font-semibold text-white tracking-tight">
            STLX Staking
          </h1>
          <p className="text-sm text-stella-muted mt-1">
            Stake STLX to earn a share of protocol revenue paid in USDC each epoch.
          </p>
        </div>
        <div className="text-right">
          <div className="text-[11px] uppercase tracking-wider text-stella-muted">
            Current epoch
          </div>
          <div className="text-2xl font-semibold text-stella-gold num">
            {currentEpoch}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ── Stake / Unstake card ── */}
        <div className="glass-card lg:col-span-2">
          <div className="border-b border-stella-gold/10 px-6 py-5">
            <h3 className="text-xl font-semibold text-white tracking-tight">
              Your Position
            </h3>
            <p className="text-sm text-stella-gold mt-1">
              Staked STLX · epoch-cooldown on unstake
            </p>
          </div>

          <div className="p-6 space-y-6">
            <div className="grid grid-cols-3 gap-3">
              <StatBox
                label="Your Stake"
                value={`${formatNumber(fromStlxUnits(userStake), 4)} STLX`}
                highlight
              />
              <StatBox
                label="Pool Share"
                value={`${share.toFixed(3)}%`}
                tone="ok"
              />
              <StatBox
                label="Stake Epoch"
                value={String(userStakeEpoch)}
                tone={unstakeUnlocked ? "ok" : "warn"}
              />
            </div>

            <div className="flex gap-2 p-1 bg-[#0a0b10] rounded-xl border border-stella-border/50">
              {(["stake", "unstake"] as Mode[]).map((m) => (
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
                  Amount to {mode}
                </label>
                {mode === "unstake" && userStake > 0n && (
                  <span
                    className="text-xs text-stella-muted cursor-pointer hover:text-white transition-colors"
                    onClick={setMax}
                  >
                    Max: {formatNumber(fromStlxUnits(userStake), 4)} STLX
                  </span>
                )}
              </div>
              <div className="relative flex items-center">
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="0.0000"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="glass-input pl-4 pr-20 num"
                />
                <div className="absolute right-4 text-stella-muted font-semibold">
                  STLX
                </div>
              </div>
              {mode === "unstake" && parsed > userStake && (
                <p className="absolute -bottom-6 left-0 text-xs text-stella-short font-medium">
                  Exceeds your staked balance.
                </p>
              )}
              {mode === "unstake" && !unstakeUnlocked && userStake > 0n && (
                <p className="absolute -bottom-6 left-0 text-xs text-stella-accent font-medium">
                  Unstake unlocks at epoch {userStakeEpoch + 1}.
                </p>
              )}
            </div>

            <div className="pt-6">
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
                    : mode === "stake"
                      ? "Stake STLX"
                      : "Unstake STLX"}
              </Button>
            </div>

            <div className="pt-4 border-t border-stella-gold/5">
              <Button
                variant="ghost"
                className="w-full h-11 font-semibold"
                disabled={!connected || pending || userStake === 0n}
                onClick={() => void claim()}
              >
                Claim Rewards (closed epochs)
              </Button>
              <p className="text-[11px] text-stella-muted mt-2 text-center">
                Claims accrued USDC from every fully-closed epoch since your last claim.
              </p>
            </div>
          </div>
        </div>

        {/* ── Protocol stats card ── */}
        <div className="glass-card">
          <div className="border-b border-stella-gold/10 px-6 py-5">
            <h3 className="text-xl font-semibold text-white tracking-tight">
              Protocol
            </h3>
            <p className="text-sm text-stella-gold mt-1">
              Stakers pool · epoch-indexed rewards
            </p>
          </div>
          <div className="p-6 space-y-3">
            <Row
              label="Total staked"
              value={`${formatNumber(fromStlxUnits(totalStaked), 2)} STLX`}
            />
            <Row
              label="Epoch duration"
              value={
                configQ.data
                  ? `${Number(configQ.data.epochDurationSecs) / 3600}h`
                  : "—"
              }
            />
            <Row label="Current epoch" value={String(currentEpoch)} />
            <Row
              label="Reward token"
              value={configQ.data ? "USDC" : "—"}
              {...(configQ.data ? { note: "treasury funded" } : {})}
            />
          </div>
        </div>
      </div>

      {/* ── Recent epochs ── */}
      <div className="glass-card">
        <div className="border-b border-stella-gold/10 px-6 py-4 flex items-baseline justify-between">
          <h3 className="text-lg font-semibold text-white tracking-tight">
            Recent Epoch Rewards
          </h3>
          <span className="text-xs text-stella-muted">
            last 5 closed epochs
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-stella-muted border-b border-stella-gold/10">
                <th className="px-6 py-3 font-medium">Epoch</th>
                <th className="px-6 py-3 font-medium">Reward Pool</th>
                <th className="px-6 py-3 font-medium">Claimed</th>
                <th className="px-6 py-3 font-medium">Staked Snapshot</th>
                <th className="px-6 py-3 font-medium text-right">Your Share</th>
              </tr>
            </thead>
            <tbody>
              {recentEpochs.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-6 py-8 text-center text-stella-muted"
                  >
                    No closed epochs yet.
                  </td>
                </tr>
              ) : (
                recentEpochs.map((e) => (
                  <EpochRow
                    key={e}
                    epoch={e}
                    userStake={userStake}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function EpochRow({ epoch, userStake }: { epoch: number; userStake: bigint }) {
  const poolQ = useStakingEpochPool(epoch);
  const pool = poolQ.data;

  if (!pool) {
    return (
      <tr className="border-b border-stella-gold/5">
        <td className="px-6 py-3 num text-white">{epoch}</td>
        <td className="px-6 py-3 text-stella-muted" colSpan={4}>
          Loading…
        </td>
      </tr>
    );
  }

  const share =
    pool.totalStaked > 0n && userStake > 0n
      ? (Number(userStake) / Number(pool.totalStaked)) *
        fromUsdcUnits(pool.rewardAmount)
      : 0;

  return (
    <tr className="border-b border-stella-gold/5 hover:bg-stella-surface/30 transition-colors">
      <td className="px-6 py-3 num text-white">{epoch}</td>
      <td className="px-6 py-3 num text-stella-gold">
        {formatUsd(fromUsdcUnits(pool.rewardAmount))}
      </td>
      <td className="px-6 py-3 num text-stella-muted">
        {formatUsd(fromUsdcUnits(pool.claimedAmount))}
      </td>
      <td className="px-6 py-3 num text-stella-muted">
        {formatNumber(fromStlxUnits(pool.totalStaked), 2)} STLX
      </td>
      <td className="px-6 py-3 num text-right text-stella-long">
        {share > 0 ? formatUsd(share) : "—"}
      </td>
    </tr>
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
