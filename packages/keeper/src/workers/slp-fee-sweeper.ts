import { Address } from "@stellar/stellar-sdk";
import { SlpVaultClient } from "@stellax/sdk";
import { BaseWorker } from "../worker.js";
import { KeeperExecutor } from "../sdk-executor.js";
import type { StellarClient } from "../stellar.js";
import { getLogger } from "../logger.js";

export interface SlpFeeSweeperDeps {
  stellar: StellarClient;
  slpVaultContractId: string;
  /**
   * Max amount to sweep per tick in native 7-decimal USDC units.
   * Acts as a cap — the actual sweep is min(feeableNative, sweepCapNative).
   */
  sweepCapNative: bigint;
  /**
   * Operational reserve to leave in the treasury (7-decimal native USDC).
   *
   * The treasury is pre-seeded with capital to pay out trader profits
   * (`vault.credit` in `seed-treasury-vault.mjs`).  That reserve must NOT be
   * counted as "accumulated fees" — the sweeper should only touch the delta
   * **above** this floor.
   *
   * Set to the same value as the treasury seed amount, e.g.
   *   100_000_000_000  (= 10 000 USDC at 7dp)
   *
   * Defaults to 0 so existing deployments without this env var continue to
   * work, but production should always set it explicitly.
   */
  feeSweepBaselineNative: bigint;
  /** Main collateral vault contract ID — queried to read the treasury balance. */
  vaultContractId: string;
  /** Treasury address within the collateral vault (source of fee sweeps). */
  treasuryAddress: string;
  /** SEP-41 USDC token contract ID. */
  usdcTokenId: string;
}

/**
 * Periodic fee sweeper for the StellaX SLP vault.
 *
 * Each tick:
 *   1. Queries the treasury's live USDC balance inside the collateral vault
 *      via `stellar.simulate("get_balance")` (read-only, no tx submitted).
 *   2. Clamps to `sweepCapNative` so a single tick never drains more than the cap.
 *   3. Calls `sweep_fees(toSweep)` on the SLP vault, which atomically moves
 *      that USDC from treasury → SLP vault and uplifts `nav_per_share` for all
 *      sxSLP holders.
 *
 * Skips the tick (no on-chain call) when treasury balance is zero, so the
 * keeper never reverts with `VaultError::InsufficientBalance`.
 *
 * Note: reads use `stellar.simulate()` directly because `KeeperExecutor.simulate()`
 * intentionally throws — it was designed for write-only workers. This worker
 * is the first to combine a read-then-write pattern.
 *
 * Prerequisites (one-time admin setup):
 *   - The SLP vault contract must be registered as an `authorized_caller` in
 *     the main collateral vault via `vault.add_authorized_caller(slp_vault_addr)`.
 *
 * Configuration env vars:
 *   SLP_VAULT_CONTRACT_ID      — contract ID of `stellax-slp-vault`.
 *   VAULT_CONTRACT_ID          — main collateral vault contract ID.
 *   SLP_TREASURY_ADDRESS       — treasury address within the collateral vault.
 *   USDC_TOKEN_ID              — SEP-41 USDC token contract ID.
 *   SLP_FEE_SWEEP_AMOUNT       — max native USDC to sweep per tick (7dp, e.g. 10_0000000 = 10 USDC).
 *   SLP_FEE_SWEEP_INTERVAL_MS  — tick interval in ms (default 86_400_000 = 24h; use 3_600_000 for testnet).
 */
export class SlpFeeSweeper extends BaseWorker {
  readonly name = "slp-fee-sweeper";

  private readonly client: SlpVaultClient;

  /**
   * Vault stores balances in 18-decimal internal units; USDC uses 7dp native.
   * Conversion factor: 1 native USDC = 10^11 internal units.
   */
  private static readonly NATIVE_TO_INTERNAL = 100_000_000_000n; // 10^11

  constructor(private readonly deps: SlpFeeSweeperDeps) {
    super();
    this.log = getLogger(this.name);
    this.client = new SlpVaultClient(
      deps.slpVaultContractId,
      new KeeperExecutor(deps.stellar),
    );
  }

  async tick(): Promise<void> {
    const {
      sweepCapNative,
      feeSweepBaselineNative,
      treasuryAddress,
      usdcTokenId,
      vaultContractId,
    } = this.deps;

    // ── 1. Query treasury balance (18dp internal units) ──────────────────────
    // Use stellar.simulate() directly — KeeperExecutor.simulate() throws
    // intentionally (keeper was originally write-only).
    const { returnValue: raw } = await this.deps.stellar.simulate<bigint>(
      vaultContractId,
      "get_balance",
      [
        new Address(treasuryAddress).toScVal(),
        new Address(usdcTokenId).toScVal(),
      ],
    );

    const treasuryBalanceInternal: bigint =
      typeof raw === "bigint" ? raw : 0n;

    // ── 2. Convert to native 7dp USDC ─────────────────────────────────────
    const availableNative =
      treasuryBalanceInternal / SlpFeeSweeper.NATIVE_TO_INTERNAL;

    this.log.info(
      {
        treasuryBalanceInternal: treasuryBalanceInternal.toString(),
        availableNative: availableNative.toString(),
        feeSweepBaselineNative: feeSweepBaselineNative.toString(),
        sweepCapNative: sweepCapNative.toString(),
      },
      "treasury balance queried",
    );

    // ── 3. Subtract the operational reserve (profit-payout capital) ───────
    //
    // The treasury is pre-seeded with USDC to cover trader profit payouts.
    // That capital must NEVER be swept into LP rewards — only actual trading
    // fees that push the balance ABOVE the baseline are eligible.
    //
    const feeableNative =
      availableNative > feeSweepBaselineNative
        ? availableNative - feeSweepBaselineNative
        : 0n;

    // ── 4. Skip if nothing to sweep ──────────────────────────────────────
    if (feeableNative <= 0n) {
      this.log.info(
        { availableNative: availableNative.toString(), feeSweepBaselineNative: feeSweepBaselineNative.toString() },
        "no fees above baseline; skipping sweep",
      );
      return;
    }

    // ── 5. Clamp to configured cap ───────────────────────────────────────
    const toSweepNative =
      feeableNative < sweepCapNative ? feeableNative : sweepCapNative;

    this.log.info(
      {
        toSweepNative: toSweepNative.toString(),
        slpVaultContractId: this.deps.slpVaultContractId,
      },
      "sweeping fees into SLP vault",
    );

    // ── 6. Execute sweep ─────────────────────────────────────────────────
    const res = await this.client.sweepFees(toSweepNative, {
      sourceAccount: this.deps.stellar.publicKey(),
    });

    this.log.info(
      {
        hash: res.hash,
        ledger: res.latestLedger,
        toSweepNative: toSweepNative.toString(),
      },
      "sweep_fees succeeded — NAV uplifted",
    );
  }
}
