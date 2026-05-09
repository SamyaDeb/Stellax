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
   * Push a non-RedStone admin price, used for RWA NAV feeds such as
   * BENJI/USDY/OUSG. `price18` is 18-decimal fixed point and
   * `packageTimestampMs` is the issuer/source timestamp in milliseconds.
   */
  adminPushPrice(
    feedId: string,
    price18: bigint,
    packageTimestampMs: bigint,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "admin_push_price",
      [enc.symbol(feedId), enc.i128(price18), enc.u64(packageTimestampMs)],
      opts,
    );
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

  // ─── Tier 2a — Per-symbol staleness overrides ──────────────────────────────

  setSymbolStaleness(
    feedId: string,
    maxAgeMs: bigint,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "set_symbol_staleness",
      [enc.symbol(feedId), enc.u64(maxAgeMs)],
      opts,
    );
  }

  clearSymbolStaleness(feedId: string, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("clear_symbol_staleness", [enc.symbol(feedId)], opts);
  }

  getSymbolStaleness(feedId: string): Promise<bigint> {
    return this.simulateReturn(
      "get_symbol_staleness",
      [enc.symbol(feedId)],
      dec.bigint,
    );
  }

  // ─── Tier 2b — Pyth pull-mode admin ────────────────────────────────────────

  setPythConfig(
    pythContract: string,
    maxAgeMs: bigint,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "set_pyth_config",
      [enc.address(pythContract), enc.u64(maxAgeMs)],
      opts,
    );
  }

  setPythFeedId(
    feedId: string,
    pythFeedIdBytes32: Uint8Array,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    if (pythFeedIdBytes32.length !== 32) {
      throw new Error(`pythFeedIdBytes32 must be 32 bytes, got ${pythFeedIdBytes32.length}`);
    }
    return this.invoke(
      "set_pyth_feed_id",
      [enc.symbol(feedId), enc.bytesN(pythFeedIdBytes32)],
      opts,
    );
  }

  removePythFeedId(feedId: string, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("remove_pyth_feed_id", [enc.symbol(feedId)], opts);
  }

  /**
   * Submit a Pyth Wormhole VAA to refresh prices for the given symbols.
   * Verification is performed by the configured Pyth Soroban contract.
   * Returns the number of symbols whose prices were written.
   */
  submitPythUpdate(
    updateData: Uint8Array,
    feedIds: string[],
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "submit_pyth_update",
      [enc.bytes(updateData), enc.vec(feedIds.map(enc.symbol))],
      opts,
    );
  }
}

/**
 * Tier 2b — Fetch a Pyth price update VAA from a Hermes endpoint.
 *
 * Hermes is Pyth's hosted price-update relayer. Given one or more 32-byte
 * Pyth price feed ids, it returns a binary blob (VAA) signed by the
 * Wormhole guardian set, which can then be passed to
 * `OracleClient.submitPythUpdate` (or
 * `PerpEngineClient.openPositionWithUpdate`).
 *
 * @param hermesUrl  e.g. https://hermes.pyth.network
 * @param feedIdsHex 32-byte feed ids as hex strings (with or without 0x).
 *                   See https://pyth.network/developers/price-feed-ids.
 * @returns Uint8Array with the binary `update_data` payload.
 */
export async function fetchPythVaa(
  hermesUrl: string,
  feedIdsHex: string[],
): Promise<Uint8Array> {
  if (feedIdsHex.length === 0) {
    throw new Error("fetchPythVaa: feedIdsHex must not be empty");
  }
  const params = new URLSearchParams();
  for (const id of feedIdsHex) {
    const clean = id.startsWith("0x") ? id.slice(2) : id;
    if (clean.length !== 64) {
      throw new Error(`fetchPythVaa: expected 32-byte hex, got ${clean.length / 2}`);
    }
    params.append("ids[]", clean);
  }
  // `encoding=hex` returns a hex string under data[].
  params.append("encoding", "hex");
  params.append("parsed", "false");

  const url = `${hermesUrl.replace(/\/$/, "")}/v2/updates/price/latest?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetchPythVaa: Hermes ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { binary?: { data?: string[] } };
  const data = body?.binary?.data;
  if (!data || data.length === 0) {
    throw new Error("fetchPythVaa: Hermes returned no binary data");
  }
  // Concatenate all returned hex blobs into a single byte array.
  const hex = data.join("");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
