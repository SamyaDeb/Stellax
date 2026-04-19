/**
 * StellaxFunding — cumulative funding index per perp market.
 *
 * Actual ABI (confirmed by e2e):
 *   get_current_funding_rate(market_id: u32) → i128
 *   get_accumulated_funding(market_id: u32) → (i128, i128)  [long_idx, short_idx]
 *   estimate_funding_payment(position_id: u64) → i128
 *   update_funding(market_id: u32) → void
 *   version() → u32
 *
 * Notes:
 *  • MAX_FUNDING_RATE_PER_HOUR = 1e15 (bigint)
 *  • When mark >> oracle (e.g. vAMM $100 vs oracle $0.17), rate is clamped at max.
 *  • Longs pay funding (long_idx positive = they owe more), shorts receive.
 *  • estimate_funding_payment takes a position_id (not a full Position struct).
 */

import { ContractClient } from "../core/client.js";
import { enc, dec } from "../core/scval.js";
import type { InvokeOptions, InvokeResult } from "../core/executor.js";

export class FundingClient extends ContractClient {
  // ─── Reads ─────────────────────────────────────────────────────────────────

  /**
   * Current hourly funding rate in 18-decimal. Clamped at MAX = 1e15.
   * Positive means longs pay, negative means shorts pay.
   */
  getCurrentFundingRate(marketId: number): Promise<bigint> {
    return this.simulateReturn(
      "get_current_funding_rate",
      [enc.u32(marketId)],
      dec.bigint,
    );
  }

  /**
   * Accumulated funding indices as [longIdx, shortIdx].
   * longIdx increases when mark > oracle (longs pay).
   * shortIdx decreases (shorts receive payments).
   */
  getAccumulatedFunding(marketId: number): Promise<[bigint, bigint]> {
    return this.simulateReturn(
      "get_accumulated_funding",
      [enc.u32(marketId)],
      (v) => {
        const native = dec.raw(v) as [bigint, bigint];
        return [BigInt(native[0]), BigInt(native[1])];
      },
    );
  }

  /**
   * Estimated funding payment for a position.
   * Negative = longs pay (cost), positive = shorts receive.
   * @param positionId  The perp position ID
   */
  estimateFundingPayment(positionId: bigint): Promise<bigint> {
    return this.simulateReturn(
      "estimate_funding_payment",
      [enc.u64(positionId)],
      dec.bigint,
    );
  }

  version(): Promise<number> {
    return this.simulateReturn("version", [], dec.number);
  }

  // ─── Writes ────────────────────────────────────────────────────────────────

  /**
   * Advance the funding accumulator for a market.
   * Permissionless — anyone can call; typically called by the keeper.
   */
  updateFunding(marketId: number, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("update_funding", [enc.u32(marketId)], opts);
  }

  upgrade(newWasmHash: Uint8Array, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("upgrade", [enc.bytesN(newWasmHash)], opts);
  }
}
