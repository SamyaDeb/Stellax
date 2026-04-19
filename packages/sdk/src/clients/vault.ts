/**
 * StellaxVault — collateral custody and margin bookkeeping.
 *
 * Actual ABI (confirmed by e2e):
 *   deposit(user: Address, token: Address, amount: i128) → void
 *   withdraw(user: Address, token: Address, amount: i128) → void
 *   get_balance(user: Address, token: Address) → i128
 *   get_total_collateral_value(user: Address) → i128
 *   get_free_collateral_value(user: Address) → i128
 *   lock_margin(caller: Address, user: Address, position_id: u64, amount: i128) → void
 *   unlock_margin(caller: Address, user: Address, position_id: u64, amount: i128) → void
 *   add_authorized_caller(caller: Address) → void
 *   version() → u32
 */

import { ContractClient } from "../core/client.js";
import { enc, dec } from "../core/scval.js";
import type { InvokeOptions, InvokeResult } from "../core/executor.js";
import type { VaultBalance } from "../core/types.js";

export class VaultClient extends ContractClient {
  // ─── Reads ─────────────────────────────────────────────────────────────────

  /**
   * Free balance for a user in 18-decimal internal precision.
   * Pass the token's contract address (e.g. USDC SAC address).
   */
  getBalance(user: string, token: string): Promise<bigint> {
    return this.simulateReturn(
      "get_balance",
      [enc.address(user), enc.address(token)],
      dec.bigint,
    );
  }

  /**
   * Total collateral value (all tokens) in USD with 18-decimal precision.
   */
  getTotalCollateralValue(user: string): Promise<bigint> {
    return this.simulateReturn(
      "get_total_collateral_value",
      [enc.address(user)],
      dec.bigint,
    );
  }

  /**
   * Free collateral value not locked as margin, in 18-decimal USD.
   */
  getFreeCollateralValue(user: string): Promise<bigint> {
    return this.simulateReturn(
      "get_free_collateral_value",
      [enc.address(user)],
      dec.bigint,
    );
  }

  version(): Promise<number> {
    return this.simulateReturn("version", [], dec.number);
  }

  // ─── Writes ────────────────────────────────────────────────────────────────

  /**
   * Deposit tokens into the vault.
   * The user must have approved the vault to transfer `amount` of `token`.
   * @param amount   Native token decimal amount (e.g. 7-decimal for USDC on Stellar)
   */
  deposit(
    user: string,
    token: string,
    amount: bigint,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "deposit",
      [enc.address(user), enc.address(token), enc.i128(amount)],
      opts,
    );
  }

  /**
   * Withdraw tokens from the vault back to the user's classic account.
   * @param amount   Native token decimal amount (e.g. 7-decimal for USDC)
   */
  withdraw(
    user: string,
    token: string,
    amount: bigint,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "withdraw",
      [enc.address(user), enc.address(token), enc.i128(amount)],
      opts,
    );
  }

  /**
   * Lock margin for a specific position (authorized caller only).
   * @param caller       The engine/contract that is authorized to lock margin
   * @param positionId   The perp position being opened
   * @param amount       Amount to lock in 18-decimal internal precision
   */
  lockMargin(
    caller: string,
    user: string,
    positionId: bigint,
    amount: bigint,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "lock_margin",
      [
        enc.address(caller),
        enc.address(user),
        enc.u64(positionId),
        enc.i128(amount),
      ],
      opts,
    );
  }

  /**
   * Unlock margin when a position is closed (authorized caller only).
   */
  unlockMargin(
    caller: string,
    user: string,
    positionId: bigint,
    amount: bigint,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "unlock_margin",
      [
        enc.address(caller),
        enc.address(user),
        enc.u64(positionId),
        enc.i128(amount),
      ],
      opts,
    );
  }

  /** Register a contract as an authorized vault caller (admin only). */
  addAuthorizedCaller(caller: string, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("add_authorized_caller", [enc.address(caller)], opts);
  }

  upgrade(newWasmHash: Uint8Array, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("upgrade", [enc.bytesN(newWasmHash)], opts);
  }

  // ─── Convenience / UI helpers ──────────────────────────────────────────────

  /**
   * Composite vault balance for a user: free (withdrawable) and locked (margined).
   * Derived from getFreeCollateralValue and getTotalCollateralValue.
   * @param token  Token contract address (e.g. USDC SAC)
   */
  async getVaultBalance(user: string, _token: string): Promise<VaultBalance> {
    const [total, free] = await Promise.all([
      this.getTotalCollateralValue(user),
      this.getFreeCollateralValue(user),
    ]);
    const locked = total >= free ? total - free : 0n;
    return { free, locked };
  }

  /**
   * Total protocol TVL across all depositors.
   * Not exposed by the on-chain ABI; returns 0 until an indexer is wired.
   */
  getTotalDeposits(): Promise<bigint> {
    return Promise.resolve(0n);
  }
}
