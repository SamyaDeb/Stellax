/**
 * StellaxRisk — account health checks and forced liquidations.
 *
 * Actual ABI (confirmed by e2e):
 *   get_account_health(user: Address) → AccountHealth
 *   liquidate(keeper: Address, user: Address, position_id: u64, price_payload: Option<Bytes>) → LiquidationOutcome
 *   version() → u32
 *
 * Notes:
 *  • AccountHealth is a struct: { equity, total_margin_required, margin_ratio, free_collateral, liquidatable }
 *  • LiquidationOutcome: { liquidated_size, oracle_price, remaining_margin, keeper_reward, insurance_delta, adl_triggered }
 *  • At position level, equity = position.margin + trade_pnl(oracle). When equity < maintenance, liquidatable.
 *  • At account level, equity = vault_collateral + sum(unrealized_pnl). Account liquidatable only when total equity < total maintenance.
 */

import { xdr } from "@stellar/stellar-sdk";
import { ContractClient } from "../core/client.js";
import { enc, dec } from "../core/scval.js";
import type { InvokeOptions, InvokeResult } from "../core/executor.js";

/** Health metrics for a user's entire account. */
export interface AccountHealth {
  equity: bigint;
  totalMarginRequired: bigint;
  marginRatio: bigint;
  freeCollateral: bigint;
  liquidatable: boolean;
}

/** Result of a forced liquidation. */
export interface LiquidationOutcome {
  liquidatedSize: bigint;
  oraclePrice: bigint;
  remainingMargin: bigint;
  keeperReward: bigint;
  insuranceDelta: bigint;
  adlTriggered: boolean;
}

/**
 * Phase C — portfolio-margin greeks snapshot.
 *
 * `netDelta` is a map of `market_id → signed net delta` (PRECISION-scaled
 * contract units). Long perps / long calls contribute positive, shorts and
 * long puts contribute negative. `netDeltaNotional` is the sum of
 * `|netDelta[m]| * oracle_price[m]` across markets and is what portfolio
 * margin is sized against.
 */
export interface PortfolioGreeks {
  netDelta: Map<number, bigint>;
  totalNotional: bigint;
  netDeltaNotional: bigint;
}

/** Phase C — portfolio-margin health snapshot. */
export interface PortfolioHealth {
  totalCollateralValue: bigint;
  portfolioMarginRequired: bigint;
  freeCollateral: bigint;
  liquidatable: boolean;
  netDeltaUsd: bigint;
}

function decodeAccountHealth(v: xdr.ScVal | undefined): AccountHealth {
  const o = (dec.raw(v) as Record<string, unknown>) ?? {};
  return {
    equity: BigInt(o.equity as bigint | number),
    totalMarginRequired: BigInt(o.total_margin_required as bigint | number),
    marginRatio: BigInt(o.margin_ratio as bigint | number),
    freeCollateral: BigInt(o.free_collateral as bigint | number),
    liquidatable: Boolean(o.liquidatable),
  };
}

function decodeLiquidationOutcome(v: xdr.ScVal | undefined): LiquidationOutcome {
  const o = (dec.raw(v) as Record<string, unknown>) ?? {};
  return {
    liquidatedSize: BigInt(o.liquidated_size as bigint | number),
    oraclePrice: BigInt(o.oracle_price as bigint | number),
    remainingMargin: BigInt(o.remaining_margin as bigint | number),
    keeperReward: BigInt(o.keeper_reward as bigint | number),
    insuranceDelta: BigInt(o.insurance_delta as bigint | number),
    adlTriggered: Boolean(o.adl_triggered),
  };
}

function decodePortfolioGreeks(v: xdr.ScVal | undefined): PortfolioGreeks {
  const o = (dec.raw(v) as Record<string, unknown>) ?? {};
  // `net_delta` is a Soroban Map<u32, i128>. dec.raw decodes maps into plain
  // JS objects keyed by stringified keys; convert back to `Map<number,bigint>`.
  const raw = (o.net_delta as Record<string, bigint | number> | undefined) ?? {};
  const netDelta = new Map<number, bigint>();
  for (const [k, val] of Object.entries(raw)) {
    netDelta.set(Number(k), BigInt(val));
  }
  return {
    netDelta,
    totalNotional: BigInt(o.total_notional as bigint | number),
    netDeltaNotional: BigInt(o.net_delta_notional as bigint | number),
  };
}

function decodePortfolioHealth(v: xdr.ScVal | undefined): PortfolioHealth {
  const o = (dec.raw(v) as Record<string, unknown>) ?? {};
  return {
    totalCollateralValue: BigInt(o.total_collateral_value as bigint | number),
    portfolioMarginRequired: BigInt(o.portfolio_margin_required as bigint | number),
    freeCollateral: BigInt(o.free_collateral as bigint | number),
    liquidatable: Boolean(o.liquidatable),
    netDeltaUsd: BigInt(o.net_delta_usd as bigint | number),
  };
}

