import { loadConfig } from "./config.js";
import { initLogger, getLogger } from "./logger.js";
import { SorobanClient, scVal } from "./stellar.js";
import { DefaultRedStoneFetcher } from "./redstone.js";
import { Alerter } from "./alert.js";
import { OraclePusher } from "./workers/oracle-pusher.js";
import { FundingUpdater } from "./workers/funding-updater.js";
import {
  LiquidationBot,
  IndexerPositionSource,
} from "./workers/liquidation-bot.js";
import { VaultRoller } from "./workers/vault-roller.js";
import { ClobMatcher } from "./workers/clob-matcher.js";
import { RwaNavPusher } from "./workers/rwa-nav-pusher.js";
import {
  YieldSimulator,
  type RwaHolderSource,
  type ApySource,
} from "./workers/yield-simulator.js";
import {
  TtlExtender,
  type TtlExtenderTarget,
} from "./workers/ttl-extender.js";
import { DefaultRwaNavFetcher } from "./rwa-nav.js";
import {
  ContractVaultScheduleSource,
  IndexerOrderBookSource,
  IndexerRwaHolderSource,
} from "./indexer-sources.js";
import { HealthServer } from "./health.js";
import type { BaseWorker } from "./worker.js";
import { readFileSync } from "node:fs";

/**
 * Entry point: wires config → clients → workers and starts the scheduler.
 *
 * Indexer-backed sources are used for positions, option ids, CLOB orders, and
 * RWA holders; structured vault epoch schedules are read directly on-chain.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  initLogger(cfg.monitoring.logLevel);
  const log = getLogger("main");
  log.info("starting stellax-keeper");

  const stellar = new SorobanClient({
    rpcUrl: cfg.rpcUrl,
    horizonUrl: cfg.horizonUrl,
    networkPassphrase: cfg.networkPassphrase,
    secretKey: cfg.keeperSecretKey,
  });
  log.info({ keeper: stellar.publicKey() }, "stellar client ready");

  const alerter = new Alerter(cfg.monitoring);

  // ─── Data sources ─────────────────────────────────────────────────────────
  const positions = new IndexerPositionSource(cfg.indexerUrl);
  const vaultSchedule = new ContractVaultScheduleSource(stellar);
  const orderBook = new IndexerOrderBookSource(cfg.indexerUrl);

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
        positions,
        alerter,
        warningThresholdBps: 200, // 2%
      }),
    );
  }
  if (cfg.workers.vault && cfg.structuredVaultIds.length > 0) {
    workers.push(
      new VaultRoller({
        stellar,
        vaultIds: cfg.structuredVaultIds,
        schedule: vaultSchedule,
      }),
    );
  }
  if (cfg.workers.clob && cfg.contracts.clob) {
    workers.push(
      new ClobMatcher({
        stellar,
        clobContractId: cfg.contracts.clob,
        book: orderBook,
      }),
    );
  }
  // ─── Tier 1 — RWA price pusher (BENJI / USDY / OUSG) ──────────────────────
  if (cfg.workers.rwaNav && cfg.rwa.feeds.length > 0) {
    workers.push(
      new RwaNavPusher({
        stellar,
        fetcher: new DefaultRwaNavFetcher({
          cmcApiKey: cfg.rwa.cmcApiKey,
          ondoNavUrl: cfg.rwa.ondoNavUrl,
          ousgNavUrl: cfg.rwa.ousgNavUrl,
          benjiNavUrl: cfg.rwa.benjiNavUrl,
          defiLlamaFallback: cfg.rwa.defiLlamaFallback,
          maxAgeMs: cfg.rwa.maxPriceAgeMs,
          maxDeviationBps: cfg.rwa.maxDeviationBps,
        }),
        alerter,
        oracleContractId: cfg.contracts.oracle,
        feeds: cfg.rwa.feeds,
        minDeviationBps: cfg.rwa.minDeviationBps,
        forcePushMs: cfg.rwa.forcePushMs,
        failureAlertThreshold: cfg.rwa.failureAlertThreshold,
        stalenessAlertMs: cfg.rwa.stalenessAlertMs,
      }),
    );
  }

  // ─── Phase M.4 — Yield drip simulator ──────────────────────────────────────
  // Use RWA_HOLDERS="BENJI=G...|G...,USDY=G..." for demo/testnet yield drips.
  // Production deployments should replace this with an indexer-backed source
  // that discovers current token holders automatically.
  if (cfg.workers.yieldSimulator && Object.keys(cfg.rwa.contracts).length > 0) {
    const holderSources: RwaHolderSource[] = cfg.rwa.feeds.map((feedId) => {
      const feed = feedId.toUpperCase();
      const addresses = cfg.rwa.holdersByFeed[feed] ?? [];
      const contractId = cfg.rwa.contracts[feed];
      if (addresses.length === 0) {
        return new IndexerRwaHolderSource(cfg.indexerUrl, feed);
      }
      return {
        feedId: feed,
        async getHolders() {
          if (!contractId || addresses.length === 0) return [];
          const holders = await Promise.all(
            addresses.map(async (address) => {
              const [balance, cumulativeYield] = await Promise.all([
                stellar.simulate<bigint>(contractId, "balance", [scVal.address(address)]),
                stellar.simulate<bigint>(contractId, "cumulative_yield", [scVal.address(address)]),
              ]);
              return {
                address,
                balanceNative: balance.returnValue,
                cumulativeYield: cumulativeYield.returnValue,
                sinceTs: cfg.rwa.holderSinceTs,
              };
            }),
          );
          return holders.filter((h) => h.balanceNative > 0n);
        },
      };
    });
    const apySource: ApySource = {
      async getApyBps(feedId: string): Promise<number> {
        return cfg.rwa.apyBpsByFeed[feedId.toUpperCase()] ?? 500;
      },
    };
    workers.push(
      new YieldSimulator({
        stellar,
        rwaContracts: cfg.rwa.contracts,
        holderSources,
        apySource,
      }),
    );
  }

  // ─── Phase M.5 — Out-of-band TTL extender ─────────────────────────────────
  // Replaces the in-contract `instance().extend_ttl(...)` calls that pulled
  // contract code blobs into RW footprints and breached `txMaxWriteBytes`.
  // Bumps both the `<instance>` entry and the `<contractCode>` entry per
  // contract on a slow cadence (default ~6h, extends ~30 days each tick).
  if (cfg.workers.ttlExtender) {
    const wasmHashes = resolveWasmHashes(cfg.ttl.wasmHashes, cfg.ttl.deploymentsFile, log);
    const targets: TtlExtenderTarget[] = [
      { name: "oracle", contractId: cfg.contracts.oracle, wasmHash: wasmHashes.stellax_oracle },
      { name: "funding", contractId: cfg.contracts.funding, wasmHash: wasmHashes.stellax_funding },
      { name: "perp_engine", contractId: cfg.contracts.perpEngine, wasmHash: wasmHashes.stellax_perp_engine },
      { name: "risk", contractId: cfg.contracts.risk, wasmHash: wasmHashes.stellax_risk },
    ];
    if (cfg.contracts.structured) {
      targets.push({
        name: "structured",
        contractId: cfg.contracts.structured,
        wasmHash: wasmHashes.stellax_structured,
      });
    }
    if (cfg.contracts.clob) {
      targets.push({
        name: "clob",
        contractId: cfg.contracts.clob,
        wasmHash: wasmHashes.stellax_clob,
      });
    }
    workers.push(
      new TtlExtender({
        stellar,
        ledgersToExtend: cfg.ttl.ledgersToExtend,
        targets: targets.filter((t) => t.contractId),
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
      case "vault-roller":
        return cfg.intervals.vaultRollMs;
      case "clob-matcher":
        return cfg.intervals.clobMatchMs;
      case "rwa-nav-pusher":
        return cfg.intervals.rwaNavPushMs;
      case "yield-simulator":
        return cfg.intervals.yieldSimulatorMs;
      case "ttl-extender":
        return cfg.intervals.ttlExtenderMs;
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

/**
 * Resolve wasm hashes for the TTL extender. Explicit `TTL_WASM_HASHES`
 * config wins; otherwise read from the deployments JSON if a path is set.
 */
function resolveWasmHashes(
  fromConfig: Record<string, string>,
  deploymentsFile: string,
  log: ReturnType<typeof getLogger>,
): Record<string, string> {
  if (Object.keys(fromConfig).length > 0) return fromConfig;
  if (!deploymentsFile) {
    log.warn(
      "ttl-extender: no TTL_WASM_HASHES and no TTL_DEPLOYMENTS_FILE; instance entries will be bumped without contractCode entries",
    );
    return {};
  }
  try {
    const raw = readFileSync(deploymentsFile, "utf8");
    const parsed = JSON.parse(raw) as { wasm_hashes?: Record<string, string> };
    if (!parsed.wasm_hashes) {
      log.warn({ deploymentsFile }, "ttl-extender: deployments file has no wasm_hashes block");
      return {};
    }
    return parsed.wasm_hashes;
  } catch (err) {
    log.error(
      { deploymentsFile, err: (err as Error).message },
      "ttl-extender: failed to read deployments file; continuing without wasm hashes",
    );
    return {};
  }
}
