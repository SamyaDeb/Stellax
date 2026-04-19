import { loadConfig } from "./config.js";
import { initLogger, getLogger } from "./logger.js";
import { SorobanClient } from "./stellar.js";
import { DefaultRedStoneFetcher } from "./redstone.js";
import { Alerter } from "./alert.js";
import { OraclePusher } from "./workers/oracle-pusher.js";
import { FundingUpdater } from "./workers/funding-updater.js";
import {
  LiquidationBot,
  type PositionSource,
} from "./workers/liquidation-bot.js";
import {
  OptionSettler,
  type OptionExpirySource,
} from "./workers/option-settler.js";
import {
  VaultRoller,
  type VaultScheduleSource,
} from "./workers/vault-roller.js";
import { HealthServer } from "./health.js";
import type { BaseWorker } from "./worker.js";

/**
 * Entry point: wires config → clients → workers and starts the scheduler.
 *
 * Data sources that depend on an indexer (positions, option expiries,
 * vault schedules) are stubbed with empty implementations by default.
 * In production, replace them with real indexer-backed implementations.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  initLogger(cfg.monitoring.logLevel);
  const log = getLogger("main");
  log.info("starting stellax-keeper");

  const stellar = new SorobanClient({
    rpcUrl: cfg.rpcUrl,
    networkPassphrase: cfg.networkPassphrase,
    secretKey: cfg.keeperSecretKey,
  });
  log.info({ keeper: stellar.publicKey() }, "stellar client ready");

  const alerter = new Alerter(cfg.monitoring);

  // ─── Data sources (replace with indexer-backed impls in production) ─────────
  const emptyPositions: PositionSource = {
    async getOpenPositions() {
      return [];
    },
  };
  const emptyOptionExpiries: OptionExpirySource = {
    async getExpiredUnsettled() {
      return [];
    },
  };
  const emptyVaultSchedule: VaultScheduleSource = {
    async getCurrentEpochEnd() {
      // Never roll — indicates no schedule is known.
      return Number.MAX_SAFE_INTEGER;
    },
  };

  const workers: BaseWorker[] = [];

  if (cfg.workers.oracle) {
    workers.push(
      new OraclePusher({
        stellar,
        fetcher: new DefaultRedStoneFetcher({
          gatewayUrl: cfg.redstone.gatewayUrl,
          dataServiceId: cfg.redstone.dataServiceId,
          uniqueSigners: cfg.redstone.uniqueSigners,
        }),
        alerter,
        oracleContractId: cfg.contracts.oracle,
        feeds: cfg.redstone.feeds,
        stalenessAlertMs: cfg.thresholds.oracleStalenessAlertMs,
      }),
    );
  }
  if (cfg.workers.funding) {
    workers.push(
      new FundingUpdater({
        stellar,
        fundingContractId: cfg.contracts.funding,
        marketIds: cfg.perpMarketIds,
      }),
    );
  }
  if (cfg.workers.liquidation) {
    workers.push(
      new LiquidationBot({
        stellar,
        riskContractId: cfg.contracts.risk,
        positions: emptyPositions,
        alerter,
        warningThresholdBps: 200, // 2%
      }),
    );
  }
  if (cfg.workers.options && cfg.contracts.options) {
    workers.push(
      new OptionSettler({
        stellar,
        optionsContractId: cfg.contracts.options,
        expiries: emptyOptionExpiries,
        batchSize: 16,
      }),
    );
  }
  if (cfg.workers.vault && cfg.structuredVaultIds.length > 0) {
    workers.push(
      new VaultRoller({
        stellar,
        vaultIds: cfg.structuredVaultIds,
        schedule: emptyVaultSchedule,
      }),
    );
  }

  const intervalFor = (name: string): number => {
    switch (name) {
      case "oracle-pusher":
        return cfg.intervals.oraclePushMs;
      case "funding-updater":
        return cfg.intervals.fundingUpdateMs;
      case "liquidation-bot":
        return cfg.intervals.liquidationScanMs;
      case "option-settler":
        return cfg.intervals.optionSettleMs;
      case "vault-roller":
        return cfg.intervals.vaultRollMs;
      default:
        return 60_000;
    }
  };

  await Promise.all(workers.map((w) => w.start(intervalFor(w.name))));
  log.info({ count: workers.length }, "workers started");

  const health = new HealthServer({
    port: cfg.monitoring.healthPort,
    workers,
    stellar,
    minBalanceStroops: cfg.thresholds.minKeeperBalanceStroops,
    oracleStalenessMs: cfg.thresholds.oracleStalenessAlertMs,
    oracleWorkerName: "oracle-pusher",
  });
  await health.start();

  const shutdown = async (sig: string) => {
    log.info({ sig }, "shutting down");
    await Promise.allSettled(workers.map((w) => w.stop()));
    await health.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
