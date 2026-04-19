import { BaseWorker } from "../worker.js";
import { type StellarClient } from "../stellar.js";
import { getLogger } from "../logger.js";

/**
 * Per-vault epoch schedule lookup.
 *
 * Returns the unix timestamp (seconds) when the current epoch of the given
 * vault ends. If the current time is >= that value, the keeper calls
 * `roll_epoch()`.
 */
export interface VaultScheduleSource {
  getCurrentEpochEnd(vaultId: string): Promise<number>;
}

export interface VaultRollerDeps {
  stellar: StellarClient;
  vaultIds: string[];
  schedule: VaultScheduleSource;
}

/**
 * Rolls structured-product vault epochs.
 *
 * Every tick the keeper asks each configured vault when its current epoch
 * ends; if `now >= epochEnd` it calls `roll_epoch()` on that vault. A
 * missing `roll_epoch` call stalls deposits/withdrawals, so this worker
 * has a short cadence (default 60s) even though actual rolls only happen
 * at epoch boundaries.
 */
export class VaultRoller extends BaseWorker {
  readonly name = "vault-roller";

  constructor(private readonly deps: VaultRollerDeps) {
    super();
    this.log = getLogger(this.name);
  }

  async tick(): Promise<void> {
    const { stellar, vaultIds, schedule } = this.deps;
    if (vaultIds.length === 0) {
      this.log.debug("no vaults configured; skipping");
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    for (const vaultId of vaultIds) {
      try {
        const epochEnd = await schedule.getCurrentEpochEnd(vaultId);
        if (now < epochEnd) {
          this.log.debug(
            { vaultId, epochEnd, secondsLeft: epochEnd - now },
            "epoch not ended yet",
          );
          continue;
        }
        const res = await stellar.invoke(vaultId, "roll_epoch", []);
        this.log.info({ vaultId, hash: res.hash }, "epoch rolled");
      } catch (err) {
        this.log.error(
          { vaultId, err: (err as Error).message },
          "roll_epoch failed",
        );
      }
    }
  }
}
