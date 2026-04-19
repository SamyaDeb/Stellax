/**
 * StellaxOptions — European call/put writing, buying, and settlement.
 *
 * Actual ABI (confirmed by e2e):
 *   write_option(writer, market_id, strike, expiry, is_call, size) → u64
 *   buy_option(buyer, option_id) → void
 *   settle_option(option_id, price_payload) → void
 *   get_option(option_id) → OptionData
 *   get_implied_volatility(market_id) → VolSurface { sigma, updated_at }
 *   set_implied_volatility(market_id, iv) → void
 *   register_market(market_id, base_asset, is_active) → void
 *   version() → u32
 *
 * Notes:
 *  • MIN_EXPIRY_SECS = 30 (testnet) — expiry must be at least 30s from now
 *  • option_id encoding: high 32 bits = market_id, low 32 bits = sequence
 *  • settle_option has NO caller arg — settlement is permissionless
 *  • write_option has NO price_payload arg (strike is passed directly)
 *  • buy_option has NO price_payload arg
 *  • IV is in 18-decimal (e.g. 0.8e18 = 80% annualised)
 */

import { xdr } from "@stellar/stellar-sdk";
import { ContractClient } from "../core/client.js";
import { enc, dec, structs } from "../core/scval.js";
import type { InvokeOptions, InvokeResult } from "../core/executor.js";
import type { OptionContract } from "../core/types.js";

/** Implied volatility surface for a market. */
export interface VolSurface {
  sigma: bigint;
  updatedAt: bigint;
}

function decodeVolSurface(v: xdr.ScVal | undefined): VolSurface {
  const o = (dec.raw(v) as Record<string, unknown>) ?? {};
  return {
    sigma: BigInt(o.sigma as bigint | number),
    updatedAt: BigInt(o.updated_at as bigint | number),
  };
}

export class OptionsClient extends ContractClient {
  // ─── Reads ─────────────────────────────────────────────────────────────────

  /**
   * Fetch a stored option contract.
   */
  getOption(optionId: bigint): Promise<OptionContract> {
    return this.simulateReturn("get_option", [enc.u64(optionId)], structs.option);
  }

  /**
   * Implied volatility surface for a market.
   * @param marketId  e.g. 0 for XLM
   */
  getImpliedVolatility(marketId: number): Promise<VolSurface> {
    return this.simulateReturn(
      "get_implied_volatility",
      [enc.u32(marketId)],
      decodeVolSurface,
    );
  }

  version(): Promise<number> {
    return this.simulateReturn("version", [], dec.number);
  }

  // ─── Writes ────────────────────────────────────────────────────────────────

