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
   * Not exposed by the on-chain ABI; returns 0 until treasury accounting is wired.
   */
  getInsuranceFundBalance(): Promise<bigint> {
    return Promise.resolve(0n);
  }
}

export { decodeAccountHealth, decodeLiquidationOutcome };
