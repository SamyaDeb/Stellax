import { FundingClient } from "@stellax/sdk";
import { BaseWorker } from "../worker.js";
import { KeeperExecutor } from "../sdk-executor.js";
import type { StellarClient } from "../stellar.js";
import { getLogger } from "../logger.js";
import type { PositionSource } from "./liquidation-bot.js";

export interface FundingSettlerDeps {
  stellar: StellarClient;
  fundingContractId: string;
  positions: PositionSource;
}

/**
 * Phase 3 — continuous funding settler.
 *
 * Each tick:
 *   1. Fetches all open positions from the indexer.
 *   2. Calls `funding.settle_funding_for_position(position_id)` for each.
 *   3. Errors are isolated per-position; a single failure does not abort the
 *      remaining set (another keeper tick or the close-time waterfall will
 *      catch any unpaid funding).
 *
 * Prerequisites (one-time admin setup):
 *   1. Fund the funding contract as an `authorized_caller` in the vault:
 *        `vault.add_authorized_caller(funding_contract_id)`
 *   2. Call `funding.set_vault_config(vault, funding_pool, usdc_token)`.
 *   3. The perp-engine's `cfg.funding` must match `FUNDING_CONTRACT_ID`.
 *
 * Configuration env vars:
 *   FUNDING_CONTRACT_ID          — contract ID of `stellax-funding`.
 *   FUNDING_SETTLER_INTERVAL_MS  — tick interval in ms (default 3_600_000 = 1h).
 *   WORKER_FUNDING_SETTLER_ENABLED — set to "false" to disable (default true).
 */
export class FundingSettler extends BaseWorker {
  readonly name = "funding-settler";

  private readonly client: FundingClient;

  constructor(private readonly deps: FundingSettlerDeps) {
    super();
    this.log = getLogger(this.name);
    this.client = new FundingClient(
      deps.fundingContractId,
      new KeeperExecutor(deps.stellar),
    );
  }

  async tick(): Promise<void> {
    const { positions } = this.deps;

    const openPositions = await positions.getOpenPositions();
    if (openPositions.length === 0) {
      this.log.debug("no open positions to settle");
      return;
    }

    this.log.info({ count: openPositions.length }, "settling funding for open positions");

    let settled = 0;
    let skipped = 0;
    for (const pos of openPositions) {
      try {
        await this.client.settleFundingForPosition(pos.positionId, {
          sourceAccount: this.deps.stellar.publicKey(),
          maxRetries: 1,
        });
        settled += 1;
        this.log.debug(
          { positionId: pos.positionId.toString() },
          "funding settled",
        );
      } catch (err) {
        skipped += 1;
        this.log.warn(
          {
            positionId: pos.positionId.toString(),
            err: (err as Error).message,
          },
          "settle_funding_for_position failed (will retry next tick or at close)",
        );
      }
    }

    this.log.info({ settled, skipped }, "funding settlement tick complete");
  }
}
