/**
 * StellaxStructured — epoch-based covered-call structured product vault.
 *
 * Actual ABI (confirmed by e2e):
 *   deposit(user: Address, amount: i128) → void          [amount in 7-dec USDC native]
 *   withdraw(user: Address, shares: i128) → void         [shares in 18-dec]
 *   roll_epoch() → void                                   [permissionless]
 *   get_epoch() → EpochState                              [no args — returns current]
 *   balance(user: Address) → i128                         [shares in 18-dec]
 *   total_assets() → i128
 *   total_shares() → i128
 *   set_epoch_duration(secs: u64) → void                  [admin]
 *   set_option_asset(symbol: Symbol) → void               [admin]
 *   version() → u32
 *
 * Notes:
 *  • deposit amount is Stellar 7-decimal (e.g. 10 USDC = 100_000_000)
 *  • withdraw shares is 18-decimal (e.g. 2 shares = 2_000_000_000_000_000_000n)
 *  • balance() returns 18-decimal shares
 *  • roll_epoch is permissionless — any caller can trigger it
 *  • epoch_duration_override = 120s on testnet
 */

import { xdr } from "@stellar/stellar-sdk";
import { ContractClient } from "../core/client.js";
import { enc, dec } from "../core/scval.js";
import type { InvokeOptions, InvokeResult } from "../core/executor.js";
import type { VaultEpoch } from "../core/types.js";

/** Current epoch state from the structured vault. */
export interface EpochState {
  epochId: number;
  startTime: bigint;
  endTime: bigint;
  strike: bigint;
  optionId: bigint;
  totalAssets: bigint;
  premium: bigint;
  settled: boolean;
}

function decodeEpochState(v: xdr.ScVal | undefined): EpochState {
  const o = (dec.raw(v) as Record<string, unknown>) ?? {};
  return {
    epochId: Number(o.epoch_id),
    startTime: BigInt(o.start_time as bigint | number),
    endTime: BigInt(o.end_time as bigint | number),
    strike: BigInt(o.strike as bigint | number),
    optionId: BigInt(o.option_id as bigint | number),
    totalAssets: BigInt(o.total_assets as bigint | number),
    premium: BigInt(o.premium as bigint | number),
    settled: Boolean(o.settled),
  };
}

export class StructuredClient extends ContractClient {
  // ─── Reads ─────────────────────────────────────────────────────────────────

  /**
   * Current epoch state — covers epoch_id, option details, and settlement status.
   */
  getEpoch(): Promise<EpochState> {
    return this.simulateReturn("get_epoch", [], decodeEpochState);
  }

  /**
   * User's share balance in 18-decimal.
   */
  balance(user: string): Promise<bigint> {
    return this.simulateReturn("balance", [enc.address(user)], dec.bigint);
  }

  /**
   * Total underlying assets in the vault in 18-decimal.
   */
  totalAssets(): Promise<bigint> {
    return this.simulateReturn("total_assets", [], dec.bigint);
  }

  /**
   * Total outstanding shares in 18-decimal.
   */
  totalShares(): Promise<bigint> {
    return this.simulateReturn("total_shares", [], dec.bigint);
  }

  version(): Promise<number> {
    return this.simulateReturn("version", [], dec.number);
  }

  // ─── Writes ────────────────────────────────────────────────────────────────

  /**
   * Deposit USDC into the structured vault.
   * When no epoch is active, shares are minted 1:1 immediately.
   * When an epoch is active, the deposit is queued until the next roll.
   *
   * @param user    Depositor address
   * @param amount  7-decimal USDC amount (e.g. 10 USDC = 100_000_000n)
   */
  deposit(user: string, amount: bigint, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("deposit", [enc.address(user), enc.i128(amount)], opts);
  }

  /**
   * Withdraw by redeeming shares.
   * When no epoch is active, underlying is returned immediately.
   * When an epoch is active, withdrawal is queued.
   *
   * @param user    Shareholder address
   * @param shares  18-decimal share amount (e.g. 2 shares = 2_000_000_000_000_000_000n)
   */
  withdraw(user: string, shares: bigint, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("withdraw", [enc.address(user), enc.i128(shares)], opts);
  }

  /**
   * Advance to the next epoch — settles the previous option and writes a new one.
   * Permissionless: any caller can trigger this once the epoch duration has elapsed.
   */
  rollEpoch(opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("roll_epoch", [], opts);
  }

  /** Admin: update epoch duration (e.g. 120n for testnet, 604800n = 1 week prod). */
  setEpochDuration(secs: bigint, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("set_epoch_duration", [enc.u64(secs)], opts);
  }

  /** Admin: set the underlying asset symbol for option writing (e.g. "XLM"). */
  setOptionAsset(symbol: string, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("set_option_asset", [enc.symbol(symbol)], opts);
  }

  upgrade(newWasmHash: Uint8Array, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("upgrade", [enc.bytesN(newWasmHash)], opts);
  }

  // ─── Convenience / UI helpers ──────────────────────────────────────────────

  /**
   * Current epoch as a VaultEpoch (the canonical shared type).
   * Maps EpochState fields: totalAssets → totalDeposits, premium → totalPremium.
   */
  getCurrentEpoch(): Promise<VaultEpoch> {
    return this.getEpoch().then((e) => ({
      epochId: e.epochId,
      startTime: e.startTime,
      endTime: e.endTime,
      totalDeposits: e.totalAssets,
      totalPremium: e.premium,
      settled: e.settled,
    }));
  }

  /**
   * User share balance — alias for `balance(user)`.
   */
  getUserShares(user: string): Promise<bigint> {
    return this.balance(user);
  }

  /**
   * Vault NAV — alias for `totalAssets()`.
   */
  getNav(): Promise<bigint> {
    return this.totalAssets();
  }
}
