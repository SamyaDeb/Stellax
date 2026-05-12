/**
 * StellaxSlpVault — Hyperliquid HLP-style liquidity-provider vault.
 *
 * Actual ABI (stellax-slp-vault v1 + HLP Phase 2):
 *   initialize(config: SlpConfig) → void
 *   deposit(user: Address, amount_native: i128) → void
 *   withdraw(user: Address, shares: i128) → void
 *   seed(amount_native: i128) → void                        [admin-only]
 *   sweep_fees(amount_native: i128) → void                  [keeper-only]
 *   credit_pnl(caller: Address, amount: i128) → void        [authorized-caller only; 18-dec]
 *   draw_pnl(caller: Address, recipient: Address, amount: i128) → void   [authorized-caller only; 18-dec]
 *   record_loss(caller: Address, amount: i128) → void       [authorized-caller only; 18-dec]
 *   admin_credit_assets(amount: i128) → void                [admin-only; 18-dec]
 *   add_authorized_caller(new_caller: Address) → void       [admin-only]
 *   remove_authorized_caller(old_caller: Address) → void    [admin-only]
 *   get_authorized_callers() → Vec<Address>
 *   set_cooldown_secs(secs: u64) → void                     [admin-only]
 *   set_skew_cap_bps(bps: u32) → void                       [admin-only]
 *   set_max_vault_cap(cap: i128) → void                     [admin-only; 18-dec]
 *   total_shares() → i128
 *   total_assets() → i128
 *   nav_per_share() → i128                                   (18-decimal, 1:1 at inception)
 *   balance(id: Address) → i128                            (SEP-41; also used for share balance)
 *   unlock_at(user: Address) → u64                          (unix seconds)
 *   get_config() → SlpConfig
 *   version() → u32
 *   upgrade(new_wasm_hash: BytesN<32>) → void               [admin-only]
 *
 * Unit convention:
 *   • `amount_native` arguments are in Stellar-native 7-decimal (stroops-like)
 *     USDC. 1 USDC = 10_000_000 units.
 *   • All on-chain i128 balances/shares/HLP amounts are 18-decimal PRECISION
 *     (1 USDC = 10^18 units).  Use `fromFixed` to convert for display.
 *   • `nav_per_share` is also 18-decimal; divide by 10^18 for the float.
 *   • HLP entry points (`credit_pnl`, `draw_pnl`, `record_loss`,
 *     `admin_credit_assets`, `set_max_vault_cap`) take 18-decimal amounts.
 */

import { ContractClient } from "../core/client.js";
import { enc, dec } from "../core/scval.js";
import type { InvokeOptions, InvokeResult } from "../core/executor.js";

/**
 * On-chain configuration struct returned by `get_config()`.
 * Mirrors `SlpConfig` in `contracts/stellax-slp-vault/src/lib.rs`.
 */
export interface SlpConfig {
  admin: string;
  keeper: string;
  /** Main StellaX collateral vault (where USDC balances live). */
  vaultContract: string;
  /** Perp engine queried for OI during skew-cap check. */
  perpEngine: string;
  /** USDC SEP-41 token address. */
  usdcToken: string;
  /** Treasury — source of fee sweeps. */
  treasury: string;
  /** Withdrawal cooldown in seconds. Default 3600 on testnet. */
  cooldownSecs: bigint;
  /** Max OI/NAV ratio in bps before withdrawals are blocked. 0 = disabled. */
  skewCapBps: number;
  /** Maximum total LP deposits in 18-decimal internal units. */
  maxVaultCap: bigint;
  /** Perp market IDs whose OI is summed for the skew-cap check. */
  perpMarketIds: number[];
}

export class SlpVaultClient extends ContractClient {
  // ─── Reads ─────────────────────────────────────────────────────────────────

  /** Total LP shares outstanding (18-decimal). */
  totalShares(): Promise<bigint> {
    return this.simulateReturn("total_shares", [], dec.bigint);
  }

  /**
   * Total NAV tracked by the vault (18-decimal).
   * Increases when fee credits / sweeps uplift the pool; decreases when
   * the perp engine draws PnL to pay winning traders.
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

  /**
   * Return the current on-chain configuration struct.
   * Includes admin/keeper addresses, cooldown_secs, skew_cap_bps,
   * max_vault_cap, and the list of perp_market_ids used for skew checks.
   */
  getConfig(): Promise<SlpConfig> {
    return this.simulateReturn("get_config", [], (v) => {
      const o = (dec.raw(v) as Record<string, unknown>) ?? {};
      const rawIds = (o.perp_market_ids as unknown[] | undefined) ?? [];
      return {
        admin: String(o.admin ?? ""),
        keeper: String(o.keeper ?? ""),
        vaultContract: String(o.vault_contract ?? ""),
        perpEngine: String(o.perp_engine ?? ""),
        usdcToken: String(o.usdc_token ?? ""),
        treasury: String(o.treasury ?? ""),
        cooldownSecs: BigInt((o.cooldown_secs as bigint | number | undefined) ?? 0),
        skewCapBps: Number(o.skew_cap_bps ?? 0),
        maxVaultCap: BigInt((o.max_vault_cap as bigint | number | undefined) ?? 0),
        perpMarketIds: rawIds.map((x) => Number(x)),
      } satisfies SlpConfig;
    });
  }

