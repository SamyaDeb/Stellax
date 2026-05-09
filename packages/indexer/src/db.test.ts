import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, IndexerStore, type OraclePriceRow } from "./db.js";
import { ApiServer } from "./api.js";

const tmpDirs: string[] = [];

function makeStore(): { db: ReturnType<typeof openDb>; store: IndexerStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "stellax-indexer-"));
  tmpDirs.push(dir);
  const db = openDb(join(dir, "indexer.sqlite"));
  return { db, store: new IndexerStore(db), dir };
}

function oracleRow(overrides: Partial<OraclePriceRow> = {}): OraclePriceRow {
  return {
    feed: "BENJI",
    price: "1000000000000000000",
    packageTimestamp: "1700000000000",
    writeTimestamp: 1700000000,
    source: "admin",
    txHash: "tx-1",
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("oracle price persistence", () => {
  it("stores oracle prices case-insensitively and ignores duplicate packages", () => {
    const { db, store } = makeStore();
    try {
      store.insertOraclePrice(oracleRow({ feed: "benji" }));
      store.insertOraclePrice(oracleRow({ feed: "BENJI", price: "999000000000000000" }));
      store.insertOraclePrice(oracleRow({ price: "1010000000000000000", packageTimestamp: "1700000060000", writeTimestamp: 1700000060, txHash: "tx-2" }));

      const latest = store.getLatestOraclePrice("benji");
      expect(latest).toMatchObject({
        feed: "BENJI",
        price: "1010000000000000000",
        packageTimestamp: "1700000060000",
        source: "admin",
      });

      const rows = store.listOraclePrices("BENJI", 10);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.txHash)).toEqual(["tx-2", "tx-1"]);
    } finally {
      db.close();
    }
  });
});

describe("health feeds API", () => {
  it("reports per-feed freshness with fresh and stale states", async () => {
    const { db, store } = makeStore();
    const port = 47_000 + Math.floor(Math.random() * 1_000);
    const api = new ApiServer(
      { port, maxLimit: 50, healthFeeds: ["BENJI", "USDY"], feedFreshnessMs: 60_000 },
      store,
    );
    try {
      const now = Date.now();
      // Fresh: 5s old.
      store.insertOraclePrice(
        oracleRow({
          feed: "BENJI",
          packageTimestamp: String(now - 5_000),
          writeTimestamp: Math.floor((now - 5_000) / 1000),
          txHash: "tx-fresh",
        }),
      );
      // Stale: 10 min old.
      store.insertOraclePrice(
        oracleRow({
          feed: "USDY",
          packageTimestamp: String(now - 600_000),
          writeTimestamp: Math.floor((now - 600_000) / 1000),
          txHash: "tx-stale",
        }),
      );

      api.start();
      await new Promise((resolve) => setTimeout(resolve, 25));

      const body = (await fetch(`http://127.0.0.1:${port}/health/feeds`).then((r) => r.json())) as {
        ok: boolean;
        freshnessMs: number;
        feeds: Array<{ feed: string; fresh: boolean; ageMs: number | null; price: string | null }>;
      };
      expect(body.ok).toBe(false);
      expect(body.freshnessMs).toBe(60_000);
      const benji = body.feeds.find((f) => f.feed === "BENJI")!;
      expect(benji.fresh).toBe(true);
      expect(benji.ageMs).toBeGreaterThanOrEqual(0);
      const usdy = body.feeds.find((f) => f.feed === "USDY")!;
      expect(usdy.fresh).toBe(false);
      expect(usdy.ageMs).toBeGreaterThan(60_000);

      // Custom feed list via query string.
      const custom = (await fetch(`http://127.0.0.1:${port}/health/feeds?feeds=BENJI`).then((r) =>
        r.json(),
      )) as { ok: boolean; feeds: Array<{ feed: string; fresh: boolean }> };
      expect(custom.ok).toBe(true);
      expect(custom.feeds).toHaveLength(1);

      // Unknown feed -> price null and not fresh.
      const unknown = (await fetch(`http://127.0.0.1:${port}/health/feeds?feeds=ZZZ`).then((r) =>
        r.json(),
      )) as { ok: boolean; feeds: Array<{ feed: string; fresh: boolean; price: string | null }> };
      expect(unknown.ok).toBe(false);
      expect(unknown.feeds[0]?.price).toBeNull();
    } finally {
      api.stop();
      db.close();
    }
  });
});

