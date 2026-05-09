import { useState } from "react";
import clsx from "clsx";
import type { Market } from "@stellax/sdk";
import { Button } from "@/ui/Button";
import { Input } from "@/ui/Input";
import { Card } from "@/ui/Card";
import { toFixed, fromFixed, formatUsd } from "@/ui/format";
import { useTx } from "@/wallet";
import { getClients } from "@/stellar/clients";
import { qk, useMarkPrice, usePrice, useFreeCollateral } from "@/hooks/queries";
import { useSessionStore } from "@/stores/sessionStore";
import { scValToNative } from "@stellar/stellar-sdk";
import { config, hasContract } from "@/config";
import { MAINTENANCE_MARGIN_RATIO } from "@/constants";
import { buildOrderCanonicalHash, signOrderHash } from "@/stellar/clobOrderSign";

interface Props {
  market: Market;
  markPrice: bigint | undefined;
}

const DEFAULT_SLIPPAGE_BPS = 500; // 5% — wide enough for testnet skew
const LEVERAGE_PRESETS = [1, 2, 5, 10, 20] as const;
/** Default limit-order TTL — 1h. */
const DEFAULT_LIMIT_TTL_SECS = 3600;
/** 18-decimal fixed-point precision for USD→base-asset size conversion. */
const FIXED_PRECISION = 10n ** 18n;

/** Label shown on the submit button for each submission phase. */
type SubmitPhase = "idle" | "signing" | "confirming";

type OrderMode = "market" | "limit";

// ── Confirmation dialog ────────────────────────────────────────────────────

