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
   * Acts as a cap — the actual sweep is min(treasuryBalance, sweepCapNative).
   */
  sweepCapNative: bigint;
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
        sweepCapNative: sweepCapNative.toString(),
      },
      "treasury balance queried",
    );

    // ── 3. Skip if nothing to sweep ──────────────────────────────────────
    if (availableNative <= 0n) {
      this.log.info("treasury empty; skipping sweep");
      return;
    }

    // ── 4. Clamp to configured cap ───────────────────────────────────────
    const toSweepNative =
      availableNative < sweepCapNative ? availableNative : sweepCapNative;

    this.log.info(
      {
        toSweepNative: toSweepNative.toString(),
        slpVaultContractId: this.deps.slpVaultContractId,
      },
      "sweeping fees into SLP vault",
    );

    // ── 5. Execute sweep ─────────────────────────────────────────────────
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
