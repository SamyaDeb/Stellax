import { useState } from "react";
import clsx from "clsx";
import type { Market, OrderTypeVariant } from "@stellax/sdk";
import { toFixed, fromFixed, formatUsd } from "@/ui/format";
import { useTx } from "@/wallet";
import { getClients } from "@/stellar/clients";
import { qk, useMarkPrice, usePrice, useFreeCollateral, useOpenInterest } from "@/hooks/queries";
import { useSessionStore } from "@/stores/sessionStore";
import { scValToNative } from "@stellar/stellar-sdk";
import { config, hasContract } from "@/config";
import { MAINTENANCE_MARGIN_RATIO } from "@/constants";
import { buildOrderCanonicalHash, signOrderHash } from "@/stellar/clobOrderSign";
import { useRwaPrice } from "@/hooks/useRwaPrice";
import { PYTH_RWA_FEED_IDS } from "@/pyth";

interface Props {
  market: Market;
  markPrice: bigint | undefined;
}

const DEFAULT_SLIPPAGE_BPS = 500;
const LEVERAGE_PRESETS = [2, 3, 5, 10, 20, 50] as const;
const DEFAULT_LIMIT_TTL_SECS = 3600;
const DEFAULT_PENDING_EXPIRY_LEDGERS = 100_000; // ~16 days
const FIXED_PRECISION = 10n ** 18n;

type SubmitPhase = "idle" | "signing" | "confirming";
type OrderMode = "market" | "limit" | "stop" | "tp_sl";