export class RiskClient extends ContractClient {
  // ─── Reads ─────────────────────────────────────────────────────────────────

  /**
   * Full account health metrics for a user.
   * Includes cross-position equity, total maintenance margin, and liquidatability.
   */
  getAccountHealth(user: string): Promise<AccountHealth> {
    return this.simulateReturn(
      "get_account_health",
      [enc.address(user)],
      decodeAccountHealth,
    );
  }

  version(): Promise<number> {
    return this.simulateReturn("version", [], dec.number);
  }

  // ─── Phase C: Portfolio margin ────────────────────────────────────────────

  /**
   * Aggregate signed net delta per market across all of `user`'s perp and
   * option positions. Returns zero-filled values when the options engine is
   * not configured on the risk contract.
   */
  computePortfolioGreeks(user: string): Promise<PortfolioGreeks> {
    return this.simulateReturn(
      "compute_portfolio_greeks",
      [enc.address(user)],
      decodePortfolioGreeks,
    );
  }

  /**
   * Portfolio-margin health snapshot. Unlike `getAccountHealth`, this sizes
   * margin against the user's residual delta notional after hedges, which
   * rewards offsetting perp+option positions.
   */
  getPortfolioHealth(user: string): Promise<PortfolioHealth> {
    return this.simulateReturn(
      "get_portfolio_health",
      [enc.address(user)],
      decodePortfolioHealth,
    );
  }

  /** Read-only accessor for the address currently wired as the options engine. */
  getOptionsEngine(): Promise<string> {
    return this.simulateReturn("get_options_engine", [], dec.address);
  }

  /**
   * Admin-only: wire the stellax-options contract address into the risk
   * engine so portfolio-margin paths start querying for user option Greeks.
   */
  setOptionsEngine(options: string, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("set_options_engine", [enc.address(options)], opts);
  }

  // ─── Writes ────────────────────────────────────────────────────────────────

  /**
   * Force-liquidate an under-margined position.
   *
   * @param keeper        Address of the liquidation keeper (receives keeperReward)
   * @param user          Owner of the position to liquidate
   * @param positionId    ID of the under-collateralised position
   * @param pricePayload  Optional RedStone price bytes. Pass undefined for None.
   */
  liquidate(
    keeper: string,
    user: string,
    positionId: bigint,
    opts: InvokeOptions,
    pricePayload?: Uint8Array,
  ): Promise<InvokeResult> {
    return this.invoke(
      "liquidate",
      [
        enc.address(keeper),
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

  /** Total account equity (18-dec USD). Derived from getAccountHealth. */
  getAccountEquity(user: string): Promise<bigint> {
    return this.getAccountHealth(user).then((h) => h.equity);
  }

  /** Free collateral available to open new positions (18-dec USD). */
  getFreeCollateral(user: string): Promise<bigint> {
    return this.getAccountHealth(user).then((h) => h.freeCollateral);
  }

  /** Total maintenance margin required across all positions (18-dec USD). */
  getMaintenanceMargin(user: string): Promise<bigint> {
    return this.getAccountHealth(user).then((h) => h.totalMarginRequired);
  }

  /**
   * Insurance fund balance.
   * Phase P: now backed by the on-chain `get_insurance_fund_balance` entry.
   */
  getInsuranceFundBalance(): Promise<bigint> {
    return this.simulateReturn("get_insurance_fund_balance", [], dec.bigint);
  }

  /**
   * Phase P — list of contract addresses authorised to call `insurance_top_up`.
   */
  getInsuranceFunders(): Promise<string[]> {
    return this.simulateReturn("get_insurance_funders", [], (v) =>
      dec.vec(v, (x) => dec.address(x)),
    );
  }

  /**
   * Phase P — admin entry: whitelist a top-up source (typically treasury).
   */
  addInsuranceFunder(source: string, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("add_insurance_funder", [enc.address(source)], opts);
  }

  /**
   * Phase P — admin entry: revoke a previously authorised top-up source.
   */
  removeInsuranceFunder(source: string, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("remove_insurance_funder", [enc.address(source)], opts);
  }

  /**
   * Phase P — admin / governor entry: pay out from the insurance reserves.
   */
  insurancePayout(
    recipient: string,
    amount: bigint,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "insurance_payout",
      [enc.address(recipient), enc.i128(amount)],
      opts,
    );
  }

  // ─── Phase 4: pause ────────────────────────────────────────────────────────

  /** Phase 4 — returns true when the risk engine is paused (liquidations blocked). */
  isPaused(): Promise<boolean> {
    return this.simulateReturn("is_paused", [], (v) => Boolean(dec.raw(v)));
  }

  /** Phase 4 — admin: halt liquidations. */
  pause(opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("pause", [], opts);
  }

  /** Phase 4 — admin: resume liquidations. */
  unpause(opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("unpause", [], opts);
  }
}

export { decodeAccountHealth, decodeLiquidationOutcome, decodePortfolioGreeks, decodePortfolioHealth };