  /** Return the list of addresses authorised to call HLP entry points. */
  getAuthorizedCallers(): Promise<string[]> {
    return this.simulateReturn("get_authorized_callers", [], (v) =>
      dec.vec(v, (x) => dec.address(x)),
    );
  }

  version(): Promise<number> {
    return this.simulateReturn("version", [], dec.number);
  }

  // ─── LP writes ─────────────────────────────────────────────────────────────

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
   * Keeper-only: sweep `amountNative` USDC (7-decimal) of protocol fees
   * from the treasury sub-account in the collateral vault into the SLP
   * vault's sub-account, uplifting NAV for all share-holders.
   *
   * Note (HLP model): in normal operation fees flow DIRECTLY into the SLP
   * vault via `credit_pnl` at close-time; `sweep_fees` is a supplementary
   * sweep for any residual treasury balance.
   */
  sweepFees(amountNative: bigint, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("sweep_fees", [enc.i128(amountNative)], opts);
  }

  // ─── HLP entry points (Phase 2) ───────────────────────────────────────────

  /**
   * Credit `amount` (18-decimal) to the SLP NAV without token movement.
   * Called by an authorized caller (perp/risk engine) after
   * `vault.move_balance(user → slp_vault)` to keep `TotalAssets` in sync.
   * @param caller  Must be in the authorized-callers whitelist.
   * @param amount  18-decimal internal units. Must be > 0.
   */
  creditPnl(caller: string, amount: bigint, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("credit_pnl", [enc.address(caller), enc.i128(amount)], opts);
  }

  /**
   * Debit `amount` (18-decimal) from the SLP NAV and move the equivalent
   * USDC from the SLP vault's collateral balance to `recipient`.
   * Used to pay a winning trader's profit. Reverts with
   * `InsufficientLiquidity` when the vault cannot cover the payment.
   * @param caller     Must be in the authorized-callers whitelist.
   * @param recipient  Address to receive the USDC (typically the user's vault sub-account).
   * @param amount     18-decimal internal units. Must be > 0.
   */
  drawPnl(
    caller: string,
    recipient: string,
    amount: bigint,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "draw_pnl",
      [enc.address(caller), enc.address(recipient), enc.i128(amount)],
      opts,
    );
  }

  /**
   * Record a loss of `amount` (18-decimal) against the SLP NAV without
   * any token movement. Used when the vault's on-chain balance has already
   * been reduced (e.g. via ADL) and NAV tracking must be updated.
   * @param caller  Must be in the authorized-callers whitelist.
   * @param amount  18-decimal internal units. Must be > 0.
   */
  recordLoss(caller: string, amount: bigint, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("record_loss", [enc.address(caller), enc.i128(amount)], opts);
  }

  // ─── Admin writes ──────────────────────────────────────────────────────────

  /**
   * Admin-only: credit `amount` (18-decimal) to `TotalAssets` without
   * moving tokens.  Used during the HLP migration step where the treasury /
   * insurance balances are swept into the SLP sub-account in the collateral
   * vault and `TotalAssets` must be updated to match.
   */
  adminCreditAssets(amount: bigint, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("admin_credit_assets", [enc.i128(amount)], opts);
  }

  /**
   * Admin-only: add `newCaller` to the HLP authorized-callers whitelist.
   * Idempotent — adding the same address twice is a no-op.
   */
  addAuthorizedCaller(newCaller: string, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("add_authorized_caller", [enc.address(newCaller)], opts);
  }

  /**
   * Admin-only: remove `oldCaller` from the HLP authorized-callers whitelist.
   * No-op if the address is not present.
   */
  removeAuthorizedCaller(oldCaller: string, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("remove_authorized_caller", [enc.address(oldCaller)], opts);
  }

  /**
   * Admin-only: update the withdrawal cooldown (in seconds).
   * Default 86 400 (24 h) on mainnet; 3 600 (1 h) on testnet.
   */
  setCooldownSecs(secs: bigint, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("set_cooldown_secs", [enc.u64(secs)], opts);
  }

  /**
   * Admin-only: update the OI/NAV skew cap in basis points.
   * Withdrawals are blocked when `oi / nav > skewCapBps / 10_000`.
   * Pass 0 to disable the cap entirely.
   */
  setSkewCapBps(bps: number, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("set_skew_cap_bps", [enc.u32(bps)], opts);
  }

  /**
   * Admin-only: update the maximum total LP deposits.
   * `cap` is in 18-decimal internal units (1 USDC = 10^18).
   * Must be > 0 or the contract returns `InvalidConfig`.
   */
  setMaxVaultCap(cap: bigint, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("set_max_vault_cap", [enc.i128(cap)], opts);
  }

  upgrade(newWasmHash: Uint8Array, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("upgrade", [enc.bytesN(newWasmHash)], opts);
  }
}
