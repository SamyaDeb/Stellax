/**
 * StellaxSlpVault — Hyperliquid HLP-style liquidity-provider vault.
 *
 * Actual ABI (stellax-slp-vault v1):
 *   initialize(config: SlpConfig) → void
 *   deposit(user: Address, amount_native: i128) → void
 *   withdraw(user: Address, shares: i128) → void
 *   seed(amount_native: i128) → void            [admin-only]
 *   sweep_fees(amount_native: i128) → void      [keeper-only]
 *   total_shares() → i128
 *   total_assets() → i128
 *   nav_per_share() → i128                       (18-decimal, 1:1 at inception)
 *   balance(id: Address) → i128                (SEP-41; also used for share balance)
 *   unlock_at(user: Address) → u64              (unix seconds)
 *   get_config() → SlpConfig
 *   version() → u32
 *   upgrade(new_wasm_hash: BytesN<32>) → void   [admin-only]
 *
 * Unit convention:
 *   • `amount_native` arguments are in Stellar-native 7-decimal (stroops-like)
 *     USDC. 1 USDC = 10_000_000 units.
 *   • All on-chain i128 balances/shares are returned in 18-decimal PRECISION
 *     (1 USDC = 10^18 units).  Use `fromFixed` to convert for display.
 *   • `nav_per_share` is also 18-decimal; divide by 10^18 for the float.
 */

import { ContractClient } from "../core/client.js";
import { enc, dec } from "../core/scval.js";
import type { InvokeOptions, InvokeResult } from "../core/executor.js";

export class SlpVaultClient extends ContractClient {
  // ─── Reads ─────────────────────────────────────────────────────────────────

  /** Total LP shares outstanding (18-decimal). */
  totalShares(): Promise<bigint> {
    return this.simulateReturn("total_shares", [], dec.bigint);
  }

  /**
   * Total NAV tracked by the vault (18-decimal).
   * Increases when fee sweeps uplift the pool; decreases with unrealised losses.
   */
  totalAssets(): Promise<bigint> {
    return this.simulateReturn("total_assets", [], dec.bigint);
  }

  /**
   * NAV per share in 18-decimal fixed-point.
   * At inception (first deposit) this equals PRECISION (1e18 = 1.0).
   * Use `fromFixed(navPerShare)` to get the human-readable float.
   */
  navPerShare(): Promise<bigint> {
    return this.simulateReturn("nav_per_share", [], dec.bigint);
  }

  /**
   * LP share balance for `user` (18-decimal).
   * To convert to underlying USDC: `shares * navPerShare / 1e18`.
   */
  shareBalance(user: string): Promise<bigint> {
    return this.simulateReturn("balance", [enc.address(user)], dec.bigint);
  }

  /**
   * Unix timestamp (seconds) at which the user's cooldown expires.
   * Returns 0 when the user has never deposited or after the cooldown is met.
   * Compare against `Date.now() / 1000` for UI readiness.
   */
  unlockAt(user: string): Promise<bigint> {
    return this.simulateReturn("unlock_at", [enc.address(user)], dec.bigint);
  }

  version(): Promise<number> {
    return this.simulateReturn("version", [], dec.number);
  }

  // ─── Writes ────────────────────────────────────────────────────────────────

  /**
   * Deposit `amountNative` USDC (7-decimal, i.e. 1 USDC = 10_000_000).
   * Mints proportional shares and sets a withdrawal cooldown for the user.
   */
  deposit(user: string, amountNative: bigint, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("deposit", [enc.address(user), enc.i128(amountNative)], opts);
  }

  /**
   * Burn `shares` (18-decimal) and receive proportional USDC.
   * Requires cooldown to have elapsed and OI/NAV skew cap to be satisfied.
   */
  withdraw(user: string, shares: bigint, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("withdraw", [enc.address(user), enc.i128(shares)], opts);
  }

  /**
   * Admin-only bootstrap deposit. No cooldown is applied.
   * Used to seed the pool before opening to the public.
   */
  seed(amountNative: bigint, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("seed", [enc.i128(amountNative)], opts);
  }

  /**
   * Keeper-only: sweep `amountNative` USDC of protocol fees from the treasury
   * sub-account into the SLP vault, uplifting NAV for all share-holders.
   */
  sweepFees(amountNative: bigint, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("sweep_fees", [enc.i128(amountNative)], opts);
  }

  upgrade(newWasmHash: Uint8Array, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("upgrade", [enc.bytesN(newWasmHash)], opts);
  }
}
