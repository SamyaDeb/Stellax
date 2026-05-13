/**
 * StellaxPerpEngine — perpetual futures: open, close, liquidate.
 *
 * Actual ABI (confirmed by e2e):
 *   open_position(user, market_id, size, is_long, leverage, max_slippage_bps, price_payload) → u64
 *   close_position(user, position_id, price_payload) → void
 *   get_position(user, position_id) → Position
 *   get_unrealized_pnl(position_id) → i128
 *   get_mark_price(market_id) → i128
 *   liquidate(liquidator, position_id) → void   [via risk engine]
 *   version() → u32
 *
 * Notes:
 *  • price_payload = None → xdr.ScVal.scvVoid() — pass undefined to use that default
 *  • open_position arg order: user, market_id, size, is_long, leverage, max_slippage_bps, payload
 *  • get_position takes both user AND position_id (two args)
 *  • MAX_SLIPPAGE_BYPASS = 1_000_000_000 to bypass the oracle/vAMM divergence guard
 */

import { xdr } from "@stellar/stellar-sdk";
import { ContractClient } from "../core/client.js";
import { enc, dec, structs } from "../core/scval.js";
import type { InvokeOptions, InvokeResult } from "../core/executor.js";
import type { Position, Market, OpenInterest } from "../core/types.js";

// Pyth feed IDs are 32-byte values passed as BytesN<32> to Soroban.
// The hex string form (64 chars) must be decoded to raw bytes — enc.symbol
// is Soroban's short-symbol type (≤32 chars) and will reject 64-char IDs.
function feedIdToBytes(hex: string): xdr.ScVal {
  const h = hex.replace(/^0x/, "");
  const buf = new Uint8Array(h.length / 2);
  for (let i = 0; i < buf.length; i++) buf[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return enc.bytesN(buf);
}

/** V2 per-market skew accounting, returned by get_skew_state. */
export interface SkewState {
  skew: bigint;
  skewScale: bigint;
  makerRebateBps: number;
}

/** Two-phase pending-order types mirrored from the perp-engine contract. */
export type OrderTypeVariant =
  | { kind: "Market" }
  | { kind: "Limit"; price: bigint }
  | { kind: "StopLoss"; price: bigint }
  | { kind: "TakeProfit"; price: bigint }
  | { kind: "Trailing"; offset: bigint; anchor: bigint };

export interface PendingOrder {
  orderId: bigint;
  user: string;
  marketId: number;
  size: bigint;
  isLong: boolean;
  leverage: number;
  maxSlippage: number;
  orderType: OrderTypeVariant;
  createdLedger: number;
  expiryLedger: number;
}

function encodeOrderType(v: OrderTypeVariant): xdr.ScVal {
  switch (v.kind) {
    case "Market":
      return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Market")]);
    case "Limit":
      return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Limit"), enc.i128(v.price)]);
    case "StopLoss":
      return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("StopLoss"), enc.i128(v.price)]);
    case "TakeProfit":
      return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("TakeProfit"), enc.i128(v.price)]);
    case "Trailing":
      return xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("Trailing"),
        enc.i128(v.offset),
        enc.i128(v.anchor),
      ]);
  }
}

function decodeOrderType(raw: unknown): OrderTypeVariant {
  if (Array.isArray(raw)) {
    const [tag, payload, payload2] = raw as [string, unknown, unknown];
    switch (tag) {
      case "Market":
        return { kind: "Market" };
      case "Limit":
        return { kind: "Limit", price: BigInt(payload as bigint | number) };
      case "StopLoss":
        return { kind: "StopLoss", price: BigInt(payload as bigint | number) };
      case "TakeProfit":
        return { kind: "TakeProfit", price: BigInt(payload as bigint | number) };
      case "Trailing":
        return {
          kind: "Trailing",
          offset: BigInt(payload as bigint | number),
          anchor: BigInt(payload2 as bigint | number),
        };
    }
  }
  return { kind: "Market" };
}

/** Phase R — bracket order grouping (parent + take-profit + stop-loss). */
export interface BracketGroup {
  parentId: bigint;
  takeProfitId: bigint;
  stopLossId: bigint;
  user: string;
  active: boolean;
}