interface ConfirmDialogProps {
  market: Market;
  isLong: boolean;
  sizeUsd: string;
  leverage: number;
  mark: bigint | undefined;
  margin: bigint;
  liqPrice: number | undefined;
  mode: OrderMode;
  limitPrice?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmDialog({
  market,
  isLong,
  sizeUsd,
  leverage,
  mark,
  margin,
  liqPrice,
  mode,
  limitPrice,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const parsedSize = toFixed(sizeUsd || "0");
  const side = isLong ? "Long" : "Short";
  const sideColor = isLong ? "text-stella-long" : "text-stella-short";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="card w-full max-w-sm mx-4 p-5 shadow-2xl">
        <h2 className="text-base font-semibold text-white mb-1">
          Confirm {mode === "limit" ? "Limit Order" : "Order"}
        </h2>
        <p className="text-xs text-stella-muted mb-4">
          Review before submitting to the blockchain.
        </p>

        <div className="rounded-lg border border-white/10 bg-black/30 p-3 space-y-2 text-xs">
          <DialogRow label="Market" value={`${market.baseAsset}-${market.quoteAsset}`} />
          <DialogRow
            label="Direction"
            value={
              <span className={sideColor}>
                {side} · {leverage}x
              </span>
            }
          />
          <DialogRow label="Notional size" value={formatUsd(parsedSize)} />
          {mode === "limit" && limitPrice !== undefined && (
            <DialogRow label="Limit price" value={`$${limitPrice}`} />
          )}
          {mode === "market" && (
            <DialogRow label="Est. entry" value={mark !== undefined ? formatUsd(mark) : "—"} />
          )}
          <DialogRow label="Margin required" value={formatUsd(margin)} />
          {liqPrice !== undefined && (
            <DialogRow
              label="Est. liq. price"
              value={
                <span className="text-stella-short">
                  ${liqPrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              }
            />
          )}
          <DialogRow
            label={mode === "limit" ? "Maker fee" : "Taker fee"}
            value={`${((mode === "limit" ? market.makerFeeBps : market.takerFeeBps) / 100).toFixed(2)}%`}
          />
          <div className="border-t border-white/5 pt-2 mt-1">
            <DialogRow
              label="Network fee"
              value={
                <span className="text-stella-muted">
                  ~0.001 XLM{" "}
                  <span className="opacity-50 text-[10px]">($0.0001)</span>
                </span>
              }
            />
          </div>
        </div>

        <p className="mt-3 text-[10px] text-stella-muted">
          {mode === "limit"
            ? "Your limit order will rest on-chain until matched by the keeper or cancelled."
            : "Prices may change before the transaction confirms. Network fee covers Soroban compute; the position fee is charged by the vault."}
        </p>

        <div className="mt-4 flex gap-2">
          <Button
            variant="ghost"
            size="md"
            className="flex-1"
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            variant={isLong ? "long" : "short"}
            size="md"
            className="flex-1"
            onClick={onConfirm}
          >
            Confirm {side}
          </Button>
        </div>
      </div>
    </div>
  );
}

function DialogRow({
  label,
  value,
}: {
  label: string;
  value: string | React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-stella-muted">{label}</span>
      <span className="num text-white">{value}</span>
    </div>
  );
}

// ── Error message helpers ──────────────────────────────────────────────────

/**
 * Map raw Soroban HostError strings to human-readable messages.
 *
 * Vault error codes (contract CDDA3Q…):
 *   #10 — InsufficientFreeCollateral
 *   #11 — MarginAccountNotFound
 *   #12 — PositionNotFound
 *
 * PerpEngine error codes (contract CD3PV6…):
 *   #1  — MarketNotFound
 *   #2  — MarketNotActive
 *   #3  — InvalidLeverage
 *   #4  — InvalidSize
 *   #5  — MaxOIExceeded
 *   #6  — SlippageExceeded
 */
function friendlyContractError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  // Soroban compute budget exceeded (openPosition calls oracle → vault → risk-engine)
  if (/Error\(Budget,\s*ExceededLimit\)/i.test(raw) || /budget.*exceeded/i.test(raw))
    return "Transaction exceeded compute budget — try reducing position size or try again.";
  // Vault: InsufficientFreeCollateral
  if (/Error\(Contract,\s*#10\)/.test(raw))
    return "Insufficient collateral — deposit more USDC before trading.";
  // Vault: margin account not found (first-time deposit not done)
  if (/Error\(Contract,\s*#11\)/.test(raw))
    return "Margin account not found — please deposit collateral first.";
  // PerpEngine errors
  if (/Error\(Contract,\s*#1\)/.test(raw)) return "Market not found.";
  if (/Error\(Contract,\s*#2\)/.test(raw)) return "Market is currently paused.";
  if (/Error\(Contract,\s*#3\)/.test(raw))
    return `Invalid leverage — max is ${raw.includes("max") ? raw : "50"}x.`;
  if (/Error\(Contract,\s*#4\)/.test(raw)) return "Invalid size — must be greater than zero.";
  if (/Error\(Contract,\s*#5\)/.test(raw)) return "Open interest cap reached for this market.";
  if (/Error\(Contract,\s*#6\)/.test(raw))
    return "Slippage exceeded — price moved too far. Try increasing slippage tolerance.";
  // User rejected in Freighter
  if (/user rejected/i.test(raw)) return "Transaction cancelled.";
  // Generic fallback — truncate the raw message so it stays readable
  return raw.length > 120 ? `${raw.slice(0, 120)}…` : raw;
}

// ── OrderForm ──────────────────────────────────────────────────────────────

export function OrderForm({ market, markPrice }: Props) {
  const { run, pending, connected, address } = useTx();
  const addPosition = useSessionStore((s) => s.addPosition);
  const markQ = useMarkPrice(market.marketId);
  const oracleQ = usePrice(market.baseAsset);

  // Use mark price when available and non-zero; fall back to oracle price.
  const currentMark = (() => {
    if (markPrice !== undefined && markPrice > 0n) return markPrice;
    if (markQ.data !== undefined && markQ.data > 0n) return markQ.data;
    if (oracleQ.data?.price !== undefined && oracleQ.data.price > 0n)
      return oracleQ.data.price;
    return undefined;
  })();

  const [mode, setMode] = useState<OrderMode>("market");
  const [isLong, setIsLong] = useState(true);
  const [sizeUsd, setSizeUsd] = useState("");
  const [leverage, setLeverage] = useState(5);
  const [slippage, setSlippage] = useState(DEFAULT_SLIPPAGE_BPS);
  const [limitPriceStr, setLimitPriceStr] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [submitPhase, setSubmitPhase] = useState<SubmitPhase>("idle");

  const lev = Math.max(1, Math.min(market.maxLeverage, Math.floor(leverage)));
  const parsedSize = toFixed(sizeUsd || "0");
  const parsedLimitPrice = mode === "limit" ? toFixed(limitPriceStr || "0") : 0n;
  const marginRequired =
    lev > 0 && parsedSize > 0n ? parsedSize / BigInt(lev) : 0n;

  // Free collateral from the risk contract — used to block submit before
  // the tx fires and surface a clear "not enough collateral" warning.
  const freeCollateralQ = useFreeCollateral(address ?? null);
  const freeCollateral = freeCollateralQ.data;
  // Allow submit if we can't read free collateral yet (don't block optimistically).
  const hasSufficientMargin =
    freeCollateral === undefined ||
    marginRequired === 0n ||
    marginRequired <= freeCollateral;

  // For limit orders, estimate units using the limit price; for market orders use mark.
  const priceForEstimate = mode === "limit" && parsedLimitPrice > 0n
    ? parsedLimitPrice
    : currentMark;
  const estPriceUsd = priceForEstimate !== undefined ? fromFixed(priceForEstimate) : 0;
  const estUnits = estPriceUsd > 0 ? fromFixed(parsedSize) / estPriceUsd : 0;

  // Estimated liquidation price based on entry estimate.
  const liqPrice = (() => {
    if (priceForEstimate === undefined || lev <= 1) return undefined;
    const f = fromFixed(priceForEstimate);
    if (isLong) {
      return f * (1 - 1 / lev + MAINTENANCE_MARGIN_RATIO);
    } else {
      return f * (1 + 1 / lev - MAINTENANCE_MARGIN_RATIO);
    }
  })();

  const clobAvailable = hasContract(config.contracts.clob);

  const canSubmit = (() => {
    if (!connected || pending) return false;
    if (parsedSize <= 0n) return false;
    if (lev < 1) return false;
    if (!hasSufficientMargin) return false;
    if (mode === "market") {
      return currentMark !== undefined && currentMark > 0n;
    }
    return clobAvailable && parsedLimitPrice > 0n;
  })();

  async function executeMarketSubmit() {
    if (!address || currentMark === undefined || currentMark <= 0n) return;
    const side = isLong ? "Long" : "Short";
    const nowTs = BigInt(Math.floor(Date.now() / 1000));

    // Convert USD notional → 18-decimal base-asset units before submitting.
    // parsedSize = $50 × 1e18; currentMark = $76,986 × 1e18
    // sizeInBaseAsset = (50e18 × 1e18) / (76986e18) ≈ 0.00065 BTC × 1e18
    const sizeInBaseAsset = (parsedSize * FIXED_PRECISION) / currentMark;
    if (sizeInBaseAsset <= 0n) return;

    setShowConfirm(false);
    setSubmitPhase("signing");

    const result = await run(
      `${side} ${market.baseAsset} · ${lev}x`,
      async (source) => {
        setSubmitPhase("confirming");
        try {
          return await getClients().perpEngine.openPosition(
            source,
            market.marketId,
            sizeInBaseAsset,
            isLong,
            lev,
            slippage,
            { sourceAccount: source },
          );
        } catch (e) {
          throw new Error(friendlyContractError(e));
        }
      },
      {
        invalidate: [
          qk.userPositions(address ?? ""),
          qk.accountEquity(address ?? ""),
          qk.accountHealth(address ?? ""),
          qk.portfolioHealth(address ?? ""),
          qk.freeCollateral(address ?? ""),
          qk.vaultBalance(address ?? ""),
          qk.openInterest(market.marketId),
          qk.markPrice(market.marketId),
        ],
      },
    );

    setSubmitPhase("idle");

    if (result?.status === "SUCCESS") {
      // Only add to session store when we have a real on-chain position ID.
      // A Date.now() fallback creates an unresolvable row that can never be
      // closed or matched against on-chain PnL queries, so we skip it.
      let positionId: bigint | undefined;
      try {
        if (result.returnValue !== undefined) {
          positionId = BigInt(scValToNative(result.returnValue) as number | bigint);
        }
      } catch {
        positionId = undefined;
      }
      if (positionId !== undefined && positionId > 0n) {
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
      } else {
        // Position was opened on-chain but the UI couldn't extract the ID from
        // the return value. The position exists; the user can refresh to see it
        // once the indexer backfill is available.
        console.warn("[OrderForm] openPosition succeeded but returnValue was missing or unparseable — skipping session store entry");
      }
    }

    setSizeUsd("");
  }

  async function executeLimitSubmit() {
    if (!address || parsedLimitPrice <= 0n) return;
    const side = isLong ? "Long" : "Short";
    setShowConfirm(false);
    setSubmitPhase("signing");

    const clob = getClients().clob;
    const nowSecs = Math.floor(Date.now() / 1000);
    const expiry = BigInt(nowSecs + DEFAULT_LIMIT_TTL_SECS);
    // Convert notional USD → base-asset units at the limit price (18-dec).
    // size_base = notional_usd / limit_price.
    const sizeBase = (parsedSize * FIXED_PRECISION) / parsedLimitPrice;

    let nonce = 0n;
    try {
      nonce = await clob.getNonce(address);
    } catch {
      // If nonce read fails we'll let the contract reject the order with a
      // readable InvalidNonce error.
    }

    // Build the canonical order hash (mirrors `order_canonical_hash` in Rust)
    // and request an Ed25519 signature from Freighter. Falls back to the
    // 64-byte zero reserved signature if the wallet doesn't support
    // `signMessage` or the user rejects the signing prompt.
    const orderHash = await buildOrderCanonicalHash({
      orderId: 0n, // keeper assigns on-chain; 0 is the convention for placement
      marketId: market.marketId,
      size: sizeBase,
      price: parsedLimitPrice,
      isLong,
      leverage: lev,
      expiry,
      nonce,
    });
    const signature = await signOrderHash(
      orderHash,
      address,
      config.network.passphrase,
    );

    await run(
      `Limit ${side} ${market.baseAsset} @ $${limitPriceStr}`,
      async (source) => {
        setSubmitPhase("confirming");
        try {
          return await clob.placeOrder(
            {
              trader: address,
              marketId: market.marketId,
              size: sizeBase,
              price: parsedLimitPrice,
              isLong,
              leverage: lev,
              expiry,
              nonce,
              signature,
            },
            { sourceAccount: source },
          );
        } catch (e) {
          throw new Error(friendlyContractError(e));
        }
      },
      {
        invalidate: [
          qk.userPositions(address ?? ""),
          qk.accountEquity(address ?? ""),
          qk.accountHealth(address ?? ""),
          qk.portfolioHealth(address ?? ""),
          qk.vaultBalance(address ?? ""),
        ],
      },
    );

    setSubmitPhase("idle");
    setSizeUsd("");
    setLimitPriceStr("");
  }

  async function executeSubmit() {
    if (mode === "limit") await executeLimitSubmit();
    else await executeMarketSubmit();
  }

  const buttonLabel = (() => {
    if (!connected) return "Connect wallet";
    if (submitPhase === "signing") return "Signing…";
    if (submitPhase === "confirming") return "Confirming…";
    if (parsedSize > 0n && !hasSufficientMargin) return "Insufficient collateral";
    if (mode === "market" && (currentMark === undefined || currentMark === 0n))
      return "Waiting for price…";
    const verb = mode === "limit" ? "Place" : isLong ? "Long" : "Short";
    return mode === "limit"
      ? `${verb} ${isLong ? "Buy" : "Sell"} ${market.baseAsset}`
      : `${verb} ${market.baseAsset}`;
  })();

  return (
    <>
      {showConfirm && (
        <ConfirmDialog
          market={market}
          isLong={isLong}
          sizeUsd={sizeUsd}
          leverage={lev}
          mark={currentMark}
          margin={marginRequired}
          liqPrice={liqPrice}
          mode={mode}
          {...(mode === "limit" ? { limitPrice: limitPriceStr } : {})}
          onConfirm={() => void executeSubmit()}
          onCancel={() => setShowConfirm(false)}
        />
      )}

      <Card className="terminal-card rounded-none" padded={false}>
        <div className="border-b terminal-divider px-3 py-2">
          <div className="flex items-center justify-between">
            <h3 className="terminal-panel-title">Order Ticket</h3>
            <span className="text-[10px] text-stella-muted">{market.baseAsset}-USD</span>
          </div>
        </div>
        <div className="space-y-3 p-3">
          {/* Market / Limit tab switcher */}
          <div className="flex gap-1 rounded-md bg-black/35 p-1">
            <button
              onClick={() => setMode("market")}
              className={clsx(
                "flex-1 rounded py-1.5 text-xs font-medium transition-colors",
                mode === "market"
                  ? "bg-stella-accent/30 text-stella-gold"
                  : "text-stella-muted hover:text-white",
              )}
            >
              Market
            </button>
            <button
              onClick={() => setMode("limit")}
              disabled={!clobAvailable}
              title={clobAvailable ? "" : "CLOB contract not yet deployed"}
              className={clsx(
                "flex-1 rounded py-1.5 text-xs font-medium transition-colors",
                mode === "limit"
                  ? "bg-stella-accent/30 text-stella-gold"
                  : "text-stella-muted hover:text-white disabled:opacity-40 disabled:cursor-not-allowed",
              )}
            >
              Limit
            </button>
          </div>

          {/* Long / Short toggle */}
          <div className="grid grid-cols-2 gap-1 rounded-md bg-black/35 p-1">
            <button
              onClick={() => setIsLong(true)}
              className={clsx(
                "rounded py-2 text-sm font-semibold transition-colors",
                isLong
                  ? "bg-stella-long text-white shadow-[0_0_18px_rgba(5,196,138,0.18)]"
                  : "text-stella-muted hover:text-white",
              )}
            >
              Long
            </button>
            <button
              onClick={() => setIsLong(false)}
              className={clsx(
                "rounded py-2 text-sm font-semibold transition-colors",
                !isLong
                  ? "bg-stella-short text-white shadow-[0_0_18px_rgba(240,62,62,0.18)]"
                  : "text-stella-muted hover:text-white",
              )}
            >
              Short
            </button>
          </div>

          <Input
            label="Size"
            suffix="USD"
            inputMode="decimal"
            placeholder="0.00"
            value={sizeUsd}
            onChange={(e) => setSizeUsd(e.target.value)}
          />

          <div className="grid grid-cols-4 gap-1">
            {[100, 500, 1000, 5000].map((v) => (
              <button
                key={v}
                onClick={() => setSizeUsd(String(v))}
                className="rounded border border-white/10 bg-black/25 py-1 text-[10px] font-medium text-stella-muted transition-colors hover:border-white/20 hover:text-white"
              >
                ${v >= 1000 ? `${v / 1000}k` : v}
              </button>
            ))}
          </div>

          {mode === "limit" && (
            <Input
              label="Limit price"
              suffix="USD"
              inputMode="decimal"
              placeholder={
                currentMark !== undefined
                  ? fromFixed(currentMark).toFixed(2)
                  : "0.00"
              }
              value={limitPriceStr}
              onChange={(e) => setLimitPriceStr(e.target.value)}
            />
          )}

          {/* Leverage */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs text-stella-muted">
                Leverage · <span className="text-white font-medium">{lev}x</span>{" "}
                <span className="text-stella-muted">(max {market.maxLeverage}x)</span>
              </label>
            </div>
            {/* Preset buttons */}
            <div className="flex gap-1.5">
              {LEVERAGE_PRESETS.filter((p) => p <= market.maxLeverage).map((p) => (
                <button
                  key={p}
                  onClick={() => setLeverage(p)}
                  className={clsx(
                    "flex-1 rounded py-1 text-xs font-medium transition-colors",
                    lev === p
                      ? "bg-stella-accent/30 border border-stella-accent/70 text-stella-gold"
                      : "bg-black/20 border border-white/10 text-stella-muted hover:text-white hover:border-white/30",
                  )}
                >
                  {p}x
                </button>
              ))}
            </div>
            {/* Slider */}
            <input
              type="range"
              min={1}
              max={market.maxLeverage}
              step={1}
              value={lev}
              onChange={(e) => setLeverage(Number(e.target.value))}
              className="w-full accent-stella-gold"
            />
          </div>

          {/* Order summary */}
            <div className="space-y-1.5 rounded-lg bg-black/35 px-3 py-2.5 text-xs border border-white/5">
            <Row
              label="Mark price"
              value={
                currentMark !== undefined ? formatUsd(currentMark) : "—"
              }
            />
            <Row
              label={`Size (${market.baseAsset})`}
              value={estUnits > 0 ? `${estUnits.toFixed(6)} ${market.baseAsset}` : "—"}
            />
            <Row label="Notional" value={parsedSize > 0n ? formatUsd(parsedSize) : "—"} />
            <Row label="Margin required" value={parsedSize > 0n ? formatUsd(marginRequired) : "—"} />
            <Row
              label="Free collateral"
              value={
                freeCollateral !== undefined
                  ? formatUsd(freeCollateral)
                  : address
                  ? "Loading…"
                  : "—"
              }
              warn={
                freeCollateral !== undefined &&
                marginRequired > 0n &&
                marginRequired > freeCollateral
              }
            />
            <Row
              label="Liq. price (est.)"
              value={
                liqPrice !== undefined
                  ? `$${liqPrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                  : "—"
              }
            />
            <Row
              label="Maker fee"
              value={`${(market.makerFeeBps / 100).toFixed(2)}%`}
            />
            <Row
              label="Taker fee"
              value={`${(market.takerFeeBps / 100).toFixed(2)}%`}
            />
          </div>

          {/* Insufficient collateral warning banner */}
          {!hasSufficientMargin && parsedSize > 0n && (
            <div className="rounded-lg border border-stella-short/30 bg-stella-short/10 px-3 py-2 text-xs text-stella-short">
              <span className="font-semibold">Insufficient collateral.</span>{" "}
              Need {formatUsd(marginRequired)}, have{" "}
              {freeCollateral !== undefined ? formatUsd(freeCollateral) : "$0.00"}.{" "}
              <a href="/deposit" className="underline underline-offset-2 hover:text-white">
                Deposit more →
              </a>
            </div>
          )}

          {/* Advanced settings (slippage) — market orders only */}
          {mode === "market" && (
            <div>
              <button
                onClick={() => setShowAdvanced((v) => !v)}
                className="flex items-center gap-1 text-xs text-stella-muted hover:text-white transition-colors"
              >
                <span
                  className={clsx(
                    "inline-block transition-transform",
                    showAdvanced ? "rotate-90" : "",
                  )}
                >
                  ▶
                </span>
                Advanced
              </button>
              {showAdvanced && (
                <div className="mt-2 space-y-1.5 rounded-xl bg-black/20 px-3 py-3 border border-white/5">
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
                  <p className="text-[10px] text-stella-muted">
                    Oracle-price execution (V2) — slippage guards the
                    maker/taker skew fee, not vAMM divergence.
                  </p>
                </div>
              )}
            </div>
          )}

          <Button
            variant={isLong ? "long" : "short"}
            size="lg"
            className="w-full"
            disabled={!canSubmit}
            onClick={() => setShowConfirm(true)}
          >
            {pending ? (
              <span className="flex items-center justify-center gap-2">
                <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                {buttonLabel}
              </span>
            ) : (
              buttonLabel
            )}
          </Button>
        </div>
      </Card>
    </>
  );
}

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-stella-muted">{label}</span>
      <span className={clsx("num", warn ? "text-stella-short font-semibold" : "text-white")}>
        {value}
      </span>
    </div>
  );
}
