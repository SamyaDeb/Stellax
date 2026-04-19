/**
 * StellaxOracle — RedStone-signed price pushes with freshness guards.
 *
 * Actual ABI (confirmed by e2e):
 *   write_prices(payload: Bytes) → void
 *   get_price(feed_id: Symbol) → PriceData { price, package_timestamp, write_timestamp }
 *   get_prices(feeds: Vec<Symbol>) → Vec<PriceData>
 *   update_config(signers: Vec<Bytes>, threshold: u32, staleness_ms: u64, feed_ids: Vec<Symbol>) → void
 *   version() → u32
 */

import { ContractClient } from "../core/client.js";
import { enc, dec, structs } from "../core/scval.js";
import type { InvokeOptions, InvokeResult } from "../core/executor.js";
import type { PriceData } from "../core/types.js";

export class OracleClient extends ContractClient {
  // ─── Reads ─────────────────────────────────────────────────────────────────

  /** Fetch the stored price + timestamps for a single feed (e.g. "XLM"). */
  getPrice(feedId: string): Promise<PriceData> {
    return this.simulateReturn("get_price", [enc.symbol(feedId)], structs.priceData);
  }

  /**
   * Fetch prices for multiple feeds in one call.
   * @param feedIds e.g. ["XLM", "BTC", "ETH", "SOL", "USDC"]
   */
  getPrices(feedIds: string[]): Promise<PriceData[]> {
    return this.simulateReturn(
      "get_prices",
      [enc.vec(feedIds.map(enc.symbol))],
      (v) => dec.vec(v, (item) => structs.priceData(item)),
    );
  }

  version(): Promise<number> {
    return this.simulateReturn("version", [], dec.number);
  }

  // ─── Writes ────────────────────────────────────────────────────────────────

  /**
   * Push a signed RedStone binary payload onto the chain.
   * The payload is obtained via `@redstone-finance/sdk` + protocol serializer.
   */
  writePrices(payload: Uint8Array, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("write_prices", [enc.bytes(payload)], opts);
  }

  /**
   * Update oracle configuration (admin only).
   * @param signers     EVM addresses of accepted RedStone signers (20-byte each)
   * @param threshold   Minimum number of signers required per price point
   * @param stalenessMs Maximum age of a price in milliseconds (e.g. 86_400_000 = 24 h)
   * @param feedIds     Accepted price feed symbols (e.g. ["XLM","BTC","ETH","SOL","USDC"])
   */
  updateConfig(
    signers: Uint8Array[],
    threshold: number,
    stalenessMs: bigint,
    feedIds: string[],
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "update_config",
      [
        enc.vec(signers.map((s) => enc.bytes(s))),
        enc.u32(threshold),
        enc.u64(stalenessMs),
        enc.vec(feedIds.map(enc.symbol)),
      ],
      opts,
    );
  }

  setAdmin(newAdmin: string, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("set_admin", [enc.address(newAdmin)], opts);
  }

  upgrade(newWasmHash: Uint8Array, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("upgrade", [enc.bytesN(newWasmHash)], opts);
  }
}
