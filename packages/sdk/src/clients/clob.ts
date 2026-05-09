/**
 * StellaxClob — hybrid CLOB: on-chain settlement of off-chain-matched
 * limit orders for the V2 perp engine.
 *
 * ABI (from contracts/stellax-clob/src/lib.rs):
 *   place_order(order: LimitOrder) → u64                     [trader auth]
 *   cancel_order(caller: Address, order_id: u64) → void      [trader auth]
 *   settle_matched_orders(caller, buy_id, sell_id) → i128    [keeper auth]
 *   get_order(order_id: u64) → LimitOrder
 *   get_nonce(trader: Address) → u64
 *   get_config() → ClobConfig
 *   update_config(perp_engine, vault, keeper) → void         [admin auth]
 *   upgrade(new_wasm_hash: BytesN<32>) → void                [admin auth]
 *   version() → u32
 *
 * LimitOrder layout (stellax-math::types::LimitOrder):
 *   order_id: u64       (ignored on placement — on-chain overrides)
 *   trader: Address
 *   market_id: u32
 *   size: i128          (18-dec base units)
 *   price: i128         (18-dec limit price)
 *   is_long: bool
 *   leverage: u32
 *   expiry: u64         (unix seconds)
 *   nonce: u64          (must equal get_nonce(trader))
 *   signature: BytesN<64>  (reserved for off-chain Ed25519 flows)
 *   status: OrderStatus
 *   filled_size: i128
 */

import { Address, xdr } from "@stellar/stellar-sdk";
import { ContractClient } from "../core/client.js";
import { enc, dec } from "../core/scval.js";
import type { InvokeOptions, InvokeResult } from "../core/executor.js";

/** Matches the Rust `OrderStatus` enum variants. */
export type OrderStatus = "Open" | "Filled" | "Cancelled" | "Expired";

export interface LimitOrder {
  orderId: bigint;
  trader: string;
  marketId: number;
  size: bigint;
  price: bigint;
  isLong: boolean;
  leverage: number;
  expiry: bigint;
  nonce: bigint;
  signature: Uint8Array; // 64 bytes
  status: OrderStatus;
  filledSize: bigint;
}

export interface ClobConfig {
  admin: string;
  perpEngine: string;
  vault: string;
  keeper: string;
}

/** Encode a LimitOrder struct into an ScVal map for place_order. */
function encodeLimitOrder(env: {
  orderId?: bigint;
  trader: string;
  marketId: number;
  size: bigint;
  price: bigint;
  isLong: boolean;
  leverage: number;
  expiry: bigint;
  nonce: bigint;
  signature: Uint8Array;
}): xdr.ScVal {
  if (env.signature.length !== 64) {
    throw new Error(`LimitOrder.signature must be 64 bytes (got ${env.signature.length})`);
  }
  // Field order matches the Rust struct — ScMap entries are sorted by key
  // lexicographically when built via scvMap(), so we pre-sort.
  const fields: Array<[string, xdr.ScVal]> = [
    ["filled_size", enc.i128(0n)],
    ["expiry", enc.u64(env.expiry)],
    ["is_long", enc.bool(env.isLong)],
    ["leverage", enc.u32(env.leverage)],
    ["market_id", enc.u32(env.marketId)],
    ["nonce", enc.u64(env.nonce)],
    ["order_id", enc.u64(env.orderId ?? 0n)],
    ["price", enc.i128(env.price)],
    ["signature", enc.bytesN(env.signature)],
    ["size", enc.i128(env.size)],
    ["status", enc.enumUnit("Open")],
    ["trader", new Address(env.trader).toScVal()],
  ];
  fields.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const entries = fields.map(
    ([k, v]) =>
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol(k),
        val: v,
      }),
  );
  return xdr.ScVal.scvMap(entries);
}

function decodeLimitOrder(v: xdr.ScVal | undefined): LimitOrder {
  const o = (dec.raw(v) as Record<string, unknown>) ?? {};
  const sig = o.signature;
  const statusRaw = o.status;
  // enum unit variants come back as a plain string from scValToNative after vec unwrap
  let status: OrderStatus = "Open";
  if (typeof statusRaw === "string") {
    status = statusRaw as OrderStatus;
  } else if (Array.isArray(statusRaw) && statusRaw.length > 0) {
    status = String(statusRaw[0]) as OrderStatus;
  }
  return {
    orderId: BigInt(o.order_id as bigint | number),
    trader: String(o.trader),
    marketId: Number(o.market_id),
    size: BigInt(o.size as bigint | number),
    price: BigInt(o.price as bigint | number),
    isLong: Boolean(o.is_long),
    leverage: Number(o.leverage),
    expiry: BigInt(o.expiry as bigint | number),
    nonce: BigInt(o.nonce as bigint | number),
    signature:
      sig instanceof Uint8Array
        ? sig
        : new Uint8Array(sig as ArrayBufferLike),
    status,
    filledSize: BigInt(o.filled_size as bigint | number),
  };
}

function decodeClobConfig(v: xdr.ScVal | undefined): ClobConfig {
  const o = (dec.raw(v) as Record<string, unknown>) ?? {};
  return {
    admin: String(o.admin),
    perpEngine: String(o.perp_engine),
    vault: String(o.vault),
    keeper: String(o.keeper),
  };
}

export class ClobClient extends ContractClient {
  // ─── Reads ─────────────────────────────────────────────────────────────────

  /** Fetch a single order by ID. */
  getOrder(orderId: bigint): Promise<LimitOrder> {
    return this.simulateReturn("get_order", [enc.u64(orderId)], decodeLimitOrder);
  }

  /** Current monotonic nonce for a trader — next order must use this value. */
  getNonce(trader: string): Promise<bigint> {
    return this.simulateReturn("get_nonce", [enc.address(trader)], dec.bigint);
  }

  /** Contract configuration (admin, perp_engine, vault, keeper). */
  getConfig(): Promise<ClobConfig> {
    return this.simulateReturn("get_config", [], decodeClobConfig);
  }

  version(): Promise<number> {
    return this.simulateReturn("version", [], dec.number);
  }

  // ─── Writes ────────────────────────────────────────────────────────────────

  /**
   * Submit a signed limit order.
   * `orderId` and `filledSize` are overridden on-chain — pass 0 for `orderId`.
   * The caller must be authenticated as `order.trader`.
   */
  placeOrder(
    order: {
      trader: string;
      marketId: number;
      size: bigint;
      price: bigint;
      isLong: boolean;
      leverage: number;
      expiry: bigint;
      nonce: bigint;
      signature: Uint8Array;
    },
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke("place_order", [encodeLimitOrder(order)], opts);
  }

  /** Cancel an open order you own. */
  cancelOrder(caller: string, orderId: bigint, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke(
      "cancel_order",
      [enc.address(caller), enc.u64(orderId)],
      opts,
    );
  }

  /**
   * Keeper-only: settle a matched buy/sell pair atomically through the
   * perp engine. Returns the fill size (i128, 18-dec base units).
   */
  settleMatchedOrders(
    caller: string,
    buyId: bigint,
    sellId: bigint,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "settle_matched_orders",
      [enc.address(caller), enc.u64(buyId), enc.u64(sellId)],
      opts,
    );
  }

  /** Admin-only. */
  updateConfig(
    perpEngine: string,
    vault: string,
    keeper: string,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "update_config",
      [enc.address(perpEngine), enc.address(vault), enc.address(keeper)],
      opts,
    );
  }

  /** Admin-only WASM upgrade. */
  upgrade(newWasmHash: Uint8Array, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("upgrade", [enc.bytesN(newWasmHash)], opts);
  }
}
