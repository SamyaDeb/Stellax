import { useMemo, useState } from "react";
import clsx from "clsx";
import { Card, CardHeader, CardTitle } from "@/ui/Card";
import { Button } from "@/ui/Button";
import { Input } from "@/ui/Input";
import { formatUsd, toFixed, fromFixed } from "@/ui/format";
import { useTx } from "@/wallet";
import { getClients } from "@/stellar/clients";
import {
  qk,
  useOptionsMarkets,
  useImpliedVol,
  usePrice,
} from "@/hooks/queries";
import { bsPrice } from "@/lib/blackScholes";
import { useSessionStore } from "@/stores/sessionStore";
import { scValToNative } from "@stellar/stellar-sdk";

interface Props {
  underlying: string | null;
  onUnderlyingChange: (u: string) => void;
}

/**
 * Option writer panel. User picks underlying, strike, expiry, size, side,
 * gets a live Black-Scholes premium estimate, and calls `create_option`.
 *
 * Premium is computed client-side via Black-Scholes using:
 *   - Spot price from the oracle
 *   - IV from `get_implied_volatility`
 *   - Risk-free rate hardcoded to 5% p.a.
 */
export function OptionWriterPanel({ underlying, onUnderlyingChange }: Props) {
  const { run, pending, connected, address } = useTx();
  const marketsQ = useOptionsMarkets();
  const ivQ = useImpliedVol(underlying);
  const priceQ = usePrice(underlying);
  const addOption = useSessionStore((s) => s.addOption);

  const [isCall, setIsCall] = useState(true);
  const [strike, setStrike] = useState("");
  const [size, setSize] = useState("1");
  const [expiryDays, setExpiryDays] = useState(7);

  const strikeFixed = toFixed(strike || "0");
  const sizeFixed = toFixed(size || "0");
  const expiryTs = BigInt(
    Math.floor(Date.now() / 1000) + expiryDays * 86_400,
  );

  const quoteReady =
    strikeFixed > 0n && sizeFixed > 0n && underlying !== null;

  const spot = priceQ.data?.price;

  // Black-Scholes premium estimate (client-side, no on-chain call).
  // iv comes back as a percentage (e.g. 80 for 80%) → divide by 100 for BS.
  const bsPremiumFixed: bigint = useMemo(() => {
    if (!quoteReady || spot === undefined) return 0n;
    const spotNum = fromFixed(spot);
    const strikeNum = fromFixed(strikeFixed);
    if (spotNum <= 0 || strikeNum <= 0) return 0n;
    const nowSec = Math.floor(Date.now() / 1000);
    const timeYears = (Number(expiryTs) - nowSec) / (365.25 * 86_400);
    const vol = (ivQ.data ?? 80) / 100; // fallback to 80% if IV not yet loaded
    const premiumPerUnit = bsPrice(spotNum, strikeNum, timeYears, vol, isCall);
    if (premiumPerUnit <= 0) return 0n;
    // Scale by size and convert to 18-dec: premiumPerUnit × size
    // sizeFixed is in 18-dec, so totalPremium = premiumPerUnit (float) × sizeFixed
    const totalFloat = premiumPerUnit * fromFixed(sizeFixed);
    // Convert float → 18-dec bigint via string to avoid precision loss
    const totalStr = totalFloat.toFixed(8);
    return toFixed(totalStr);
  }, [quoteReady, spot, strikeFixed, sizeFixed, expiryTs, ivQ.data, isCall]);

  const moneyness = useMemo(() => {
    if (spot === undefined || strikeFixed === 0n) return null;
    const s = fromFixed(spot);
    const k = fromFixed(strikeFixed);
    if (s === 0) return null;
    const pct = ((k - s) / s) * 100;
    return { s, k, pct };
  }, [spot, strikeFixed]);

  const canSubmit =
    connected &&
    !pending &&
    quoteReady &&
    spot !== undefined; // spot loaded = we can compute a premium

  async function submit() {
    if (!canSubmit || !address || underlying === null) return;
    const result = await run(
      `Write ${isCall ? "CALL" : "PUT"} ${underlying} @ ${fromFixed(strikeFixed).toFixed(2)}`,
      (source) =>
        getClients().options.createOption({
          writer: source,
          underlying,
          strike: strikeFixed,
          expiry: expiryTs,
          isCall,
          size: sizeFixed,
          premium: bsPremiumFixed,
          opts: { sourceAccount: source },
        }),
      {
        invalidate: [
          qk.optionsList(address, "writer"),
          qk.vaultBalance(address),
        ],
      },
    );
    // After success, persist the option ID to the session store so it appears
    // in OptionsPortfolio without needing an indexer.
    if (result?.status === "SUCCESS" && result.returnValue !== undefined) {
      try {
        const optionId = BigInt(scValToNative(result.returnValue) as number | bigint);
        addOption({ optionId, role: "writer", underlying: underlying ?? "?" });
      } catch {
        // returnValue decode failed — option still written, just won't appear in portfolio
      }
    }
    setStrike("");
  }

  return (
    <Card padded={false}>
      <CardHeader>
        <CardTitle>Write option</CardTitle>
        <span className="text-xs text-stella-muted">
          IV:{" "}
          {ivQ.data !== undefined
            ? `${ivQ.data.toFixed(1)}%`
            : "—"}
        </span>
      </CardHeader>
      <div className="space-y-4 p-4">
        <div>
          <label className="mb-1 block text-xs text-stella-muted">
            Underlying
          </label>
          <div className="flex flex-wrap gap-1.5">
            {(marketsQ.data ?? []).map((m) => (
              <button
                key={m}
                onClick={() => onUnderlyingChange(m)}
                className={clsx(
                  "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                  m === underlying
                    ? "bg-stella-accent text-stella-bg"
                    : "bg-stella-bg text-stella-muted hover:text-white",
                )}
              >
                {m}
              </button>
            ))}
            {marketsQ.data?.length === 0 && (
              <span className="text-xs text-stella-muted">
                No options markets configured
              </span>
            )}
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => setIsCall(true)}
            className={clsx(
              "flex-1 rounded-md py-2 text-sm font-medium",
              isCall
                ? "bg-stella-long text-white"
                : "bg-stella-bg text-stella-muted hover:text-white",
            )}
          >
            Call
          </button>
          <button
            onClick={() => setIsCall(false)}
            className={clsx(
              "flex-1 rounded-md py-2 text-sm font-medium",
              !isCall
                ? "bg-stella-short text-white"
                : "bg-stella-bg text-stella-muted hover:text-white",
            )}
          >
            Put
          </button>
        </div>

        <Input
          label="Strike"
          suffix="USD"
          inputMode="decimal"
          placeholder="0.00"
          value={strike}
          onChange={(e) => setStrike(e.target.value)}
        />

        <Input
          label="Size"
          suffix="units"
          inputMode="decimal"
          placeholder="1"
          value={size}
          onChange={(e) => setSize(e.target.value)}
        />

        <div className="space-y-1">
          <label className="text-xs text-stella-muted">
            Expiry · {expiryDays}d
          </label>
          <input
            type="range"
            min={1}
            max={90}
            step={1}
            value={expiryDays}
            onChange={(e) => setExpiryDays(Number(e.target.value))}
            className="w-full accent-stella-accent"
          />
        </div>

        <div className="space-y-1.5 rounded-md bg-stella-bg px-3 py-3 text-xs">
          <Row
            label="Spot"
            value={spot !== undefined ? formatUsd(spot) : "—"}
          />
          {moneyness !== null && (
            <Row
              label="Moneyness"
              value={`${moneyness.pct >= 0 ? "+" : ""}${moneyness.pct.toFixed(2)}%`}
            />
          )}
          <Row
            label="BS premium (est.)"
            value={
              bsPremiumFixed > 0n
                ? formatUsd(bsPremiumFixed)
                : spot === undefined
                  ? "Waiting for oracle…"
                  : "—"
            }
          />
          <Row
            label="Expires"
            value={new Date(Number(expiryTs) * 1000).toLocaleString()}
          />
        </div>

        <Button
          variant={isCall ? "long" : "short"}
          size="lg"
          className="w-full"
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {pending
            ? "Submitting…"
            : !connected
              ? "Connect wallet"
              : spot === undefined
                ? "Waiting for oracle price…"
                : `Write ${isCall ? "CALL" : "PUT"}`}
        </Button>
        <p className="text-[10px] text-stella-muted">
          Premium estimated via Black-Scholes · {(ivQ.data ?? 80).toFixed(0)}% IV · 5% risk-free rate
        </p>
      </div>
    </Card>
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
