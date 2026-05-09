/**
 * db.ts — SQLite schema + upsert helpers for the StellaX event indexer.
 *
 * Uses better-sqlite3 (synchronous, in-process). The WAL journaling mode is
 * enabled so that the HTTP/WebSocket API can read concurrently with the
 * watcher's writes.
 *
 * Schema
 * ------
 *   positions(position_id PK)   — current open positions (closed rows deleted)
 *   trades(id PK autoinc)       — immutable trade history
 *   liquidations(id PK autoinc) — liquidation events
 *   deposits(id PK autoinc)     — inbound/outbound bridge events
 *   cursor(k PK, v)             — watcher resume state
 *
 * All monetary values are stored as TEXT (base-10 decimal) so JS bigints can
 * round-trip losslessly.
 */

import Database, { type Database as Db } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ── Row types ────────────────────────────────────────────────────────────────

export interface PositionRow {
  positionId: string;           // u64 as decimal string
  user: string;                 // Stellar G-address
  marketId: number;
  isLong: 0 | 1;
  size: string;                 // i128 decimal
  entryPrice: string;           // i128 decimal (7dp)
  leverage: number;             // leverage multiplier (e.g. 5 for 5×)
  openedAt: number;             // unix seconds
  openTxHash: string;
}

export interface TradeRow {
  id?: number;
  user: string;
  positionId: string;
  marketId: number;
  kind: "open" | "close" | "modify";
  size: string;
  price: string;
  pnl: string | null;           // null for open; set for close
  isLong: 0 | 1;
  ts: number;
  txHash: string;
}

export interface LiquidationRow {
  id?: number;
  user: string;
  positionId: string;
  oraclePrice: string;
  remainingMargin: string;
  keeperReward: string;
  ts: number;
  txHash: string;
}

export interface DepositRow {
  id?: number;
  direction: "in" | "out";
  user: string;
  amount: string;
  destChain: string | null;     // set for outbound
  ts: number;
  txHash: string;
}

export interface OrderRow {
  orderId: string;
  trader: string;
  marketId: number;
  isLong: 0 | 1;
  /** 18-dec limit price. */
  price: string;
  /** 18-dec requested size (base units). */
  size: string;
  /** 18-dec filled size accumulated across partial fills. */
  filledSize: string;
  status: "open" | "filled" | "cancelled";
  placedAt: number;
  updatedAt: number;
  placeTxHash: string;
}

/** Oracle price update persisted from `price_upd` / `price_adm` events. */
export interface OraclePriceRow {
  id?: number;
  feed: string;
  /** 18-decimal fixed-point price as decimal string. */
  price: string;
  /** Source package/NAV timestamp in milliseconds. */
  packageTimestamp: string;
  /** Ledger close timestamp in seconds. */
  writeTimestamp: number;
  source: "redstone" | "admin";
  txHash: string;
}

/** Current holder snapshot for mock RWA issuer contracts. */
export interface RwaHolderRow {
  feed: string;
  address: string;
  /** Native-token balance using the issuer's decimals, as a decimal string. */
  balanceNative: string;
  /** Lifetime yield credited by the issuer, as a decimal string. */
  cumulativeYield: string;
  /** First indexed holder activity timestamp in seconds. */
  firstSeenTs: number;
  /** Last indexed holder activity timestamp in seconds. */
  updatedAt: number;
}

// ── Opener ───────────────────────────────────────────────────────────────────

