/**
 * StellaxTreasury — fee aggregation with 60/20/20 insurance/treasury/staker split.
 *
 * Actual ABI (confirmed by e2e):
 *   version() → u32
 *   add_authorized_source(source: Address) → void                       [admin]
 *   collect_fee(source: Address, token: Address, amount: i128) → void   [source auth]
 *   distribute(token: Address) → void                                    [permissionless]
 *   get_pending_fees(token: Address) → i128
 *   get_treasury_balance(token: Address) → i128
 *   get_staker_balance(token: Address) → i128
 *   get_insurance_sent(token: Address) → i128
 *   withdraw_treasury(destination: Address, token: Address, amount: i128) → void  [admin]
 *   update_split(insurance_bps, treasury_bps, staker_bps) → void                  [admin]
 *
 * Deployment:
 *   admin=deployer, insurance_fund=deployer, insurance_cap=1e21
 *   default splits: insurance=60%, treasury=20%, staker=20%
 *   pre-wired authorized sources: perp_engine, options, risk
 *
 * Notes:
 *  • collect_fee is accounting-only — tokens must already be in the contract before calling
 *  • distribute physically transfers the insurance portion to insurance_fund via SAC
 *  • add_authorized_source is idempotent (safe to re-call)
 *  • withdraw_treasury requires admin auth (deployer signs the tx)
 *  • get_staker_balance returns the aggregate staker bucket, not per-staker
 */

import { ContractClient } from "../core/client.js";
import { enc, dec } from "../core/scval.js";
import type { InvokeOptions, InvokeResult } from "../core/executor.js";

export class TreasuryClient extends ContractClient {
  // ─── Reads ─────────────────────────────────────────────────────────────────

  version(): Promise<number> {
    return this.simulateReturn("version", [], dec.number);
  }

  /**
   * Pending (undistributed) fees for a given token.
   */
  getPendingFees(token: string): Promise<bigint> {
    return this.simulateReturn("get_pending_fees", [enc.address(token)], dec.bigint);
  }

  /**
   * Treasury bucket balance (20% share, post-distribute) for a given token.
   */
  getTreasuryBalance(token: string): Promise<bigint> {
    return this.simulateReturn(
      "get_treasury_balance",
      [enc.address(token)],
      dec.bigint,
    );
  }

  /**
   * Staker bucket balance (20% share, post-distribute) for a given token.
   */
  getStakerBalance(token: string): Promise<bigint> {
    return this.simulateReturn(
      "get_staker_balance",
      [enc.address(token)],
      dec.bigint,
    );
  }

  /**
   * Cumulative insurance fund payout for a given token (60% of distributed fees).
   */
  getInsuranceSent(token: string): Promise<bigint> {
    return this.simulateReturn(
      "get_insurance_sent",
      [enc.address(token)],
      dec.bigint,
    );
  }

  // ─── Writes ────────────────────────────────────────────────────────────────

  /**
   * Register a contract as an authorized fee source (admin only).
   * Idempotent — safe to call multiple times.
   */
  addAuthorizedSource(source: string, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("add_authorized_source", [enc.address(source)], opts);
  }

  /**
   * Record a fee collection event (source-auth).
   * The tokens must already be in the treasury contract before calling.
   * source.require_auth() is checked — the source must sign the transaction.
   *
   * @param source  Authorized fee source (e.g. perp_engine, options, risk, or deployer)
   * @param token   Token contract address (e.g. USDC SAC)
   * @param amount  Amount in 7-decimal native USDC stroops
   */
  collectFee(
    source: string,
    token: string,
    amount: bigint,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "collect_fee",
      [enc.address(source), enc.address(token), enc.i128(amount)],
      opts,
    );
  }

  /**
   * Distribute pending fees according to the 60/20/20 split.
   * Permissionless — anyone can call this.
   * Physically transfers the insurance portion to the insurance_fund address via SAC.
   *
   * @param token  Token to distribute (e.g. USDC SAC address)
   */
  distribute(token: string, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("distribute", [enc.address(token)], opts);
  }

  /**
   * Withdraw tokens from the treasury bucket (admin only).
   *
   * @param destination  Recipient address for the withdrawn tokens
   * @param token        Token contract address
   * @param amount       Amount to withdraw (7-decimal native for USDC)
   */
  withdrawTreasury(
    destination: string,
    token: string,
    amount: bigint,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "withdraw_treasury",
      [enc.address(destination), enc.address(token), enc.i128(amount)],
      opts,
    );
  }

  /**
   * Update the fee split basis points (admin only).
   * The three values must sum to 10000.
   *
   * @param insuranceBps  e.g. 6000 (60%)
   * @param treasuryBps   e.g. 2000 (20%)
   * @param stakerBps     e.g. 2000 (20%)
   */
  updateSplit(
    insuranceBps: number,
    treasuryBps: number,
    stakerBps: number,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "update_split",
      [enc.u32(insuranceBps), enc.u32(treasuryBps), enc.u32(stakerBps)],
      opts,
    );
  }

  upgrade(newWasmHash: Uint8Array, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("upgrade", [enc.bytesN(newWasmHash)], opts);
  }
}