/** Phase R — TWAP execution plan (slice a large order over time). */
export interface TwapPlan {
  planId: bigint;
  user: string;
  marketId: number;
  totalSize: bigint;
  sizeFilled: bigint;
  isLong: boolean;
  leverage: number;
  maxSlippage: number;
  slices: number;
  slicesReleased: number;
  intervalLedgers: number;
  startLedger: number;
  expiryLedger: number;
  active: boolean;
}

/** Phase R — Iceberg execution plan (mint visible chunks of a hidden total). */
export interface IcebergPlan {
  planId: bigint;
  user: string;
  marketId: number;
  totalSize: bigint;
  displaySize: bigint;
  sizeFilled: bigint;
  isLong: boolean;
  leverage: number;
  maxSlippage: number;
  entryPrice: bigint;
  expiryLedger: number;
  active: boolean;
}

/** Static market definitions — the perp engine has no list_markets on-chain. */
export const STATIC_MARKETS: Market[] = [
  {
    marketId: 0,
    baseAsset: "XLM",
    quoteAsset: "USD",
    maxLeverage: 20,
    makerFeeBps: 5,
    takerFeeBps: 10,
    maxOiLong: 10_000_000_000_000_000_000_000n,
    maxOiShort: 10_000_000_000_000_000_000_000n,
    isActive: true,
  },
  {
    marketId: 1,
    baseAsset: "BTC",
    quoteAsset: "USD",
    maxLeverage: 50,
    makerFeeBps: 5,
    takerFeeBps: 10,
    maxOiLong: 10_000_000_000_000_000_000_000n,
    maxOiShort: 10_000_000_000_000_000_000_000n,
    isActive: true,
  },
  {
    marketId: 2,
    baseAsset: "ETH",
    quoteAsset: "USD",
    maxLeverage: 20,
    makerFeeBps: 5,
    takerFeeBps: 10,
    maxOiLong: 10_000_000_000_000_000_000_000n,
    maxOiShort: 10_000_000_000_000_000_000_000n,
    isActive: true,
  },
  {
    marketId: 3,
    baseAsset: "SOL",
    quoteAsset: "USD",
    maxLeverage: 20,
    makerFeeBps: 5,
    takerFeeBps: 10,
    maxOiLong: 10_000_000_000_000_000_000_000n,
    maxOiShort: 10_000_000_000_000_000_000_000n,
    isActive: true,
  },
  // ─── Phase Ω6: RWA perpetuals ─────────────────────────────────────────────
  // Conservative parameters: lower leverage + smaller OI caps. Tradable once
  // `register_market` has been invoked on testnet (see docs/rwa-launch-runbook.md).
  {
    marketId: 100,
    baseAsset: "BENJI",
    quoteAsset: "USD",
    maxLeverage: 3,
    makerFeeBps: 5,
    takerFeeBps: 15,
    maxOiLong: 100_000_000_000_000_000_000n,
    maxOiShort: 100_000_000_000_000_000_000n,
    badge: "RWA",
    isActive: true,
  },
  {
    marketId: 101,
    baseAsset: "USDY",
    quoteAsset: "USD",
    maxLeverage: 3,
    makerFeeBps: 5,
    takerFeeBps: 15,
    maxOiLong: 100_000_000_000_000_000_000n,
    maxOiShort: 100_000_000_000_000_000_000n,
    badge: "RWA",
    isActive: true,
  },
  {
    marketId: 102,
    baseAsset: "OUSG",
    quoteAsset: "USD",
    maxLeverage: 3,
    makerFeeBps: 5,
    takerFeeBps: 15,
    maxOiLong: 100_000_000_000_000_000_000n,
    maxOiShort: 100_000_000_000_000_000_000n,
    badge: "RWA",
    isActive: true,
  },
];

export class PerpEngineClient extends ContractClient {
  // ─── Reads ─────────────────────────────────────────────────────────────────