describe("oracle price API", () => {
  it("serves latest, history, and bucketed candles", async () => {
    const { db, store } = makeStore();
    const port = 45_000 + Math.floor(Math.random() * 1_000);
    const api = new ApiServer({ port, maxLimit: 50, healthFeeds: ["BENJI"], feedFreshnessMs: 120_000 }, store);
    try {
      store.insertOraclePrice(oracleRow({ price: "1000000000000000000", packageTimestamp: "1700000000000", writeTimestamp: 1700000001, txHash: "tx-1" }));
      store.insertOraclePrice(oracleRow({ price: "1100000000000000000", packageTimestamp: "1700000010000", writeTimestamp: 1700000010, txHash: "tx-2" }));
      store.insertOraclePrice(oracleRow({ price: "900000000000000000", packageTimestamp: "1700000020000", writeTimestamp: 1700000020, txHash: "tx-3" }));
      store.insertOraclePrice(oracleRow({ price: "1200000000000000000", packageTimestamp: "1700000060000", writeTimestamp: 1700000065, txHash: "tx-4" }));

      api.start();
      await new Promise((resolve) => setTimeout(resolve, 25));

      const latest = await fetch(`http://127.0.0.1:${port}/prices/benji/latest`).then((r) => r.json()) as OraclePriceRow;
      expect(latest.price).toBe("1200000000000000000");

      const history = await fetch(`http://127.0.0.1:${port}/prices/BENJI/history?limit=2`).then((r) => r.json()) as OraclePriceRow[];
      expect(history.map((r) => r.txHash)).toEqual(["tx-4", "tx-3"]);

      const candles = await fetch(`http://127.0.0.1:${port}/prices/BENJI/candles?interval=60&limit=5`).then((r) => r.json()) as Array<{ open: string; high: string; low: string; close: string }>;
      expect(candles).toEqual([
        {
          open: "1000000000000000000",
          high: "1100000000000000000",
          low: "900000000000000000",
          close: "900000000000000000",
          source: "admin",
          time: 1699999980,
        },
        {
          open: "1200000000000000000",
          high: "1200000000000000000",
          low: "1200000000000000000",
          close: "1200000000000000000",
          source: "admin",
          time: 1700000040,
        },
      ]);
    } finally {
      api.stop();
      db.close();
    }
  });
});

describe("keeper source API", () => {
  const holderA = "GCRW6BBUCQB4AT4YZLGPI4WGB2GAPCQYWZPYPVKUNM2DI36K6YV3HOJD";
  const holderB = "GBAIDZICNOVW2C5EJYAIN3GT4I6FT7IIF335Y67E66IYSNF7ZVJYVL63";

  it("serves RWA holder snapshots", async () => {
    const { db, store } = makeStore();
    const port = 46_000 + Math.floor(Math.random() * 1_000);
    const api = new ApiServer({ port, maxLimit: 50, healthFeeds: ["BENJI"], feedFreshnessMs: 120_000 }, store);
    try {
      store.applyRwaMint("BENJI", holderA, "50000000", 1_700_000_000);
      store.applyRwaTransfer("BENJI", holderA, holderB, "10000000", 1_700_000_020);
      store.applyRwaYield("BENJI", holderB, "1000000", 1_700_000_030);

      api.start();
      await new Promise((resolve) => setTimeout(resolve, 25));

      const holders = await fetch(`http://127.0.0.1:${port}/rwa-holders/BENJI`).then((r) => r.json()) as Array<{ address: string; balanceNative: string; cumulativeYield: string }>;
      expect(holders).toEqual([
        expect.objectContaining({ address: holderB, balanceNative: "11000000", cumulativeYield: "1000000" }),
        expect.objectContaining({ address: holderA, balanceNative: "40000000", cumulativeYield: "0" }),
      ]);
    } finally {
      api.stop();
      db.close();
    }
  });
});
