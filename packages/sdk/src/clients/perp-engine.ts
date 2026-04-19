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

  upgrade(newWasmHash: Uint8Array, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("upgrade", [enc.bytesN(newWasmHash)], opts);
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
}
