import { useState } from "react";
import clsx from "clsx";
import type { Market } from "@stellax/sdk";
import { Button } from "@/ui/Button";
import { Input } from "@/ui/Input";
import { Card } from "@/ui/Card";
import { toFixed, fromFixed, formatUsd } from "@/ui/format";
import { useTx } from "@/wallet";
import { getClients } from "@/stellar/clients";
import { qk, useMarkPrice, usePrice } from "@/hooks/queries";
import { useSessionStore } from "@/stores/sessionStore";
import { scValToNative } from "@stellar/stellar-sdk";

interface Props {
  market: Market;
  markPrice: bigint | undefined;
}

const DEFAULT_SLIPPAGE_BPS = 50; // 0.5%
/** Bypass the vAMM/oracle divergence slippage guard — required on testnet
 *  where the vAMM mark (~$100) diverges massively from the oracle price. */
const MAX_SLIPPAGE_BYPASS = 1_000_000_000;

export function OrderForm({ market, markPrice }: Props) {
  const { run, pending, connected, address } = useTx();
  const addPosition = useSessionStore((s) => s.addPosition);
  const markQ = useMarkPrice(market.marketId);
  const oracleQ = usePrice(market.baseAsset);

  // Use mark price when available and non-zero; fall back to oracle price.
  // This ensures the submit button is enabled even when the vAMM mark is
  // unavailable (e.g. first ledger after deployment, or simulation failure).
  const currentMark = (() => {
    if (markPrice !== undefined && markPrice > 0n) return markPrice;
    if (markQ.data !== undefined && markQ.data > 0n) return markQ.data;
    if (oracleQ.data?.price !== undefined && oracleQ.data.price > 0n)
      return oracleQ.data.price;
    return undefined;
  })();

  const [isLong, setIsLong] = useState(true);
  const [sizeUsd, setSizeUsd] = useState("");
  const [leverage, setLeverage] = useState(5);
  const [slippage, setSlippage] = useState(DEFAULT_SLIPPAGE_BPS);
  // On testnet the vAMM mark diverges from oracle by orders of magnitude.
  // Bypass the slippage guard by default so open_position doesn't revert.
  const [bypassSlippage, setBypassSlippage] = useState(true);
  const effectiveSlippage = bypassSlippage ? MAX_SLIPPAGE_BYPASS : slippage;

  const lev = Math.max(1, Math.min(market.maxLeverage, Math.floor(leverage)));
  const parsedSize = toFixed(sizeUsd || "0");
  const marginRequired =
    lev > 0 && parsedSize > 0n ? parsedSize / BigInt(lev) : 0n;
  const estPriceUsd = currentMark !== undefined ? fromFixed(currentMark) : 0;
  const estUnits =
    estPriceUsd > 0 ? fromFixed(parsedSize) / estPriceUsd : 0;

  const canSubmit =
    connected &&
    !pending &&
    parsedSize > 0n &&
    lev >= 1 &&
    currentMark !== undefined &&
    currentMark > 0n;

  async function submit() {
    if (!canSubmit || !address || currentMark === undefined) return;
    const side = isLong ? "Long" : "Short";
    const nowTs = BigInt(Math.floor(Date.now() / 1000));

    const result = await run(
      `${side} ${market.baseAsset} · ${lev}x`,
      (source) =>
        getClients().perpEngine.openPosition(
          source,
          market.marketId,
          parsedSize,
          isLong,
          lev,
          effectiveSlippage,
          { sourceAccount: source },
        ),
      {
        invalidate: [
          qk.userPositions(address ?? ""),
          qk.accountEquity(address ?? ""),
          qk.freeCollateral(address ?? ""),
          qk.vaultBalance(address ?? ""),
          qk.openInterest(market.marketId),
        ],
      },
    );

    // Persist the position to the session store so it appears in the table
    // without an indexer. The contract returns the new position_id as u64.
    if (result?.status === "SUCCESS" && result.returnValue !== undefined) {
      try {
        const positionId = BigInt(
          scValToNative(result.returnValue) as number | bigint,
        );
        addPosition({
          positionId,
          owner: address,
          marketId: market.marketId,
          size: parsedSize,
          entryPrice: currentMark,
          margin: marginRequired,
          leverage: lev,
          isLong,
          lastFundingIdx: 0n,
          openTimestamp: nowTs,
        });
      } catch {
        // Decode failed — position is on-chain but won't show in the table
      }
    }

    setSizeUsd("");
  }

  return (
    <Card>
      <div className="space-y-4">
        <div className="flex gap-2">
          <button
            onClick={() => setIsLong(true)}
            className={clsx(
              "flex-1 rounded-md py-2 text-sm font-medium transition-colors",
              isLong
                ? "bg-stella-long text-white"
                : "bg-stella-surface text-stella-muted hover:text-white",
            )}
          >
            Long
          </button>
          <button
            onClick={() => setIsLong(false)}
            className={clsx(
              "flex-1 rounded-md py-2 text-sm font-medium transition-colors",
              !isLong
                ? "bg-stella-short text-white"
                : "bg-stella-surface text-stella-muted hover:text-white",
            )}
          >
            Short
          </button>
        </div>

        <Input
          label="Notional size"
          suffix="USD"
          inputMode="decimal"
          placeholder="0.00"
          value={sizeUsd}
          onChange={(e) => setSizeUsd(e.target.value)}
        />

        <div className="space-y-1">
          <label className="text-xs text-stella-muted">
            Leverage · {lev}x (max {market.maxLeverage}x)
          </label>
          <input
            type="range"
            min={1}
            max={market.maxLeverage}
            step={1}
            value={lev}
            onChange={(e) => setLeverage(Number(e.target.value))}
            className="w-full accent-stella-accent"
          />
        </div>

        <div className="space-y-1.5">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-stella-muted">
            <input
              type="checkbox"
              checked={bypassSlippage}
              onChange={(e) => setBypassSlippage(e.target.checked)}
              className="accent-stella-accent"
            />
            Bypass oracle/vAMM slippage guard (required on testnet)
          </label>
          {!bypassSlippage && (
            <Input
              label="Max slippage (bps)"
              type="number"
              min={1}
              max={10000}
              value={slippage}
              onChange={(e) =>
                setSlippage(Number(e.target.value) || DEFAULT_SLIPPAGE_BPS)
              }
            />
          )}
        </div>

        <div className="space-y-1.5 rounded-md bg-stella-bg px-3 py-3 text-xs">
          <Row
            label="Mark price"
            value={
              currentMark !== undefined ? formatUsd(currentMark) : "—"
            }
          />
          <Row
            label="Est. units"
            value={estUnits > 0 ? estUnits.toFixed(6) : "—"}
          />
          <Row label="Margin required" value={formatUsd(marginRequired)} />
          <Row
            label="Maker fee"
            value={`${(market.makerFeeBps / 100).toFixed(2)}%`}
          />
          <Row
            label="Taker fee"
            value={`${(market.takerFeeBps / 100).toFixed(2)}%`}
          />
        </div>

        <Button
          variant={isLong ? "long" : "short"}
          size="lg"
          className="w-full"
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {pending
            ? "Submitting…"
            : !connected
              ? "Connect wallet"
              : `${isLong ? "Long" : "Short"} ${market.baseAsset}`}
        </Button>
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