export function openDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS positions (
      position_id   TEXT PRIMARY KEY,
      user          TEXT NOT NULL,
      market_id     INTEGER NOT NULL,
      is_long       INTEGER NOT NULL,
      size          TEXT NOT NULL,
      entry_price   TEXT NOT NULL,
      leverage      INTEGER NOT NULL,
      opened_at     INTEGER NOT NULL,
      open_tx_hash  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS positions_user_idx ON positions(user);
    CREATE INDEX IF NOT EXISTS positions_market_idx ON positions(market_id);

    CREATE TABLE IF NOT EXISTS trades (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user          TEXT NOT NULL,
      position_id   TEXT NOT NULL,
      market_id     INTEGER NOT NULL,
      kind          TEXT NOT NULL,
      size          TEXT NOT NULL,
      price         TEXT NOT NULL,
      pnl           TEXT,
      is_long       INTEGER NOT NULL,
      ts            INTEGER NOT NULL,
      tx_hash       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS trades_user_ts_idx ON trades(user, ts DESC);

    CREATE TABLE IF NOT EXISTS liquidations (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      user              TEXT NOT NULL,
      position_id       TEXT NOT NULL,
      oracle_price      TEXT NOT NULL,
      remaining_margin  TEXT NOT NULL,
      keeper_reward     TEXT NOT NULL,
      ts                INTEGER NOT NULL,
      tx_hash           TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS liquidations_user_ts_idx ON liquidations(user, ts DESC);

    CREATE TABLE IF NOT EXISTS deposits (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      direction   TEXT NOT NULL,
      user        TEXT NOT NULL,
      amount      TEXT NOT NULL,
      dest_chain  TEXT,
      ts          INTEGER NOT NULL,
      tx_hash     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS deposits_user_ts_idx ON deposits(user, ts DESC);

    CREATE TABLE IF NOT EXISTS orders (
      order_id       TEXT PRIMARY KEY,
      trader         TEXT NOT NULL,
      market_id      INTEGER NOT NULL,
      is_long        INTEGER NOT NULL,
      price          TEXT NOT NULL,
      size           TEXT NOT NULL,
      filled_size    TEXT NOT NULL,
      status         TEXT NOT NULL,
      placed_at      INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      place_tx_hash  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS orders_market_idx ON orders(market_id, status);
    CREATE INDEX IF NOT EXISTS orders_trader_idx ON orders(trader, status);

    CREATE TABLE IF NOT EXISTS oracle_prices (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      feed               TEXT NOT NULL,
      price              TEXT NOT NULL,
      package_timestamp  TEXT NOT NULL,
      write_timestamp    INTEGER NOT NULL,
      source             TEXT NOT NULL,
      tx_hash            TEXT NOT NULL,
      UNIQUE(feed, package_timestamp, source)
    );
    CREATE INDEX IF NOT EXISTS oracle_prices_feed_ts_idx
      ON oracle_prices(feed, write_timestamp DESC);

    CREATE TABLE IF NOT EXISTS rwa_holders (
      feed              TEXT NOT NULL,
      address           TEXT NOT NULL,
      balance_native    TEXT NOT NULL,
      cumulative_yield  TEXT NOT NULL,
      first_seen_ts     INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      PRIMARY KEY(feed, address)
    );
    CREATE INDEX IF NOT EXISTS rwa_holders_feed_balance_idx
      ON rwa_holders(feed, balance_native);

    CREATE TABLE IF NOT EXISTS cursor (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
  `);

  return db;
}

// ── Upsert helpers ───────────────────────────────────────────────────────────

export class IndexerStore {
  private readonly insPos;
  private readonly delPos;
  private readonly insTrade;
  private readonly insLiq;
  private readonly insDep;
  private readonly upsertOrder;
  private readonly updateOrderStatus;
  private readonly addOrderFill;
  private readonly getOrderById;
  private readonly insertOraclePriceStmt;
  private readonly getRwaHolder;
  private readonly upsertRwaHolder;
  private readonly setCur;
  private readonly getCur;

  constructor(private readonly db: Db) {
    this.insPos = db.prepare(`
      INSERT OR REPLACE INTO positions
      (position_id, user, market_id, is_long, size, entry_price, leverage, opened_at, open_tx_hash)
      VALUES (@positionId, @user, @marketId, @isLong, @size, @entryPrice, @leverage, @openedAt, @openTxHash)
    `);
    this.delPos = db.prepare(`DELETE FROM positions WHERE position_id = ?`);

    this.insTrade = db.prepare(`
      INSERT INTO trades
      (user, position_id, market_id, kind, size, price, pnl, is_long, ts, tx_hash)
      VALUES (@user, @positionId, @marketId, @kind, @size, @price, @pnl, @isLong, @ts, @txHash)
    `);

    this.insLiq = db.prepare(`
      INSERT INTO liquidations
      (user, position_id, oracle_price, remaining_margin, keeper_reward, ts, tx_hash)
      VALUES (@user, @positionId, @oraclePrice, @remainingMargin, @keeperReward, @ts, @txHash)
    `);

    this.insDep = db.prepare(`
      INSERT INTO deposits
      (direction, user, amount, dest_chain, ts, tx_hash)
      VALUES (@direction, @user, @amount, @destChain, @ts, @txHash)
    `);

    this.upsertOrder = db.prepare(`
      INSERT INTO orders (order_id, trader, market_id, is_long, price, size,
                          filled_size, status, placed_at, updated_at, place_tx_hash)
      VALUES (@orderId, @trader, @marketId, @isLong, @price, @size,
              @filledSize, @status, @placedAt, @updatedAt, @placeTxHash)
      ON CONFLICT(order_id) DO UPDATE SET
        status     = excluded.status,
        filled_size= excluded.filled_size,
        updated_at = excluded.updated_at
    `);
    this.updateOrderStatus = db.prepare(`
      UPDATE orders SET status = ?, updated_at = ? WHERE order_id = ?
    `);
    this.getOrderById = db.prepare(`SELECT * FROM orders WHERE order_id = ?`);
    this.addOrderFill = db.prepare(`
      UPDATE orders
      SET filled_size = ?, status = ?, updated_at = ?
      WHERE order_id = ?
    `);

    this.insertOraclePriceStmt = db.prepare(`
      INSERT OR IGNORE INTO oracle_prices
      (feed, price, package_timestamp, write_timestamp, source, tx_hash)
      VALUES (@feed, @price, @packageTimestamp, @writeTimestamp, @source, @txHash)
    `);

    this.getRwaHolder = db.prepare(`
      SELECT * FROM rwa_holders WHERE feed = ? AND address = ?
    `);
    this.upsertRwaHolder = db.prepare(`
      INSERT INTO rwa_holders
      (feed, address, balance_native, cumulative_yield, first_seen_ts, updated_at)
      VALUES (@feed, @address, @balanceNative, @cumulativeYield, @firstSeenTs, @updatedAt)
      ON CONFLICT(feed, address) DO UPDATE SET
        balance_native   = excluded.balance_native,
        cumulative_yield = excluded.cumulative_yield,
        updated_at       = excluded.updated_at
    `);

    this.setCur = db.prepare(`
      INSERT INTO cursor (k, v) VALUES (?, ?)
      ON CONFLICT(k) DO UPDATE SET v = excluded.v
    `);
    this.getCur = db.prepare(`SELECT v FROM cursor WHERE k = ?`);
  }

  insertPosition(row: PositionRow): void { this.insPos.run(row); }
  deletePosition(id: string): void { this.delPos.run(id); }
  insertTrade(row: TradeRow): void { this.insTrade.run(row); }
  insertLiquidation(row: LiquidationRow): void { this.insLiq.run(row); }
  insertDeposit(row: DepositRow): void { this.insDep.run(row); }
  insertOraclePrice(row: OraclePriceRow): void {
    this.insertOraclePriceStmt.run({ ...row, feed: row.feed.toUpperCase() });
  }

  // ── RWA holder helpers ────────────────────────────────────────────────────

  applyRwaMint(feed: string, to: string, amount: string, ts: number): void {
    this.adjustRwaHolder(feed, to, BigInt(amount), 0n, ts);
  }

  applyRwaBurn(feed: string, from: string, amount: string, ts: number): void {
    this.adjustRwaHolder(feed, from, -BigInt(amount), 0n, ts);
  }

  applyRwaTransfer(feed: string, from: string, to: string, amount: string, ts: number): void {
    const delta = BigInt(amount);
    this.adjustRwaHolder(feed, from, -delta, 0n, ts);
    this.adjustRwaHolder(feed, to, delta, 0n, ts);
  }

  applyRwaYield(feed: string, holder: string, amount: string, ts: number): void {
    const delta = BigInt(amount);
    this.adjustRwaHolder(feed, holder, delta, delta, ts);
  }

  private adjustRwaHolder(
    feedRaw: string,
    address: string,
    balanceDelta: bigint,
    yieldDelta: bigint,
    ts: number,
  ): void {
    if (!/^G[A-Z2-7]{55}$/.test(address)) return;
    const feed = feedRaw.toUpperCase();
    const row = this.getRwaHolder.get(feed, address) as Record<string, unknown> | undefined;
    const prevBalance = row ? BigInt(String(row.balance_native)) : 0n;
    const prevYield = row ? BigInt(String(row.cumulative_yield)) : 0n;
    const nextBalance = prevBalance + balanceDelta;
    const nextYield = prevYield + yieldDelta;
    this.upsertRwaHolder.run({
      feed,
      address,
      balanceNative: (nextBalance > 0n ? nextBalance : 0n).toString(),
      cumulativeYield: (nextYield > 0n ? nextYield : 0n).toString(),
      firstSeenTs: row ? Number(row.first_seen_ts) : ts,
      updatedAt: ts,
    });
  }

  // ── CLOB order helpers ─────────────────────────────────────────────────────

  insertOrder(row: OrderRow): void { this.upsertOrder.run(row); }

  cancelOrder(orderId: string, ts: number): void {
    this.updateOrderStatus.run("cancelled", ts, orderId);
  }

  /**
   * Apply a partial fill against an order. `fillSize` is 18-dec base units.
   * Uses application-side bigint math since SQLite INTEGER can't hold 1e18 safely
   * when sizes approach 2^63.
   */
  fillOrder(orderId: string, fillSize: bigint, ts: number): void {
    const row = this.getOrderById.get(orderId) as Record<string, unknown> | undefined;
    if (!row) return;
    const prev = BigInt((row.filled_size as string) ?? "0");
    const total = BigInt((row.size as string) ?? "0");
    const next = prev + fillSize;
    const status = next >= total ? "filled" : (row.status as string);
    this.addOrderFill.run(next.toString(), status, ts, orderId);
  }

  listOpenOrders(marketId?: number): OrderRow[] {
    const stmt = marketId !== undefined
      ? this.db.prepare(`SELECT * FROM orders WHERE market_id = ? AND status = 'open' ORDER BY placed_at ASC`)
      : this.db.prepare(`SELECT * FROM orders WHERE status = 'open' ORDER BY placed_at ASC`);
    const rows = (marketId !== undefined ? stmt.all(marketId) : stmt.all()) as Array<Record<string, unknown>>;
    return rows.map(camelizeOrder);
  }

  listRwaHolders(feed: string, limit = 500): RwaHolderRow[] {
    const rows = this.db.prepare(`
      SELECT * FROM rwa_holders
      WHERE feed = ? AND balance_native != '0'
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(feed.toUpperCase(), limit) as Array<Record<string, unknown>>;
    return rows.map(camelizeRwaHolder);
  }

  listUserOrders(trader: string, status?: OrderRow["status"]): OrderRow[] {
    const stmt = status
      ? this.db.prepare(`SELECT * FROM orders WHERE trader = ? AND status = ? ORDER BY placed_at DESC`)
      : this.db.prepare(`SELECT * FROM orders WHERE trader = ? ORDER BY placed_at DESC`);
    const rows = (status ? stmt.all(trader, status) : stmt.all(trader)) as Array<Record<string, unknown>>;
    return rows.map(camelizeOrder);
  }

  setCursor(k: string, v: string): void { this.setCur.run(k, v); }
  getCursor(k: string): string | null {
    const row = this.getCur.get(k) as { v: string } | undefined;
    return row?.v ?? null;
  }

  // ── Query helpers (used by api.ts) ─────────────────────────────────────────

  listOpenPositions(user?: string): PositionRow[] {
    const stmt = user
      ? this.db.prepare(`SELECT * FROM positions WHERE user = ? ORDER BY opened_at DESC`)
      : this.db.prepare(`SELECT * FROM positions ORDER BY opened_at DESC`);
    const rows = (user ? stmt.all(user) : stmt.all()) as Array<Record<string, unknown>>;
    return rows.map(camelizePosition);
  }

  listTrades(user: string, limit: number): TradeRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM trades WHERE user = ? ORDER BY ts DESC LIMIT ?
    `);
    const rows = stmt.all(user, limit) as Array<Record<string, unknown>>;
    return rows.map(camelizeTrade);
  }

  listLiquidations(user: string, limit: number): LiquidationRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM liquidations WHERE user = ? ORDER BY ts DESC LIMIT ?
    `);
    const rows = stmt.all(user, limit) as Array<Record<string, unknown>>;
    return rows.map(camelizeLiquidation);
  }

  getLatestOraclePrice(feed: string): OraclePriceRow | null {
    const row = this.db.prepare(`
      SELECT * FROM oracle_prices WHERE feed = ? ORDER BY write_timestamp DESC, id DESC LIMIT 1
    `).get(feed.toUpperCase()) as Record<string, unknown> | undefined;
    return row ? camelizeOraclePrice(row) : null;
  }

  listOraclePrices(feed: string, limit: number): OraclePriceRow[] {
    const rows = this.db.prepare(`
      SELECT * FROM oracle_prices WHERE feed = ? ORDER BY write_timestamp DESC, id DESC LIMIT ?
    `).all(feed.toUpperCase(), limit) as Array<Record<string, unknown>>;
    return rows.map(camelizeOraclePrice);
  }
}

// ── Row → camelCase mappers (sqlite returns snake_case columns) ──────────────

function camelizePosition(r: Record<string, unknown>): PositionRow {
  return {
    positionId: r.position_id as string,
    user: r.user as string,
    marketId: Number(r.market_id),
    isLong: Number(r.is_long) === 1 ? 1 : 0,
    size: r.size as string,
    entryPrice: r.entry_price as string,
    leverage: Number(r.leverage),
    openedAt: Number(r.opened_at),
    openTxHash: r.open_tx_hash as string,
  };
}

function camelizeTrade(r: Record<string, unknown>): TradeRow {
  return {
    id: Number(r.id),
    user: r.user as string,
    positionId: r.position_id as string,
    marketId: Number(r.market_id),
    kind: r.kind as TradeRow["kind"],
    size: r.size as string,
    price: r.price as string,
    pnl: (r.pnl as string | null) ?? null,
    isLong: Number(r.is_long) === 1 ? 1 : 0,
    ts: Number(r.ts),
    txHash: r.tx_hash as string,
  };
}

function camelizeLiquidation(r: Record<string, unknown>): LiquidationRow {
  return {
    id: Number(r.id),
    user: r.user as string,
    positionId: r.position_id as string,
    oraclePrice: r.oracle_price as string,
    remainingMargin: r.remaining_margin as string,
    keeperReward: r.keeper_reward as string,
    ts: Number(r.ts),
    txHash: r.tx_hash as string,
  };
}

function camelizeOrder(r: Record<string, unknown>): OrderRow {
  const status = r.status as string;
  return {
    orderId: r.order_id as string,
    trader: r.trader as string,
    marketId: Number(r.market_id),
    isLong: Number(r.is_long) === 1 ? 1 : 0,
    price: r.price as string,
    size: r.size as string,
    filledSize: r.filled_size as string,
    status: (status === "filled" || status === "cancelled" ? status : "open") as OrderRow["status"],
    placedAt: Number(r.placed_at),
    updatedAt: Number(r.updated_at),
    placeTxHash: r.place_tx_hash as string,
  };
}

function camelizeOraclePrice(r: Record<string, unknown>): OraclePriceRow {
  const source = r.source === "admin" ? "admin" : "redstone";
  return {
    id: Number(r.id),
    feed: String(r.feed),
    price: String(r.price),
    packageTimestamp: String(r.package_timestamp),
    writeTimestamp: Number(r.write_timestamp),
    source,
    txHash: String(r.tx_hash),
  };
}

function camelizeRwaHolder(r: Record<string, unknown>): RwaHolderRow {
  return {
    feed: String(r.feed),
    address: String(r.address),
    balanceNative: String(r.balance_native),
    cumulativeYield: String(r.cumulative_yield),
    firstSeenTs: Number(r.first_seen_ts),
    updatedAt: Number(r.updated_at),
  };
}