  /**
   * Fetch a stored position.
   * @param user        Owner of the position
   * @param positionId  ID returned by openPosition
   */
  getPosition(user: string, positionId: bigint): Promise<Position> {
    return this.simulateReturn(
      "get_position",
      [enc.address(user), enc.u64(positionId)],
      structs.position,
    );
  }

  /**
   * Unrealized PnL in 18-decimal USDC.
   * Calculated against the oracle index price (not vAMM mark price).
   */
  getUnrealizedPnl(positionId: bigint): Promise<bigint> {
    return this.simulateReturn(
      "get_unrealized_pnl",
      [enc.u64(positionId)],
      dec.bigint,
    );
  }

  /**
   * Current vAMM mark price in 18-decimal precision for a market.
   */
  getMarkPrice(marketId: number): Promise<bigint> {
    return this.simulateReturn("get_mark_price", [enc.u32(marketId)], dec.bigint);
  }

  version(): Promise<number> {
    return this.simulateReturn("version", [], dec.number);
  }

  // ─── Writes ────────────────────────────────────────────────────────────────

  /**
   * Open a perpetual position.
   *
   * @param user            Trader's Stellar address
   * @param marketId        Market index (0=XLM, 1=BTC, 2=ETH, 3=SOL)
   * @param size            Position size in 18-decimal base-asset units
   * @param isLong          true for long, false for short
   * @param leverage        Leverage multiplier (e.g. 5 for 5×)
   * @param maxSlippageBps  Maximum allowed slippage in basis points.
   *                        Pass 1_000_000_000 to bypass the oracle/vAMM divergence guard.
   * @param pricePayload    Optional RedStone price bytes. Pass undefined for None.
   * @returns               The new position_id as a bigint (returned in InvokeResult.returnValue)
   */
  openPosition(
    user: string,
    marketId: number,
    size: bigint,
    isLong: boolean,
    leverage: number,
    maxSlippageBps: number,
    opts: InvokeOptions,
    pricePayload?: Uint8Array,
  ): Promise<InvokeResult> {
    return this.invoke(
      "open_position",
      [
        enc.address(user),
        enc.u32(marketId),
        enc.i128(size),
        enc.bool(isLong),
        enc.u32(leverage),
        enc.u32(maxSlippageBps),
        pricePayload !== undefined ? enc.bytes(pricePayload) : xdr.ScVal.scvVoid(),
      ],
      opts,
    );
  }

  /**
   * Close an open position.
   *
   * @param user          Owner of the position
   * @param positionId    ID of the position to close
   * @param pricePayload  Optional RedStone price bytes. Pass undefined for None.
   */
  closePosition(
    user: string,
    positionId: bigint,
    opts: InvokeOptions,
    pricePayload?: Uint8Array,
  ): Promise<InvokeResult> {
    return this.invoke(
      "close_position",
      [
        enc.address(user),
        enc.u64(positionId),
        pricePayload !== undefined ? enc.bytes(pricePayload) : xdr.ScVal.scvVoid(),
      ],
      opts,
    );
  }

  /**
   * Tier 3 — Pull-on-trade variant of `openPosition`.
   *
   * Submits a Pyth Wormhole VAA (`pythUpdateData`) to the oracle for
   * `pythFeedIds` first, then opens the position. Use when the trade
   * depends on an asset (e.g. XLM, USDC) backed by Pyth pull-mode rather
   * than the keeper's continuous push.
   */
  openPositionWithUpdate(
    user: string,
    marketId: number,
    size: bigint,
    isLong: boolean,
    leverage: number,
    maxSlippageBps: number,
    pythUpdateData: Uint8Array,
    pythFeedIds: string[],
    opts: InvokeOptions,
    pricePayload?: Uint8Array,
  ): Promise<InvokeResult> {
    return this.invoke(
      "open_position_with_update",
      [
        enc.address(user),
        enc.u32(marketId),
        enc.i128(size),
        enc.bool(isLong),
        enc.u32(leverage),
        enc.u32(maxSlippageBps),
        pricePayload !== undefined ? enc.bytes(pricePayload) : xdr.ScVal.scvVoid(),
        enc.bytes(pythUpdateData),
        enc.vec(pythFeedIds.map(feedIdToBytes)),
      ],
      opts,
    );
  }

