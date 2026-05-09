import { useState } from "react";
import { Card, CardHeader, CardTitle } from "@/ui/Card";
import { Button } from "@/ui/Button";
import { Input } from "@/ui/Input";
import { formatUsd, toFixed, fromFixed } from "@/ui/format";
import { useTx } from "@/wallet";
import { getClients } from "@/stellar/clients";
import {
  qk,
  useTreasuryPendingFees,
  useTreasuryBalance,
  useTreasuryStaker,
  useTreasuryInsuranceSent,
} from "@/hooks/queries";import { config } from "@/config";

/**
 * Treasury panel — shows the 60/20/20 fee split buckets for USDC and
 * provides Distribute + Collect Fee actions. Distribute is permissionless;
 * Collect Fee requires an authorized source to sign.
 *
 * Covers the treasury e2e test flow:
 *   collect_fee() → distribute() → get_pending_fees/get_treasury_balance/get_staker_balance
 */
export function TreasuryPanel() {
  const { run, pending, connected, address } = useTx();
  const token = config.contracts.usdcSac;

  const pendingFeesQ = useTreasuryPendingFees(token);
  const treasuryBalQ = useTreasuryBalance(token);
  const stakerBalQ = useTreasuryStaker(token);
  const insuranceSentQ = useTreasuryInsuranceSent(token);

  // Collect fee form (admin/test only — requires authorized source)
  const [collectAmount, setCollectAmount] = useState("");
  const collectParsed = toFixed(collectAmount || "0");
  const collect7dec = collectParsed / 10n ** 11n;

  async function distribute() {
    await run(
      "Distribute treasury fees",
      (source) =>
        getClients().treasury.distribute(token, { sourceAccount: source }),
      {
        invalidate: [
          qk.treasuryPendingFees(token),
          qk.treasuryBalance(token),
          qk.treasuryStaker(token),
          qk.treasuryInsuranceSent(token),
        ],
      },
    );
  }

  async function collectFee() {
    if (collect7dec <= 0n) return;
    await run(
      `Collect fee ${fromFixed(collectParsed).toFixed(2)} USDC`,
      (source) =>
        getClients().treasury.collectFee(source, token, collect7dec, {
          sourceAccount: source,
        }),
      {
        invalidate: [
          qk.treasuryPendingFees(token),
          qk.treasuryBalance(token),
          // collectFee pulls funds from the caller's vault/token balance.
          ...(address !== null
            ? [
                qk.vaultBalance(address),
                qk.vaultTokenBalance(address, token),
              ]
            : []),
        ],
      },
    );
    setCollectAmount("");
  }

  return (
    <Card padded={false}>
      <CardHeader>
        <CardTitle>Treasury</CardTitle>
        <span className="text-xs text-stella-muted">60/20/20 split · USDC</span>
      </CardHeader>
      <div className="space-y-4 p-4">
        <div className="grid grid-cols-2 gap-3 rounded-xl bg-black/30 px-4 py-4 text-xs border border-white/5">
          <Stat
            label="Pending fees"
            value={pendingFeesQ.data !== undefined ? formatUsd7(pendingFeesQ.data) : "—"}
            tone="warn"
          />
          <Stat
            label="Treasury bucket (20%)"
            value={treasuryBalQ.data !== undefined ? formatUsd7(treasuryBalQ.data) : "—"}
          />
          <Stat
            label="Staker bucket (20%)"
            value={stakerBalQ.data !== undefined ? formatUsd7(stakerBalQ.data) : "—"}
          />
          <Stat
            label="Insurance sent (60%)"
            value={insuranceSentQ.data !== undefined ? formatUsd7(insuranceSentQ.data) : "—"}
            tone="ok"
          />
        </div>

        <Button
          variant="primary"
          size="sm"
          className="w-full"
          disabled={!connected || pending}
          onClick={() => void distribute()}
        >
          {pending ? "Submitting…" : "Distribute pending fees"}
        </Button>

        <div className="space-y-2 border-t border-stella-gold/10 pt-3">
          <p className="text-xs text-stella-muted">
            Collect fee (authorized source only — for testnet use):
          </p>
          <div className="flex gap-2">
            <div className="flex-1">
              <Input
                label=""
                suffix="USD"
                inputMode="decimal"
                placeholder="0.00"
                value={collectAmount}
                onChange={(e) => setCollectAmount(e.target.value)}
              />
            </div>
            <div className="mt-0 flex items-end">
              <Button
                variant="ghost"
                size="sm"
                disabled={!connected || pending || collect7dec <= 0n}
                onClick={() => void collectFee()}
              >
                Collect
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

/** Treasury amounts are stored in 7-decimal USDC (native stroop-scale). */
function formatUsd7(v: bigint): string {
  const n = Number(v) / 1e7;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
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
        className={
          tone === "ok"
            ? "num mt-0.5 font-medium text-stella-long"
            : tone === "warn"
              ? "num mt-0.5 font-medium text-stella-accent"
              : "num mt-0.5 font-medium text-white"
        }
      >
        {value}
      </div>
    </div>
  );
}
