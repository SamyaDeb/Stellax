/**
 * SlpAdminPage — HLP vault operations panel.
 *
 * Accessible at /admin/slp. Not linked in the main nav.
 * Visible to anyone who navigates to the URL but write actions require the
 * connected wallet to be the vault admin (contracts enforce this on-chain).
 *
 * Panels:
 *   1. Vault state  — live read-only metrics
 *   2. HLP wiring   — perp + risk → SLP vault cross-check
 *   3. Operations   — admin_credit_assets, sweep_fees, set caps, manage callers
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { config } from "@/config";
import { useWallet } from "@/wallet";
import { useTx } from "@/wallet";
import { getClients } from "@/stellar/clients";
import { fromFixed, formatUsd, PRECISION } from "@/ui/format";
import {
  useSlpNavPerShare,
  useSlpTotalAssets,
  useSlpTotalShares,
} from "@/hooks/queries";

// ─── Local helpers ────────────────────────────────────────────────────────────

const NATIVE_UNIT = 10_000_000n; // 7-dec (1 USDC = 10_000_000)

function nativeFromInput(s: string): bigint {
  const f = parseFloat(s);
  if (!isFinite(f) || f <= 0) return 0n;
  return BigInt(Math.round(f * 7_000_000)) / 700n; // 7-dec
}

function internalFromInput(s: string): bigint {
  const f = parseFloat(s);
  if (!isFinite(f) || f <= 0) return 0n;
  return BigInt(Math.round(f * 1e6)) * (PRECISION / 1_000_000n);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-white/5 last:border-0">
      <span className="text-xs text-stella-muted">{label}</span>
      <span className="text-xs font-mono text-white">{value}</span>
    </div>
  );
}

function SectionHeader({ title, badge }: { title: string; badge?: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <h2 className="text-sm font-semibold text-white">{title}</h2>
      {badge !== undefined && (
        <span className="rounded border border-stella-accent/40 bg-stella-accent/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-stella-accent">
          {badge}
        </span>
      )}
    </div>
  );
}

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={clsx("rounded-xl border border-white/10 bg-white/5 p-5", className)}>
      {children}
    </div>
  );
}

// ─── Vault state panel ────────────────────────────────────────────────────────

function VaultStatePanel() {
  const navPerShare = useSlpNavPerShare();
  const totalAssets = useSlpTotalAssets();
  const totalShares = useSlpTotalShares();

  const configQ = useQuery({
    queryKey: ["slp-config"],
    queryFn: () => getClients().slpVault.getConfig(),
    refetchInterval: 30_000,
  });

  const callersQ = useQuery({
    queryKey: ["slp-authorized-callers"],
    queryFn: () => getClients().slpVault.getAuthorizedCallers(),
    refetchInterval: 60_000,
  });

  const nav = navPerShare.data;
  const assets = totalAssets.data;
  const shares = totalShares.data;
  const cfg = configQ.data;
  const callers = callersQ.data;

  const navDisplay = nav !== undefined ? fromFixed(nav).toFixed(6) : "…";
  const assetsDisplay = assets !== undefined ? formatUsd(assets) : "…";
  const sharesDisplay = shares !== undefined ? fromFixed(shares).toFixed(4) : "…";

  const cooldownH =
    cfg !== undefined
      ? (Number(cfg.cooldownSecs) / 3600).toFixed(2) + " h"
      : "…";
  const skewCap =
    cfg !== undefined ? (cfg.skewCapBps / 100).toFixed(2) + "%" : "…";
  const maxCap =
    cfg !== undefined ? formatUsd(cfg.maxVaultCap) : "…";

  return (
    <Card>
      <SectionHeader title="Vault State" />
      <StatRow label="NAV / share" value={navDisplay} />
      <StatRow label="Total assets (USDC)" value={assetsDisplay} />
      <StatRow label="Total shares" value={sharesDisplay} />
      {cfg !== undefined && (
        <>
          <StatRow label="Admin" value={<span className="truncate max-w-[180px] block">{cfg.admin}</span>} />
          <StatRow label="Keeper" value={<span className="truncate max-w-[180px] block">{cfg.keeper}</span>} />
          <StatRow label="Treasury" value={<span className="truncate max-w-[180px] block">{cfg.treasury}</span>} />
          <StatRow label="Cooldown" value={cooldownH} />
          <StatRow label="Skew cap" value={skewCap} />
          <StatRow label="Max vault cap" value={maxCap} />
          <StatRow
            label="Perp market IDs"
            value={cfg.perpMarketIds.length > 0 ? cfg.perpMarketIds.join(", ") : "none"}
          />
        </>
      )}
      {callers !== undefined && (
        <div className="mt-3">
          <p className="text-[11px] text-stella-muted mb-1">Authorized HLP callers</p>
          {callers.length === 0 ? (
            <p className="text-xs text-yellow-400">No authorized callers configured!</p>
          ) : (
            <ul className="space-y-0.5">
              {callers.map((c) => (
                <li key={c} className="text-[11px] font-mono text-stella-muted truncate">
                  {c}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

// ─── HLP wiring panel ────────────────────────────────────────────────────────

function HlpWiringPanel() {
  const perpSlpQ = useQuery({
    queryKey: ["perp-slp-vault"],
    queryFn: () => getClients().perpEngine.getSlpVault(),
    refetchInterval: 60_000,
  });
  const riskSlpQ = useQuery({
    queryKey: ["risk-slp-vault"],
    queryFn: () => getClients().risk.getSlpVault(),
    refetchInterval: 60_000,
  });

  const expected = config.contracts.slpVault;
  const perpAddr = perpSlpQ.data;
  const riskAddr = riskSlpQ.data;

  function StatusBadge({ addr }: { addr: string | undefined }) {
    if (addr === undefined) return <span className="text-yellow-400 text-xs">not set</span>;
    const ok = addr === expected;
    return (
      <span className={clsx("text-xs font-mono", ok ? "text-green-400" : "text-red-400")}>
        {addr.slice(0, 8)}…{addr.slice(-6)}
        {ok ? " ✓" : " ✗ MISMATCH"}
      </span>
    );
  }

  return (
    <Card>
      <SectionHeader title="HLP Wiring" />
      <StatRow label="Expected (config.slpVault)" value={<span className="font-mono text-[11px]">{expected.slice(0, 8)}…{expected.slice(-6)}</span>} />
      <StatRow label="perp_engine.get_slp_vault()" value={<StatusBadge addr={perpAddr} />} />
      <StatRow label="risk.get_slp_vault()" value={<StatusBadge addr={riskAddr} />} />
    </Card>
  );
}

// ─── Operations panel ─────────────────────────────────────────────────────────

function OpsPanel() {
  const { run, pending } = useTx();

  // Input state
  const [creditAmount, setCreditAmount] = useState("");
  const [sweepAmount, setSweepAmount] = useState("");
  const [cooldownSecs, setCooldownSecs] = useState("");
  const [skewBps, setSkewBps] = useState("");
  const [maxCapAmt, setMaxCapAmt] = useState("");
  const [addCaller, setAddCaller] = useState("");
  const [rmCaller, setRmCaller] = useState("");

  async function handleAdminCredit() {
    const amt = internalFromInput(creditAmount);
    if (amt <= 0n) return;
    await run("Admin credit assets", (src) =>
      getClients().slpVault.adminCreditAssets(amt, { sourceAccount: src }),
    );
  }

  async function handleSweepFees() {
    const f = parseFloat(sweepAmount);
    if (!isFinite(f) || f <= 0) return;
    const amt = BigInt(Math.round(f * Number(NATIVE_UNIT))) / 1n;
    await run("Sweep fees", (src) =>
      getClients().slpVault.sweepFees(amt, { sourceAccount: src }),
    );
  }

  async function handleSetCooldown() {
    const secs = parseInt(cooldownSecs, 10);
    if (!isFinite(secs) || secs < 0) return;
    await run(`Set cooldown → ${secs}s`, (src) =>
      getClients().slpVault.setCooldownSecs(BigInt(secs), { sourceAccount: src }),
    );
  }

  async function handleSetSkewCap() {
    const bps = parseInt(skewBps, 10);
    if (!isFinite(bps) || bps < 0) return;
    await run(`Set skew cap → ${bps} bps`, (src) =>
      getClients().slpVault.setSkewCapBps(bps, { sourceAccount: src }),
    );
  }

  async function handleSetMaxCap() {
    const amt = internalFromInput(maxCapAmt);
    if (amt <= 0n) return;
    await run("Set max vault cap", (src) =>
      getClients().slpVault.setMaxVaultCap(amt, { sourceAccount: src }),
    );
  }

  async function handleAddCaller() {
    const addr = addCaller.trim();
    if (!addr) return;
    await run(`Add caller ${addr.slice(0, 6)}…`, (src) =>
      getClients().slpVault.addAuthorizedCaller(addr, { sourceAccount: src }),
    );
  }

  async function handleRmCaller() {
    const addr = rmCaller.trim();
    if (!addr) return;
    await run(`Remove caller ${addr.slice(0, 6)}…`, (src) =>
      getClients().slpVault.removeAuthorizedCaller(addr, { sourceAccount: src }),
    );
  }

  const inputCls = "w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white placeholder-stella-muted focus:outline-none focus:border-stella-accent/60";
  const btnCls = (disabled: boolean) =>
    clsx(
      "rounded-lg px-4 py-2 text-xs font-semibold transition-colors",
      disabled
        ? "bg-white/10 text-stella-muted cursor-not-allowed"
        : "bg-stella-accent text-black hover:bg-stella-accent/80",
    );

  return (
    <Card>
      <SectionHeader title="Operations" badge="Admin-only on-chain" />

      {/* Admin credit assets */}
      <div className="mb-5">
        <p className="text-[11px] text-stella-muted mb-1.5">
          Admin credit assets — add to TotalAssets without token movement (18-dec USDC)
        </p>
        <div className="flex gap-2">
          <input
            className={inputCls}
            placeholder="Amount USDC (e.g. 100)"
            value={creditAmount}
            onChange={(e) => setCreditAmount(e.target.value)}
          />
          <button
            className={btnCls(pending || !creditAmount)}
            disabled={pending || !creditAmount}
            onClick={() => void handleAdminCredit()}
          >
            Credit
          </button>
        </div>
      </div>

      {/* Sweep fees */}
      <div className="mb-5">
        <p className="text-[11px] text-stella-muted mb-1.5">
          Sweep fees — pull USDC from treasury sub-account into vault (7-dec native)
        </p>
        <div className="flex gap-2">
          <input
            className={inputCls}
            placeholder="Amount USDC (e.g. 10)"
            value={sweepAmount}
            onChange={(e) => setSweepAmount(e.target.value)}
          />
          <button
            className={btnCls(pending || !sweepAmount)}
            disabled={pending || !sweepAmount}
            onClick={() => void handleSweepFees()}
          >
            Sweep
          </button>
        </div>
      </div>

      {/* Set cooldown */}
      <div className="mb-5">
        <p className="text-[11px] text-stella-muted mb-1.5">
          Set cooldown (seconds) — testnet default 3600 (1 h), mainnet 86400 (24 h)
        </p>
        <div className="flex gap-2">
          <input
            className={inputCls}
            placeholder="Seconds (e.g. 3600)"
            value={cooldownSecs}
            onChange={(e) => setCooldownSecs(e.target.value)}
          />
          <button
            className={btnCls(pending || !cooldownSecs)}
            disabled={pending || !cooldownSecs}
            onClick={() => void handleSetCooldown()}
          >
            Set
          </button>
        </div>
      </div>

      {/* Set skew cap */}
      <div className="mb-5">
        <p className="text-[11px] text-stella-muted mb-1.5">
          Set skew cap (bps) — max OI/NAV ratio before withdrawals block. 0 = disabled.
        </p>
        <div className="flex gap-2">
          <input
            className={inputCls}
            placeholder="BPS (e.g. 5000 = 50%)"
            value={skewBps}
            onChange={(e) => setSkewBps(e.target.value)}
          />
          <button
            className={btnCls(pending || !skewBps)}
            disabled={pending || !skewBps}
            onClick={() => void handleSetSkewCap()}
          >
            Set
          </button>
        </div>
      </div>

      {/* Set max vault cap */}
      <div className="mb-5">
        <p className="text-[11px] text-stella-muted mb-1.5">
          Set max vault cap (USDC) — total deposits ceiling. Must be &gt; 0.
        </p>
        <div className="flex gap-2">
          <input
            className={inputCls}
            placeholder="Amount USDC (e.g. 1000000)"
            value={maxCapAmt}
            onChange={(e) => setMaxCapAmt(e.target.value)}
          />
          <button
            className={btnCls(pending || !maxCapAmt)}
            disabled={pending || !maxCapAmt}
            onClick={() => void handleSetMaxCap()}
          >
            Set
          </button>
        </div>
      </div>

      {/* Authorized callers */}
      <div className="border-t border-white/10 pt-4 space-y-4">
        <div>
          <p className="text-[11px] text-stella-muted mb-1.5">Add authorized caller</p>
          <div className="flex gap-2">
            <input
              className={inputCls}
              placeholder="Contract address (C…)"
              value={addCaller}
              onChange={(e) => setAddCaller(e.target.value)}
            />
            <button
              className={btnCls(pending || !addCaller.trim())}
              disabled={pending || !addCaller.trim()}
              onClick={() => void handleAddCaller()}
            >
              Add
            </button>
          </div>
        </div>

        <div>
          <p className="text-[11px] text-stella-muted mb-1.5">Remove authorized caller</p>
          <div className="flex gap-2">
            <input
              className={inputCls}
              placeholder="Contract address (C…)"
              value={rmCaller}
              onChange={(e) => setRmCaller(e.target.value)}
            />
            <button
              className={btnCls(pending || !rmCaller.trim())}
              disabled={pending || !rmCaller.trim()}
              onClick={() => void handleRmCaller()}
            >
              Remove
            </button>
          </div>
        </div>
      </div>
    </Card>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function SlpAdminPage() {
  return (
    <div className="mx-auto max-w-[900px] space-y-8 px-4 py-8">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold text-white tracking-tight">
            SLP Vault
          </h1>
          <span className="rounded border border-stella-accent/40 bg-stella-accent/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-stella-accent">
            Admin
          </span>
        </div>
        <p className="text-sm text-stella-muted max-w-xl">
          HLP vault operations. Read panels update live; write actions require the
          connected wallet to be the vault admin. All on-chain values are in
          18-decimal USDC unless noted.
        </p>
        <p className="text-[11px] text-stella-muted/60">
          This page is not linked in the main navigation.
        </p>
      </header>

      <div className="grid gap-6 md:grid-cols-2">
        <VaultStatePanel />
        <div className="space-y-6">
          <HlpWiringPanel />
        </div>
      </div>

      <OpsPanel />
    </div>
  );
}