// ── Confirm dialog ─────────────────────────────────────────────────────────

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
  market, isLong, sizeUsd, leverage, mark, margin,
  liqPrice, mode, limitPrice, stopPrice, tpPrice, onConfirm, onCancel,
}: ConfirmDialogProps & { stopPrice?: string; tpPrice?: string }) {
  const parsedSize = toFixed(sizeUsd || "0");
  const side = isLong ? "Long" : "Short";

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 50,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.75)",
        backdropFilter: "blur(4px)",
      }}
    >
      <div
        style={{
          background: "var(--bg1)",
          border: "1px solid var(--border2)",
          borderRadius: 4,
          padding: 20,
          width: "100%",
          maxWidth: 340,
          margin: "0 16px",
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, color: "var(--t1)", marginBottom: 4 }}>
          Confirm{" "}
          {mode === "limit" ? "Limit Order" : mode === "stop" ? "Stop Order" : mode === "tp_sl" ? "Bracket Order" : "Order"}
        </div>
        <div style={{ fontSize: 10, color: "var(--t3)", marginBottom: 16 }}>
          Review before submitting to the blockchain.
        </div>

        <div
          style={{
            border: "1px solid var(--border)",
            background: "var(--bg0)",
            borderRadius: 3,
            padding: "10px 12px",
          }}
        >
          {[
            ["Market", `${market.baseAsset}-${market.quoteAsset}`],
            ["Direction", `${side} · ${leverage}x`],
            ["Notional", formatUsd(parsedSize)],
            ...(mode === "limit" && limitPrice ? [["Limit price", `$${limitPrice}`]] : []),
            ...(mode === "stop" && stopPrice ? [["Stop trigger", `$${stopPrice}`]] : []),
            ...(mode === "tp_sl" && stopPrice ? [["Stop Loss", `$${stopPrice}`]] : []),
            ...(mode === "tp_sl" && tpPrice ? [["Take Profit", `$${tpPrice}`]] : []),
            ...(mode === "market" ? [["Est. entry", mark !== undefined ? formatUsd(mark) : "—"]] : []),
            ["Margin required", formatUsd(margin)],
            ...(liqPrice !== undefined ? [["Est. liq. price", `$${liqPrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`]] : []),
            [mode === "limit" ? "Maker fee" : "Taker fee",
              `${((mode === "limit" ? market.makerFeeBps : market.takerFeeBps) / 100).toFixed(2)}%`],
            ["Network fee", "~0.005 XLM"],
          ].map(([label, value]) => (
            <div
              key={label}
              style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "4px 0", borderBottom: "1px solid var(--border)",
                fontSize: 11,
              }}
            >
              <span style={{ color: "var(--t3)" }}>{label}</span>
              <span
                className="num"
                style={{
                  color: label === "Est. liq. price"
                    ? "var(--red)"
                    : label === "Direction"
                      ? isLong ? "var(--green)" : "var(--red)"
                      : "var(--t1)",
                }}
              >
                {value}
              </span>
            </div>
          ))}
        </div>

        <div style={{ fontSize: 9, color: "var(--t3)", marginTop: 10, lineHeight: 1.5 }}>
          {mode === "limit"
            ? "Your limit order will rest on-chain until matched by the keeper or cancelled."
            : "Prices may change before the transaction confirms. Network fee covers Soroban compute."}
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <button
            onClick={onCancel}
            style={{
              flex: 1, padding: "8px 0", fontSize: 12, fontWeight: 600,
              background: "transparent", color: "var(--t2)",
              border: "1px solid var(--border2)", borderRadius: 3, cursor: "pointer",
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{
              flex: 1, padding: "8px 0", fontSize: 12, fontWeight: 700,
              background: isLong ? "var(--green)" : "var(--red)",
              color: isLong ? "var(--bg0)" : "#fff",
              border: "none", borderRadius: 3, cursor: "pointer",
              fontFamily: "'JetBrains Mono', monospace",
              textTransform: "uppercase", letterSpacing: "0.05em",
            }}
          >
            Confirm {side}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Error helpers ──────────────────────────────────────────────────────────

function friendlyContractError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (/Error\(Budget,\s*ExceededLimit\)/i.test(raw) || /budget.*exceeded/i.test(raw))
    return "Transaction exceeded compute budget — try reducing position size or try again.";
  if (/Error\(Contract,\s*#9\)/.test(raw))
    return "Insufficient collateral — deposit more USDC before trading.";
  if (/Error\(Contract,\s*#10\)/.test(raw))
    return "Margin lock limit exceeded — position size exceeds your free collateral.";
  if (/Error\(Contract,\s*#11\)/.test(raw))
    return "Margin account not found — please deposit collateral first.";
  if (/Error\(Contract,\s*#5\)/.test(raw))  return "Market not found.";
  if (/Error\(Contract,\s*#6\)/.test(raw))  return "Market is currently inactive.";
  if (/Error\(Contract,\s*#7\)/.test(raw))  return "Invalid leverage — check the maximum leverage for this market.";
  if (/Error\(Contract,\s*#8\)/.test(raw))  return "Invalid size — position size must be greater than zero.";
  if (/Error\(Contract,\s*#13\)/.test(raw)) return "Insufficient margin — increase collateral or reduce position size.";
  if (/Error\(Contract,\s*#25\)/.test(raw)) return "Insufficient protocol liquidity — try again later.";
  if (/Error\(Contract,\s*#26\)/.test(raw)) return "Trading is currently paused — please try again later.";
  if (/Error\(Contract,\s*#27\)/.test(raw)) return "Position limit reached — close some existing positions before opening new ones.";
  if (/Error\(Contract,\s*#28\)/.test(raw)) return "Oracle price is stale — try again in a moment.";
  if (/Error\(Contract,\s*#29\)/.test(raw)) return "Oracle returned an invalid price — trading is temporarily unavailable.";
  if (/user rejected/i.test(raw))           return "Transaction cancelled.";
  return raw.length > 120 ? `${raw.slice(0, 120)}…` : raw;
}

// ── Order Form ─────────────────────────────────────────────────────────────

export function OrderForm({ market, markPrice }: Props) {
  const { run, pending, connected, address } = useTx();
  const addPosition = useSessionStore((s) => s.addPosition);
  const markQ   = useMarkPrice(market.marketId);
  const oracleQ = usePrice(market.baseAsset);

  const isRwa    = market.badge === "RWA";
  const rwaPrice = useRwaPrice(isRwa ? market.baseAsset : null);

  const currentMark = (() => {
    // For RWA, prefer fresh Pyth/oracle NAV price — mark may be 0 before first trade
    if (isRwa && rwaPrice.price18 !== undefined && rwaPrice.price18 > 0n) return rwaPrice.price18;
    if (markPrice !== undefined && markPrice > 0n) return markPrice;
    if (markQ.data !== undefined && markQ.data > 0n) return markQ.data;
    if (oracleQ.data?.price !== undefined && oracleQ.data.price > 0n) return oracleQ.data.price;
    return undefined;
  })();

  const [mode, setMode] = useState<OrderMode>("market");
  const [isLong, setIsLong] = useState(true);
  const [sizeUsd, setSizeUsd] = useState("");
  const [leverage, setLeverage] = useState(5);
  const [slippage, setSlippage] = useState(DEFAULT_SLIPPAGE_BPS);
  const [limitPriceStr, setLimitPriceStr] = useState("");
  const [stopPriceStr, setStopPriceStr] = useState("");
  const [tpPriceStr, setTpPriceStr] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [submitPhase, setSubmitPhase] = useState<SubmitPhase>("idle");

  const lev = Math.max(1, Math.min(market.maxLeverage, Math.floor(leverage)));
  const parsedSize      = toFixed(sizeUsd || "0");
  const parsedLimitPrice = mode === "limit" ? toFixed(limitPriceStr || "0") : 0n;
  const parsedStopPrice  = mode === "stop" || mode === "tp_sl" ? toFixed(stopPriceStr || "0") : 0n;
  const parsedTpPrice    = mode === "tp_sl" ? toFixed(tpPriceStr || "0") : 0n;
  const marginRequired  = lev > 0 && parsedSize > 0n ? parsedSize / BigInt(lev) : 0n;

  const freeCollateralQ = useFreeCollateral(address ?? null);
  const freeCollateral  = freeCollateralQ.data;
  const oiQ = useOpenInterest(market.marketId);
  const oi = oiQ.data;

  const oiSide = isLong ? oi?.long : oi?.short;
  const priceImpact = (() => {
    if (parsedSize <= 0n || oiSide === undefined || oiSide <= 0n) return null;
    // Rough estimate: 1% of OI = ~0.05% price impact
    const impactBps = Number((parsedSize * 500n) / oiSide);
    return impactBps / 100; // as percentage
  })();
  const hasSufficientMargin =
    freeCollateral === undefined ||
    marginRequired === 0n ||
    marginRequired <= freeCollateral;

  const priceForEstimate = mode === "limit" && parsedLimitPrice > 0n
    ? parsedLimitPrice : currentMark;
  const estPriceUsd = priceForEstimate !== undefined ? fromFixed(priceForEstimate) : 0;
  const estUnits    = estPriceUsd > 0 ? fromFixed(parsedSize) / estPriceUsd : 0;
  const notionalNum = fromFixed(parsedSize);
  const marginNum   = fromFixed(marginRequired);
  const estFee      = notionalNum * ((mode === "limit" ? market.makerFeeBps : market.takerFeeBps) / 10_000);

  const liqPrice = (() => {
    if (priceForEstimate === undefined || lev <= 1) return undefined;
    const f = fromFixed(priceForEstimate);
    return isLong
      ? f * (1 - 1 / lev + MAINTENANCE_MARGIN_RATIO)
      : f * (1 + 1 / lev - MAINTENANCE_MARGIN_RATIO);
  })();

  // Risk bar: margin as % of free collateral (capped at 100)
  const riskPct =
    parsedSize > 0n && freeCollateral !== undefined && freeCollateral > 0n
      ? Math.min(100, Math.floor(Number((marginRequired * 100n) / freeCollateral)))
      : 0;
  const riskColor =
    riskPct < 40 ? "var(--green)" : riskPct < 70 ? "#f0a742" : "var(--red)";

  const clobAvailable = hasContract(config.contracts.clob);

  const rwaOracleBlocked = isRwa && rwaPrice.isStale && rwaPrice.pythVaa === undefined;

  const canSubmit = (() => {
    if (!connected || pending) return false;
    if (parsedSize <= 0n) return false;
    if (lev < 1) return false;
    if (!hasSufficientMargin) return false;
    if (rwaOracleBlocked) return false;
    if (mode === "market") return currentMark !== undefined && currentMark > 0n;
    if (mode === "limit") return clobAvailable && parsedLimitPrice > 0n;
    if (mode === "stop") return parsedStopPrice > 0n;
    if (mode === "tp_sl") return parsedStopPrice > 0n && parsedTpPrice > 0n;
    return false;
  })();

  async function executeMarketSubmit() {
    if (!address || currentMark === undefined || currentMark <= 0n) return;
    const side = isLong ? "Long" : "Short";
    const nowTs = BigInt(Math.floor(Date.now() / 1000));
    const sizeInBaseAsset = (parsedSize * FIXED_PRECISION) / currentMark;
    if (sizeInBaseAsset <= 0n) return;

    setShowConfirm(false);
    setSubmitPhase("signing");

    const result = await run(
      `${side} ${market.baseAsset} · ${lev}x`,
      async (source) => {
        setSubmitPhase("confirming");
        try {
          if (isRwa && rwaPrice.pythVaa !== undefined) {
            const feedId = PYTH_RWA_FEED_IDS[market.baseAsset];
            if (feedId) {
              try {
                return await getClients().perpEngine.openPositionWithUpdate(
                  source, market.marketId, sizeInBaseAsset, isLong, lev, slippage,
                  rwaPrice.pythVaa,
                  [feedId],
                  { sourceAccount: source },
                );
              } catch (pythErr) {
                // Fall back to openPosition (keeper oracle) unless this is a clear
                // business-logic error that openPosition would also fail on.
                // OracleError::PythNotConfigured(#15) gets translated to "Math overflow"
                // by PERP_ERRORS — so we use a blocklist instead of an allowlist.
                const msg = String(pythErr).toLowerCase();
                const isFatalErr =
                  msg.includes("insufficient collateral") ||
                  msg.includes("insufficient margin") ||
                  msg.includes("margin lock") ||
                  msg.includes("position limit") ||
                  msg.includes("invalid leverage") ||
                  msg.includes("invalid size") ||
                  msg.includes("insufficient liquidity") ||
                  msg.includes("trading is paused") ||
                  msg.includes("market is inactive") ||
                  msg.includes("price too stale") ||
                  msg.includes("open interest exceeded");
                if (isFatalErr) throw pythErr;
                console.warn("openPositionWithUpdate failed — falling back to openPosition:", pythErr);
              }
            }
          }
          return await getClients().perpEngine.openPosition(
            source, market.marketId, sizeInBaseAsset, isLong, lev, slippage,
            { sourceAccount: source },
          );
        } catch (e) { throw new Error(friendlyContractError(e)); }
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
      let positionId: bigint | undefined;
      try {
        if (result.returnValue !== undefined)
          positionId = BigInt(scValToNative(result.returnValue) as number | bigint);
      } catch { positionId = undefined; }

      if (positionId !== undefined && positionId > 0n) {
        addPosition({
          positionId, owner: address, marketId: market.marketId,
          size: parsedSize, entryPrice: currentMark, margin: marginRequired,
          leverage: lev, isLong, lastFundingIdx: 0n, openTimestamp: nowTs,
        });
      } else {
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

    const clob    = getClients().clob;
    const nowSecs = Math.floor(Date.now() / 1000);
    const expiry  = BigInt(nowSecs + DEFAULT_LIMIT_TTL_SECS);
    const sizeBase = (parsedSize * FIXED_PRECISION) / parsedLimitPrice;

    let nonce = 0n;
    try { nonce = await clob.getNonce(address); } catch { /* fallback to 0 */ }

    const orderHash = await buildOrderCanonicalHash({
      orderId: 0n, marketId: market.marketId, size: sizeBase,
      price: parsedLimitPrice, isLong, leverage: lev, expiry, nonce,
    });
    const signature = await signOrderHash(orderHash, address, config.network.passphrase);

    await run(
      `Limit ${side} ${market.baseAsset} @ $${limitPriceStr}`,
      async (source) => {
        setSubmitPhase("confirming");
        try {
          return await clob.placeOrder(
            { trader: address, marketId: market.marketId, size: sizeBase,
              price: parsedLimitPrice, isLong, leverage: lev, expiry, nonce, signature },
            { sourceAccount: source },
          );
        } catch (e) { throw new Error(friendlyContractError(e)); }
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

  async function executeStopSubmit() {
    if (!address || parsedStopPrice <= 0n) return;
    const side = isLong ? "Long" : "Short";
    const stopPrice18 = parsedStopPrice; // trigger price in 18dp
    setShowConfirm(false);
    setSubmitPhase("signing");

    const priceOracle = currentMark ?? 0n;
    const sizeInBase = priceOracle > 0n ? (parsedSize * FIXED_PRECISION) / priceOracle : 0n;

    const orderType: OrderTypeVariant = isLong
      ? { kind: "StopLoss", price: stopPrice18 }
      : { kind: "StopLoss", price: stopPrice18 };

    await run(
      `Stop ${side} ${market.baseAsset} @ $${stopPriceStr}`,
      async (source) => {
        setSubmitPhase("confirming");
        try {
          return await getClients().perpEngine.createOrder(
            address, market.marketId, sizeInBase, isLong, lev,
            slippage, orderType, DEFAULT_PENDING_EXPIRY_LEDGERS,
            { sourceAccount: source },
          );
        } catch (e) { throw new Error(friendlyContractError(e)); }
      },
      {
        invalidate: [
          qk.userPositions(address ?? ""),
          qk.accountEquity(address ?? ""),
          qk.accountHealth(address ?? ""),
          qk.portfolioHealth(address ?? ""),
          qk.freeCollateral(address ?? ""),
          qk.vaultBalance(address ?? ""),
        ],
      },
    );

    setSubmitPhase("idle");
    setSizeUsd("");
    setStopPriceStr("");
  }

  async function executeBracketSubmit() {
    if (!address || parsedStopPrice <= 0n || parsedTpPrice <= 0n) return;
    const side = isLong ? "Long" : "Short";
    setShowConfirm(false);
    setSubmitPhase("signing");

    const priceOracle = currentMark ?? 0n;
    const sizeInBase = priceOracle > 0n ? (parsedSize * FIXED_PRECISION) / priceOracle : 0n;

    const entryType: OrderTypeVariant = { kind: "Market" };
    const tpType: OrderTypeVariant = { kind: "TakeProfit", price: parsedTpPrice };
    const slType: OrderTypeVariant = { kind: "StopLoss", price: parsedStopPrice };

    await run(
      `Bracket ${side} ${market.baseAsset} · SL $${stopPriceStr} · TP $${tpPriceStr}`,
      async (source) => {
        setSubmitPhase("confirming");
        try {
          const perp = getClients().perpEngine;

          // Step 1: Create entry order
          const entryRes = await perp.createOrder(
            address, market.marketId, sizeInBase, isLong, lev,
            slippage, entryType, DEFAULT_PENDING_EXPIRY_LEDGERS,
            { sourceAccount: source },
          );
          const entryId = BigInt(scValToNative(entryRes.returnValue as unknown as ReturnType<typeof scValToNative>) as bigint);

          // Step 2: Create TP order
          const tpRes = await perp.createOrder(
            address, market.marketId, sizeInBase, isLong, lev,
            slippage, tpType, DEFAULT_PENDING_EXPIRY_LEDGERS,
            { sourceAccount: source },
          );
          const tpId = BigInt(scValToNative(tpRes.returnValue as unknown as ReturnType<typeof scValToNative>) as bigint);

          // Step 3: Create SL order
          const slRes = await perp.createOrder(
            address, market.marketId, sizeInBase, isLong, lev,
            slippage, slType, DEFAULT_PENDING_EXPIRY_LEDGERS,
            { sourceAccount: source },
          );
          const slId = BigInt(scValToNative(slRes.returnValue as unknown as ReturnType<typeof scValToNative>) as bigint);

          // Step 4: Link into bracket
          return await perp.bracketLink(address, entryId, tpId, slId, { sourceAccount: source });
        } catch (e) { throw new Error(friendlyContractError(e)); }
      },
      {
        invalidate: [
          qk.userPositions(address ?? ""),
          qk.accountEquity(address ?? ""),
          qk.accountHealth(address ?? ""),
          qk.portfolioHealth(address ?? ""),
          qk.freeCollateral(address ?? ""),
          qk.vaultBalance(address ?? ""),
        ],
      },
    );

    setSubmitPhase("idle");
    setSizeUsd("");
    setStopPriceStr("");
    setTpPriceStr("");
  }

  async function executeSubmit() {
    if (mode === "limit") await executeLimitSubmit();
    else if (mode === "stop") await executeStopSubmit();
    else if (mode === "tp_sl") await executeBracketSubmit();
    else await executeMarketSubmit();
  }

  const buttonLabel = (() => {
    if (!connected)                    return "Connect Wallet";
    if (submitPhase === "signing")     return "Signing...";
    if (submitPhase === "confirming")  return "Confirming...";
    if (parsedSize > 0n && !hasSufficientMargin) return "Insufficient Collateral";
    if (rwaOracleBlocked)              return "Oracle Stale — Blocked";
    if (mode === "market" && (currentMark === undefined || currentMark === 0n))
      return "Waiting for price...";
    if (mode === "limit") return `${isLong ? "BUY" : "SELL"} ${market.baseAsset}`;
    if (mode === "stop")  return `Place Stop ${isLong ? "Long" : "Short"}`;
    if (mode === "tp_sl") return `Place Bracket ${isLong ? "Long" : "Short"}`;
    return `${isLong ? "LONG" : "SHORT"} ${market.baseAsset}`;
  })();

  const S: React.CSSProperties = {
    fontFamily: "'JetBrains Mono', monospace",
  };

  return (
    <>
      {showConfirm && (
        <ConfirmDialog
          market={market} isLong={isLong} sizeUsd={sizeUsd} leverage={lev}
          mark={currentMark} margin={marginRequired} liqPrice={liqPrice}
          mode={mode}
          {...(mode === "limit" ? { limitPrice: limitPriceStr } : {})}
          {...(mode === "stop" ? { stopPrice: stopPriceStr } : {})}
          {...(mode === "tp_sl" ? { stopPrice: stopPriceStr, tpPrice: tpPriceStr } : {})}
          onConfirm={() => void executeSubmit()}
          onCancel={() => setShowConfirm(false)}
        />
      )}

      <div style={S}>
        {/* Header */}
        <div
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "8px 12px", borderBottom: "1px solid var(--border)",
          }}
        >
          <span className="terminal-panel-title">Place Order</span>
          <span className="num" style={{ fontSize: 11, fontWeight: 600, color: "var(--t1)" }}>
            {market.baseAsset}-USD
          </span>
        </div>

        <div style={{ padding: "10px 10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>

          {/* Order type tabs */}
          <div
            style={{
              display: "flex", gap: 1, padding: 2,
              background: "var(--bg0)", border: "1px solid var(--border)",
              borderRadius: 3,
            }}
          >
            {(["market", "limit", "stop", "tp_sl"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                disabled={m === "limit" && !clobAvailable}
                className={clsx(
                  "order-type-tab",
                  mode === m ? "active" : "inactive",
                  m === "limit" && !clobAvailable && "opacity-40 cursor-not-allowed",
                )}
                title={m === "limit" && !clobAvailable ? "CLOB contract not deployed" : ""}
              >
                {m === "market" ? "Market" : m === "limit" ? "Limit" : m === "stop" ? "Stop" : "TP/SL"}
              </button>
            ))}
          </div>

          {/* Long / Short toggle */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
            <button
              onClick={() => setIsLong(true)}
              className={isLong ? "side-btn side-btn-long" : "side-btn side-btn-long-off"}
            >
              Long
            </button>
            <button
              onClick={() => setIsLong(false)}
              className={!isLong ? "side-btn side-btn-short" : "side-btn side-btn-short-off"}
            >
              Short
            </button>
          </div>

          {/* RWA NAV info panel */}
          {isRwa && (
            <div
              style={{
                padding: "8px 10px",
                border: "1px solid rgba(240,167,66,0.25)",
                borderRadius: 3,
                background: "rgba(240,167,66,0.04)",
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 9, color: "#f0a742", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>
                  NAV Oracle · {market.baseAsset}
                </span>
                <span
                  style={{
                    fontSize: 8, fontWeight: 700, padding: "1px 5px",
                    borderRadius: 2, letterSpacing: "0.06em",
                    background: rwaPrice.source === "pyth" ? "rgba(79,142,255,0.15)" : "rgba(240,167,66,0.15)",
                    color: rwaPrice.source === "pyth" ? "var(--accent)" : "#f0a742",
                    border: `1px solid ${rwaPrice.source === "pyth" ? "rgba(79,142,255,0.3)" : "rgba(240,167,66,0.3)"}`,
                  }}
                >
                  {rwaPrice.source?.toUpperCase() ?? "…"}
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span className="num" style={{ fontSize: 14, fontWeight: 700, color: "var(--t1)" }}>
                  {rwaPrice.price !== undefined
                    ? `$${rwaPrice.price.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 6 })}`
                    : "Loading…"}
                </span>
                <span style={{ fontSize: 9, color: "var(--t3)" }}>
                  {rwaPrice.ageMs !== undefined
                    ? rwaPrice.ageMs < 60_000
                      ? `${Math.round(rwaPrice.ageMs / 1000)}s ago`
                      : `${Math.floor(rwaPrice.ageMs / 60_000)}m ago`
                    : ""}
                  {rwaPrice.isStale && <span style={{ color: "var(--red)", marginLeft: 4 }}>stale</span>}
                </span>
              </div>
              <div style={{ display: "flex", gap: 8, fontSize: 9, color: "var(--t3)" }}>
                <span>Max {market.maxLeverage}× leverage</span>
                <span>·</span>
                <span>{((market.takerFeeBps) / 100).toFixed(2)}% taker fee</span>
              </div>
            </div>
          )}

          {/* Price input (Limit only) */}
          {mode === "limit" ? (
            <LabelInput
              label="Price"
              suffix="USD"
              placeholder={currentMark !== undefined ? fromFixed(currentMark).toFixed(2) : "0.00"}
              value={limitPriceStr}
              onChange={(e) => setLimitPriceStr(e.target.value)}
            />
          ) : (
            <div
              style={{
                padding: "6px 8px", border: "1px solid var(--border)", borderRadius: 3,
                background: "var(--bg0)", display: "flex", justifyContent: "space-between",
              }}
            >
              <span style={{ fontSize: 10, color: "var(--t3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Market Price
              </span>
              <span className="num" style={{ fontSize: 11, color: "var(--t3)" }}>
                {currentMark !== undefined ? fromFixed(currentMark).toFixed(2) : "—"}
              </span>
            </div>
          )}

          {/* Trigger price (Stop mode) */}
          {mode === "stop" && (
            <LabelInput
              label="Stop Trigger"
              suffix="USD"
              placeholder={currentMark !== undefined ? fromFixed(currentMark).toFixed(2) : "0.00"}
              value={stopPriceStr}
              onChange={(e) => setStopPriceStr(e.target.value)}
            />
          )}

          {/* TP/SL price inputs (Bracket mode) */}
          {mode === "tp_sl" && (
            <>
              <LabelInput
                label="Take Profit"
                suffix="USD"
                placeholder={currentMark !== undefined
                  ? (isLong ? fromFixed(currentMark) * 1.05 : fromFixed(currentMark) * 0.95).toFixed(2)
                  : "0.00"}
                value={tpPriceStr}
                onChange={(e) => setTpPriceStr(e.target.value)}
              />
              <LabelInput
                label="Stop Loss"
                suffix="USD"
                placeholder={currentMark !== undefined
                  ? (isLong ? fromFixed(currentMark) * 0.95 : fromFixed(currentMark) * 1.05).toFixed(2)
                  : "0.00"}
                value={stopPriceStr}
                onChange={(e) => setStopPriceStr(e.target.value)}
              />
            </>
          )}

          {/* Size input with Max button */}
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <label style={{ fontSize: 10, color: "var(--t3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Size
            </label>
            <div style={{ position: "relative" }}>
              <input
                className="input num"
                inputMode="decimal"
                placeholder="0.00"
                value={sizeUsd}
                onChange={(e) => setSizeUsd(e.target.value)}
                style={{ paddingRight: 52 }}
              />
              <span
                style={{
                  position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
                  fontSize: 10, color: "var(--t3)",
                }}
              >
                USD
              </span>
            </div>
          </div>

          {/* Size % presets */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 3 }}>
            {([25n, 50n, 75n, 100n] as const).map((pct) => {
              const hasMargin = freeCollateral !== undefined && freeCollateral > 0n;
              const notionalUsd = hasMargin
                ? fromFixed((freeCollateral! * pct * BigInt(lev)) / 100n).toFixed(2)
                : null;
              return (
                <button
                  key={String(pct)}
                  disabled={!hasMargin}
                  onClick={() => notionalUsd !== null && setSizeUsd(notionalUsd)}
                  style={{
                    padding: "4px 0",
                    fontSize: 10,
                    fontWeight: 600,
                    borderRadius: 2,
                    border: "1px solid var(--border)",
                    background: hasMargin ? "var(--bg0)" : "transparent",
                    color: hasMargin ? "var(--t2)" : "var(--t3)",
                    cursor: hasMargin ? "pointer" : "not-allowed",
                    opacity: hasMargin ? 1 : 0.4,
                    fontFamily: "'JetBrains Mono', monospace",
                    transition: "border-color 0.1s, color 0.1s",
                  }}
                  onMouseEnter={(e) => {
                    if (hasMargin) {
                      (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--accent)";
                      (e.currentTarget as HTMLButtonElement).style.color = "var(--t1)";
                    }
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border)";
                    (e.currentTarget as HTMLButtonElement).style.color = hasMargin ? "var(--t2)" : "var(--t3)";
                  }}
                >
                  {String(pct)}%
                </button>
              );
            })}
          </div>

          {/* Leverage */}
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 10, color: "var(--t3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Leverage
              </span>
              <span className="num" style={{ fontSize: 12, fontWeight: 700, color: "var(--t1)" }}>
                {lev}x
                <span style={{ fontSize: 10, color: "var(--t3)", fontWeight: 400, marginLeft: 3 }}>
                  / {market.maxLeverage}x
                </span>
              </span>
            </div>

            {/* Preset buttons */}
            <div style={{ display: "flex", gap: 3 }}>
              {LEVERAGE_PRESETS.filter((p) => p <= market.maxLeverage).map((p) => (
                <button
                  key={p}
                  onClick={() => setLeverage(p)}
                  style={{
                    flex: 1, padding: "4px 0", fontSize: 10, fontWeight: 700,
                    borderRadius: 2,
                    border: lev === p ? "1px solid rgba(79,142,255,0.5)" : "1px solid var(--border)",
                    background: lev === p ? "var(--accent-dim)" : "var(--bg0)",
                    color: lev === p ? "var(--accent)" : "var(--t3)",
                    cursor: "pointer",
                    fontFamily: "'JetBrains Mono', monospace",
                    transition: "background 0.1s, color 0.1s, border-color 0.1s",
                  }}
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
              style={{ width: "100%", cursor: "pointer", accentColor: "var(--accent)" }}
            />
          </div>

          {/* Order stats box */}
          <div
            style={{
              border: "1px solid var(--border)",
              background: "var(--bg0)",
              borderRadius: 3,
              overflow: "hidden",
            }}
          >
            <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 5 }}>
              <StatRow label="Mark Price"
                value={currentMark !== undefined ? formatUsd(currentMark) : "—"}
              />
              <StatRow
                label={`Size (${market.baseAsset})`}
                value={estUnits > 0 ? `${estUnits.toFixed(6)} ${market.baseAsset}` : "—"}
              />
              <StatRow
                label="Notional Value"
                value={parsedSize > 0n ? `$${notionalNum.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}
              />
              <StatRow
                label="Margin Required"
                value={parsedSize > 0n ? formatUsd(marginRequired) : "—"}
              />
              <StatRow
                label="Free Collateral"
                value={freeCollateral !== undefined ? formatUsd(freeCollateral) : address ? "Loading..." : "—"}
                warn={freeCollateral !== undefined && marginRequired > 0n && marginRequired > freeCollateral}
              />
            </div>

            {/* Est. Liq Price */}
            {liqPrice !== undefined && (
              <div
                style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  borderTop: "1px solid var(--border)", padding: "6px 10px",
                  background: "var(--red-dim)",
                }}
              >
                <span style={{ fontSize: 10, color: "var(--t3)" }}>Est. Liq. Price</span>
                <span className="num" style={{ fontSize: 11, fontWeight: 600, color: "var(--red)" }}>
                  ${liqPrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
            )}

            {/* Est. Fee */}
            <div
              style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                borderTop: "1px solid var(--border)", padding: "5px 10px",
              }}
            >
              <span style={{ fontSize: 10, color: "var(--t3)" }}>
                {mode === "limit" ? "Maker" : "Taker"} Fee
              </span>
              <span className="num" style={{ fontSize: 11, color: "var(--t1)" }}>
                {parsedSize > 0n ? `$${estFee.toFixed(4)}` : "—"}
              </span>
            </div>

            {/* Est. Price Impact */}
            <div
              style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                borderTop: "1px solid var(--border)", padding: "5px 10px",
              }}
            >
              <span style={{ fontSize: 10, color: "var(--t3)" }}>
                Est. Price Impact
              </span>
              <span className="num" style={{
                fontSize: 11,
                color: priceImpact !== null
                  ? priceImpact > 5 ? "var(--red)"
                  : priceImpact > 2 ? "#f0a742"
                  : "var(--t2)"
                  : "var(--t3)"
              }}>
                {priceImpact !== null ? `${priceImpact > 0 ? "+" : ""}${priceImpact.toFixed(4)}%` : "—"}
              </span>
            </div>

            {/* Risk bar */}
            {parsedSize > 0n && (
              <div style={{ borderTop: "1px solid var(--border)", padding: "6px 10px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontSize: 9, color: "var(--t3)", textTransform: "uppercase", letterSpacing: "0.07em" }}>
                    Risk
                  </span>
                  <span className="num" style={{ fontSize: 9, color: riskColor }}>
                    {riskPct}%
                  </span>
                </div>
                <div
                  style={{
                    height: 3, background: "var(--bg3)", borderRadius: 1, overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${riskPct}%`,
                      background: riskColor,
                      borderRadius: 1,
                      transition: "width 0.2s, background 0.2s",
                    }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Insufficient collateral warning */}
          {!hasSufficientMargin && parsedSize > 0n && (
            <div
              style={{
                padding: "8px 10px", borderRadius: 3,
                border: "1px solid rgba(240,64,74,0.3)",
                background: "var(--red-dim)",
                fontSize: 10, color: "var(--red)",
              }}
            >
              <span style={{ fontWeight: 700 }}>Insufficient collateral.</span>{" "}
              Need {formatUsd(marginRequired)}, have{" "}
              {freeCollateral !== undefined ? formatUsd(freeCollateral) : "$0.00"}.{" "}
              <a href="/deposit" style={{ color: "inherit", textDecoration: "underline" }}>
                Deposit →
              </a>
            </div>
          )}

          {/* Advanced (slippage) */}
          {mode === "market" && (
            <div>
              <button
                onClick={() => setShowAdvanced((v) => !v)}
                style={{
                  display: "flex", alignItems: "center", gap: 4,
                  fontSize: 10, color: "var(--t3)", background: "none",
                  border: "none", cursor: "pointer", padding: 0,
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                <span style={{ display: "inline-block", transform: showAdvanced ? "rotate(90deg)" : "none", transition: "transform 0.15s", fontSize: 8 }}>
                  ▶
                </span>
                Advanced
              </button>
              {showAdvanced && (
                <div
                  style={{
                    marginTop: 6, padding: "8px 10px",
                    background: "var(--bg0)", border: "1px solid var(--border)", borderRadius: 3,
                  }}
                >
                  <LabelInput
                    label="Max slippage (bps)"
                    type="number"
                    min={1}
                    max={10000}
                    value={slippage}
                    onChange={(e) => setSlippage(Number(e.target.value) || DEFAULT_SLIPPAGE_BPS)}
                  />
                  <p style={{ fontSize: 9, color: "var(--t3)", marginTop: 4, lineHeight: 1.4 }}>
                    Oracle-price execution — slippage guards the maker/taker skew fee.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* RWA staleness warning */}
          {rwaOracleBlocked && (
            <div
              style={{
                padding: "8px 10px", borderRadius: 3,
                border: "1px solid rgba(240,64,74,0.3)",
                background: "var(--red-dim)",
                fontSize: 10, color: "var(--red)", lineHeight: 1.5,
              }}
            >
              <span style={{ fontWeight: 700 }}>Oracle stale.</span>{" "}
              NAV last updated {Math.floor((rwaPrice.ageMs ?? 0) / 60_000)}m ago.
              Trading blocked until oracle refreshes or Pyth feed is available.
            </div>
          )}

          {/* Submit button */}
          <button
            disabled={!canSubmit}
            onClick={() => setShowConfirm(true)}
            style={{
              width: "100%", padding: "11px 0",
              fontSize: 12, fontWeight: 700,
              borderRadius: 3, border: "none",
              cursor: canSubmit ? "pointer" : "not-allowed",
              fontFamily: "'JetBrains Mono', monospace",
              textTransform: "uppercase", letterSpacing: "0.07em",
              background: !canSubmit
                ? "var(--bg3)"
                : isLong ? "var(--green)" : "var(--red)",
              color: !canSubmit
                ? "var(--t3)"
                : isLong ? "var(--bg0)" : "#fff",
              transition: "background 0.1s, color 0.1s",
              opacity: !canSubmit ? 0.6 : 1,
            }}
          >
            {pending ? (
              <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                <span
                  style={{
                    display: "inline-block", width: 12, height: 12,
                    border: "2px solid currentColor", borderTopColor: "transparent",
                    borderRadius: "50%", animation: "spin 0.7s linear infinite",
                  }}
                />
                {buttonLabel}
              </span>
            ) : buttonLabel}
          </button>

          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      </div>
    </>
  );
}

/* ── Sub-components ─────────────────────────────────────────────── */

function StatRow({
  label, value, warn,
}: { label: string; value: string; warn?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <span style={{ fontSize: 10, color: "var(--t3)" }}>{label}</span>
      <span
        className="num"
        style={{ fontSize: 11, color: warn ? "var(--red)" : "var(--t1)", fontWeight: warn ? 600 : 400 }}
      >
        {value}
      </span>
    </div>
  );
}

function LabelInput({
  label, suffix, ...rest
}: React.InputHTMLAttributes<HTMLInputElement> & { label?: string; suffix?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      {label && (
        <label style={{ fontSize: 10, color: "var(--t3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          {label}
        </label>
      )}
      <div style={{ position: "relative" }}>
        <input {...rest} className="input num" style={{ paddingRight: suffix ? 40 : undefined }} />
        {suffix && (
          <span
            style={{
              position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
              fontSize: 10, color: "var(--t3)",
            }}
          >
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}
