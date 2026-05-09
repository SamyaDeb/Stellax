/**
 * StellaX Event Indexer — entrypoint.
 *
 * Composition root that wires the SQLite store, the Soroban event watcher,
 * and the HTTP/WebSocket API together, then runs the watcher on a fixed
 * interval.
 *
 * Configuration (env)
 * -------------------
 *   INDEXER_PORT            default 4001
 *   INDEXER_DB_PATH         default ./data/indexer.db
 *   INDEXER_POLL_MS         default 5_000
 *   INDEXER_LOOKBACK_LEDGERS default 5_000
 *   INDEXER_PAGE_LIMIT      default 100
 *   INDEXER_MAX_LIMIT       default 500
 *   SOROBAN_RPC_URL         default https://soroban-testnet.stellar.org
 *   STELLAX_PERP_ENGINE     required
 *   STELLAX_RISK            required
 *   STELLAX_BRIDGE          required
 *   STELLAX_ORACLE          optional; enables oracle/RWA price history
 *   INDEXER_RWA_CONTRACTS   optional BENJI=C...,USDY=C... holder indexing map
 *   STELLAX_RWA_BENJI/USDY/OUSG optional fallback holder indexing contracts
 */

import "dotenv/config";
import { openDb, IndexerStore } from "./db.js";
import { Watcher } from "./watcher.js";
import { ApiServer } from "./api.js";
import { getLogger } from "./logger.js";

const log = getLogger("indexer");

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    log.error({ name }, "missing required env var");
    process.exit(1);
  }
  return v;
}

function parseRwaContracts(): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = process.env.INDEXER_RWA_CONTRACTS ?? "";
  for (const pair of raw.split(",")) {
    const [feedRaw, contractRaw] = pair.split("=").map((s) => s.trim());
    if (feedRaw && contractRaw) out[contractRaw] = feedRaw.toUpperCase();
  }
  const fallbacks: Array<[string, string | undefined]> = [
    ["BENJI", process.env.STELLAX_RWA_BENJI],
    ["USDY", process.env.STELLAX_RWA_USDY],
    ["OUSG", process.env.STELLAX_RWA_OUSG],
  ];
  for (const [feed, contract] of fallbacks) {
    if (contract && !out[contract]) out[contract] = feed;
  }
  return out;
}

async function main(): Promise<void> {
  const port = Number(process.env.INDEXER_PORT ?? 4001);
  const dbPath = process.env.INDEXER_DB_PATH ?? "./data/indexer.db";
  const pollMs = Number(process.env.INDEXER_POLL_MS ?? 5_000);
  const initialLookbackLedgers = Number(process.env.INDEXER_LOOKBACK_LEDGERS ?? 5_000);
  const pageLimit = Number(process.env.INDEXER_PAGE_LIMIT ?? 100);
  const maxLimit = Number(process.env.INDEXER_MAX_LIMIT ?? 500);
  const healthFeeds = (process.env.INDEXER_HEALTH_FEEDS ?? "BTC,ETH,SOL,BENJI,USDY,OUSG")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const feedFreshnessMs = Number(process.env.INDEXER_FEED_FRESHNESS_MS ?? 120_000);
  const rpcUrl = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
  const rwaIssuers = parseRwaContracts();

  const db = openDb(dbPath);
  const store = new IndexerStore(db);

  const api = new ApiServer({ port, maxLimit, healthFeeds, feedFreshnessMs }, store);
  api.start();

  const watcher = new Watcher(
    {
      rpcUrl,
      contracts: {
        perpEngine: required("STELLAX_PERP_ENGINE"),
        risk:       required("STELLAX_RISK"),
        bridge:     required("STELLAX_BRIDGE"),
        clob:       process.env.STELLAX_CLOB ?? "",
        oracle:     process.env.STELLAX_ORACLE ?? "",
        rwaIssuers,
      },
      initialLookbackLedgers,
      pageLimit,
    },
    store,
    (ev) => api.broadcast(ev),
  );

  let stopping = false;
  const shutdown = (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ sig }, "shutting down");
    api.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  log.info({ port, dbPath, pollMs }, "indexer started");

  // Poll loop
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await watcher.tick();
    } catch (err) {
      log.warn({ err: (err as Error).message }, "watcher tick failed");
    }
    await sleep(pollMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  log.error({ err }, "fatal");
  process.exit(1);
});