  /** Tier 3 — Pull-on-trade variant of `closePosition`. */
  closePositionWithUpdate(
    user: string,
    positionId: bigint,
    pythUpdateData: Uint8Array,
    pythFeedIds: string[],
    opts: InvokeOptions,
    pricePayload?: Uint8Array,
  ): Promise<InvokeResult> {
    return this.invoke(
      "close_position_with_update",
      [
        enc.address(user),
        enc.u64(positionId),
        pricePayload !== undefined ? enc.bytes(pricePayload) : xdr.ScVal.scvVoid(),
        enc.bytes(pythUpdateData),
        enc.vec(pythFeedIds.map(feedIdToBytes)),
      ],
      opts,
    );
  }

  upgrade(newWasmHash: Uint8Array, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("upgrade", [enc.bytesN(newWasmHash)], opts);
  }

  // ─── V2 entry points ───────────────────────────────────────────────────────

  /** V2: current OI imbalance + skew parameters for a market. */
  getSkewState(marketId: number): Promise<SkewState> {
    return this.simulateReturn(
      "get_skew_state",
      [enc.u32(marketId)],
      (v) => {
        const o = (dec.raw(v) as Record<string, unknown>) ?? {};
        return {
          skew: BigInt(o.skew as bigint | number),
          skewScale: BigInt(o.skew_scale as bigint | number),
          makerRebateBps: Number(o.maker_rebate_bps),
        };
      },
    );
  }

  /** V2: admin binds the CLOB contract address for `execute_clob_fill` gating. */
  setClob(clob: string, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("set_clob", [enc.address(clob)], opts);
  }

  /** V2: read the currently-registered CLOB address (undefined if unset). */
  async getClob(): Promise<string | undefined> {
    return this.simulateReturn("get_clob", [], (v) => {
      const raw = dec.raw(v);
      return raw == null ? undefined : String(raw);
    });
  }