  /**
   * Write (issue) a new options contract.
   *
   * @param writer    The option writer — must have sufficient collateral in the vault
   * @param marketId  Market index (0=XLM, 1=BTC, 2=ETH, 3=SOL)
   * @param strike    Strike price in 18-decimal (e.g. 70% of oracle spot)
   * @param expiry    Unix timestamp in seconds when the option expires (>= now + 30s)
   * @param isCall    true = call, false = put
   * @param size      Notional size in 18-decimal base-asset units
   * @returns         InvokeResult with returnValue decodable to u64 option_id
   */
  writeOption(
    writer: string,
    marketId: number,
    strike: bigint,
    expiry: bigint,
    isCall: boolean,
    size: bigint,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "write_option",
      [
        enc.address(writer),
        enc.u32(marketId),
        enc.i128(strike),
        enc.u64(expiry),
        enc.bool(isCall),
        enc.i128(size),
      ],
      opts,
    );
  }

  /**
   * Buy an option — pays the premium from the buyer's vault balance to the writer.
   *
   * @param buyer     Address of the buyer (will become the option holder)
   * @param optionId  ID of the option to purchase
   */
  buyOption(
    buyer: string,
    optionId: bigint,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "buy_option",
      [enc.address(buyer), enc.u64(optionId)],
      opts,
    );
  }

  /**
   * Settle an expired option.
   * Permissionless — anyone can trigger settlement after expiry.
   *
   * @param optionId      ID of the expired option
   * @param pricePayload  Optional RedStone price bytes. Pass undefined for None.
   */
  settleOption(
    optionId: bigint,
    opts: InvokeOptions,
    pricePayload?: Uint8Array,
  ): Promise<InvokeResult> {
    return this.invoke(
      "settle_option",
      [
        enc.u64(optionId),
        pricePayload !== undefined ? enc.bytes(pricePayload) : xdr.ScVal.scvVoid(),
      ],
      opts,
    );
  }

  /**
   * Set implied volatility for a market (keeper/admin only).
   * @param iv  Annualised IV in 18-decimal (e.g. 800_000_000_000_000_000n = 80%)
   */
  setImpliedVolatility(
    marketId: number,
    iv: bigint,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "set_implied_volatility",
      [enc.u32(marketId), enc.i128(iv)],
      opts,
    );
  }

  /**
   * Register (or activate) an options market.
   */
  registerMarket(
    marketId: number,
    baseAsset: string,
    isActive: boolean,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "register_market",
      [enc.u32(marketId), enc.symbol(baseAsset), enc.bool(isActive)],
      opts,
    );
  }

  upgrade(newWasmHash: Uint8Array, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("upgrade", [enc.bytesN(newWasmHash)], opts);
  }

  // ─── Convenience / UI helpers ──────────────────────────────────────────────

  /** Static list of registered options market symbols. */
  listMarkets(): Promise<string[]> {
    return Promise.resolve(["XLM", "BTC", "ETH", "SOL"]);
  }

  /** Map an asset symbol to its market index. */
  private assetToMarketId(asset: string): number {
    const map: Record<string, number> = { XLM: 0, BTC: 1, ETH: 2, SOL: 3 };
    return map[asset.toUpperCase()] ?? 0;
  }

  /**
   * Implied volatility for an asset as a percentage (e.g. 80 = 80%).
   * Wraps getImpliedVolatility and converts from 18-dec sigma.
   */
  getImpliedVol(asset: string): Promise<number> {
    return this.getImpliedVolatility(this.assetToMarketId(asset)).then(
      (v) => Number(v.sigma) / 1e16, // 18-dec → percentage
    );
  }

  /**
   * Option IDs written by a user. No on-chain enumeration; returns empty until
   * an indexer is available.
   */
  getUserOptionsAsWriter(_user: string): Promise<bigint[]> {
    return Promise.resolve([]);
  }

  /**
   * Option IDs held (purchased) by a user. No on-chain enumeration; returns
   * empty until an indexer is available.
   */
  getUserOptionsAsHolder(_user: string): Promise<bigint[]> {
    return Promise.resolve([]);
  }

  /**
   * Off-chain premium quote. The contract does not have a quote endpoint;
   * returns 0 as a placeholder. In production, compute via Black-Scholes.
   */
  quotePremium(_params: {
    underlying: string;
    strike: bigint;
    expiry: bigint;
    isCall: boolean;
    size: bigint;
  }): Promise<bigint> {
    return Promise.resolve(0n);
  }

  /**
   * Write a new option — convenience wrapper using an object-param style.
   */
  createOption(params: {
    writer: string;
    underlying: string;
    strike: bigint;
    expiry: bigint;
    isCall: boolean;
    size: bigint;
    premium: bigint;
    opts: InvokeOptions;
  }): Promise<InvokeResult> {
    return this.writeOption(
      params.writer,
      this.assetToMarketId(params.underlying),
      params.strike,
      params.expiry,
      params.isCall,
      params.size,
      params.opts,
    );
  }

  /**
   * Exercise / settle an option (holder action).
   * Maps to `settleOption` which is permissionless — any caller can trigger
   * settlement of an expired ITM option.
   */
  exercise(
    _source: string,
    optionId: bigint,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.settleOption(optionId, opts);
  }

  /**
   * Cancel an unsold option (writer action).
   * The options contract has no explicit cancel endpoint; this is a no-op stub
   * that resolves with a synthetic FAILED result.
   */
  cancel(
    _source: string,
    _optionId: bigint,
    _opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return Promise.resolve({
      status: "FAILED" as const,
      hash: "",
      returnValue: undefined,
      latestLedger: 0,
    });
  }
}