  /**
   * V2: create a pending (two-phase) order stored in Temporary storage.
   * The keeper executes it once the trigger condition is met.
   * `expiryLedgerOffset` — ledgers (from current) after which the order auto-expires.
   */
  createOrder(
    user: string,
    marketId: number,
    size: bigint,
    isLong: boolean,
    leverage: number,
    maxSlippageBps: number,
    orderType: OrderTypeVariant,
    expiryLedgerOffset: number,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "create_order",
      [
        enc.address(user),
        enc.u32(marketId),
        enc.i128(size),
        enc.bool(isLong),
        enc.u32(leverage),
        enc.u32(maxSlippageBps),
        encodeOrderType(orderType),
        enc.u32(expiryLedgerOffset),
      ],
      opts,
    );
  }

  /** V2: keeper executes a pending order after its trigger fires. */
  executeOrder(
    caller: string,
    orderId: bigint,
    opts: InvokeOptions,
    pricePayload?: Uint8Array,
  ): Promise<InvokeResult> {
    return this.invoke(
      "execute_order",
      [
        enc.address(caller),
        enc.u64(orderId),
        pricePayload !== undefined ? enc.bytes(pricePayload) : xdr.ScVal.scvVoid(),
      ],
      opts,
    );
  }

  /** V2: user cancels their own pending order. */
  cancelPendingOrder(
    user: string,
    orderId: bigint,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "cancel_pending_order",
      [enc.address(user), enc.u64(orderId)],
      opts,
    );
  }

  /** V2: read a pending order by ID. */
  getPendingOrder(orderId: bigint): Promise<PendingOrder> {
    return this.simulateReturn("get_pending_order", [enc.u64(orderId)], (v) => {
      const o = (dec.raw(v) as Record<string, unknown>) ?? {};
      return {
        orderId: BigInt(o.order_id as bigint | number),
        user: String(o.user),
        marketId: Number(o.market_id),
        size: BigInt(o.size as bigint | number),
        isLong: Boolean(o.is_long),
        leverage: Number(o.leverage),
        maxSlippage: Number(o.max_slippage),
        orderType: decodeOrderType(o.order_type),
        createdLedger: Number(o.created_ledger),
        expiryLedger: Number(o.expiry_ledger),
      };
    });
  }

  // ─── Phase R: advanced order types ─────────────────────────────────────────

  /** Phase R: keeper ratchets the trailing-stop anchor (one-way only). */
  updateTrailingAnchor(
    caller: string,
    orderId: bigint,
    newAnchor: bigint,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "update_trailing_anchor",
      [enc.address(caller), enc.u64(orderId), enc.i128(newAnchor)],
      opts,
    );
  }

  /** Phase R: link parent + TP + SL pending orders into a bracket group. */
  bracketLink(
    user: string,
    parentId: bigint,
    takeProfitId: bigint,
    stopLossId: bigint,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "bracket_link",
      [
        enc.address(user),
        enc.u64(parentId),
        enc.u64(takeProfitId),
        enc.u64(stopLossId),
      ],
      opts,
    );
  }

  /** Phase R: keeper cancels surviving sibling after one bracket leg fires. */
  cancelBracketSibling(
    caller: string,
    parentId: bigint,
    survivorId: bigint,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "cancel_bracket_sibling",
      [enc.address(caller), enc.u64(parentId), enc.u64(survivorId)],
      opts,
    );
  }

  /** Phase R: create a TWAP plan slicing total_size into N timed releases. */
  createTwapPlan(
    user: string,
    marketId: number,
    totalSize: bigint,
    isLong: boolean,
    leverage: number,
    maxSlippageBps: number,
    slices: number,
    intervalLedgers: number,
    expiryLedgerOffset: number,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "create_twap_plan",
      [
        enc.address(user),
        enc.u32(marketId),
        enc.i128(totalSize),
        enc.bool(isLong),
        enc.u32(leverage),
        enc.u32(maxSlippageBps),
        enc.u32(slices),
        enc.u32(intervalLedgers),
        enc.u32(expiryLedgerOffset),
      ],
      opts,
    );
  }

  /** Phase R: keeper releases the next TWAP slice as a child Market order. */
  releaseTwapSlice(
    caller: string,
    planId: bigint,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "release_twap_slice",
      [enc.address(caller), enc.u64(planId)],
      opts,
    );
  }

  /** Phase R: create an iceberg plan exposing display_size at a time. */
  createIcebergPlan(
    user: string,
    marketId: number,
    totalSize: bigint,
    displaySize: bigint,
    isLong: boolean,
    leverage: number,
    maxSlippageBps: number,
    entryPrice: bigint,
    expiryLedgerOffset: number,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "create_iceberg_plan",
      [
        enc.address(user),
        enc.u32(marketId),
        enc.i128(totalSize),
        enc.i128(displaySize),
        enc.bool(isLong),
        enc.u32(leverage),
        enc.u32(maxSlippageBps),
        enc.i128(entryPrice),
        enc.u32(expiryLedgerOffset),
      ],
      opts,
    );
  }

  /**
   * Phase R: keeper releases the next iceberg slice (Limit child order at
   * `entry_price`). Pass `filledAmount` = how much of the previous slice
   * was filled. On completion the contract returns Ok(0) sentinel.
   */
  releaseIcebergSlice(
    caller: string,
    planId: bigint,
    filledAmount: bigint,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "release_iceberg_slice",
      [enc.address(caller), enc.u64(planId), enc.i128(filledAmount)],
      opts,
    );
  }

  /** Phase R: read a bracket group by parent_id (undefined if missing). */
  getBracket(parentId: bigint): Promise<BracketGroup | undefined> {
    return this.simulateReturn("get_bracket", [enc.u64(parentId)], (v) => {
      const o = dec.raw(v) as Record<string, unknown> | null;
      if (!o) return undefined;
      return {
        parentId: BigInt(o.parent_id as bigint | number),
        takeProfitId: BigInt(o.take_profit_id as bigint | number),
        stopLossId: BigInt(o.stop_loss_id as bigint | number),
        user: String(o.user),
        active: Boolean(o.active),
      };
    });
  }

  /** Phase R: read a TWAP plan by id. */
  getTwapPlan(planId: bigint): Promise<TwapPlan | undefined> {
    return this.simulateReturn("get_twap_plan", [enc.u64(planId)], (v) => {
      const o = dec.raw(v) as Record<string, unknown> | null;
      if (!o) return undefined;
      return {
        planId: BigInt(o.plan_id as bigint | number),
        user: String(o.user),
        marketId: Number(o.market_id),
        totalSize: BigInt(o.total_size as bigint | number),
        sizeFilled: BigInt(o.size_filled as bigint | number),
        isLong: Boolean(o.is_long),
        leverage: Number(o.leverage),
        maxSlippage: Number(o.max_slippage),
        slices: Number(o.slices),
        slicesReleased: Number(o.slices_released),
        intervalLedgers: Number(o.interval_ledgers),
        startLedger: Number(o.start_ledger),
        expiryLedger: Number(o.expiry_ledger),
        active: Boolean(o.active),
      };
    });
  }

  /** Phase R: read an iceberg plan by id. */
  getIcebergPlan(planId: bigint): Promise<IcebergPlan | undefined> {
    return this.simulateReturn("get_iceberg_plan", [enc.u64(planId)], (v) => {
      const o = dec.raw(v) as Record<string, unknown> | null;
      if (!o) return undefined;
      return {
        planId: BigInt(o.plan_id as bigint | number),
        user: String(o.user),
        marketId: Number(o.market_id),
        totalSize: BigInt(o.total_size as bigint | number),
        displaySize: BigInt(o.display_size as bigint | number),
        sizeFilled: BigInt(o.size_filled as bigint | number),
        isLong: Boolean(o.is_long),
        leverage: Number(o.leverage),
        maxSlippage: Number(o.max_slippage),
        entryPrice: BigInt(o.entry_price as bigint | number),
        expiryLedger: Number(o.expiry_ledger),
        active: Boolean(o.active),
      };
    });
  }

  // ─── Convenience / UI helpers ──────────────────────────────────────────────

  /**
   * List all registered markets.
   * The perp engine has no `list_markets` on-chain; returns the static known set.
   */
  listMarkets(): Promise<Market[]> {
    return Promise.resolve(STATIC_MARKETS);
  }

  /**
   * Aggregate open interest for a market.
   * Not exposed by the on-chain ABI; returns zeroes until an indexer is wired.
   */
  getOpenInterest(_marketId: number): Promise<OpenInterest> {
    return Promise.resolve({ long: 0n, short: 0n });
  }

  /**
   * All open positions for a user.
   * The contract only supports point lookups (user + positionId); returns empty
   * until an indexer is available.
   */
  getUserPositions(_user: string): Promise<Position[]> {
    return Promise.resolve([]);
  }

  // ─── Phase 4: pause ────────────────────────────────────────────────────────

  /** Phase 4 — returns true when the perp-engine is paused. Read-only. */
  isPaused(): Promise<boolean> {
    return this.simulateReturn("is_paused", [], (v) => Boolean(dec.raw(v)));
  }

  /** Phase 4 — admin: halt all trading entry-points. */
  pause(opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("pause", [], opts);
  }

  /** Phase 4 — admin: resume trading. */
  unpause(opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("unpause", [], opts);
  }

  // ─── HLP wiring ────────────────────────────────────────────────────────────

  /**
   * Admin-only: configure the SLP vault address in the perp engine.
   * Must be called post-deployment (or post-upgrade) before any position
   * can be opened or closed — the engine uses the SLP vault as the sole
   * counterparty for PnL settlement.
   */
  setSlpVault(slpVault: string, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("set_slp_vault", [enc.address(slpVault)], opts);
  }

  /**
   * Read the SLP vault address currently wired into the perp engine.
   * Returns `undefined` when not yet configured.
   */
  getSlpVault(): Promise<string | undefined> {
    return this.simulateReturn("get_slp_vault", [], (v) => {
      if (!v || v.switch().name === "scvVoid") return undefined;
      return dec.address(v);
    });
  }
}
