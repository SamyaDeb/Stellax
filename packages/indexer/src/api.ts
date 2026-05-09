/**
 * api.ts — HTTP REST + WebSocket server for the StellaX indexer.
 *
 * REST:
 *   GET  /health                       → { ok: true, ts }
 *   GET  /positions?user=G...          → open positions for user (or all)
 *   GET  /trades?user=G...&limit=50    → trade history (descending)
 *   GET  /liquidations?user=G...&limit=50
 *   GET  /rwa-holders/:feed             → indexed mock RWA holders
 *   GET  /prices/:feed/latest          → latest oracle price event for feed
 *   GET  /prices/:feed/history         → raw oracle price events
 *   GET  /prices/:feed/candles         → bucketed OHLC candles from oracle events
 *
 * WebSocket (`/ws`):
 *   On connect the server accepts; clients may send `{ "subscribe": "G..." }`
 *   to filter pushes to a single user. When no subscription is set the client
 *   receives every event.
 *
 *   Push envelope:
 *     { type: "position_open" | "position_close" | "position_modify" |
 *             "liquidation"  | "deposit"       |
 *             "order_place"  | "order_cancel" | "order_fill" |
 *             "oracle_price" | "rwa_holder",
 *       data: <row> }
 */

import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import { createServer, type Server } from "node:http";
import { getLogger } from "./logger.js";
import type { IndexerStore, OraclePriceRow } from "./db.js";
import type { DecodedEvent } from "./watcher.js";

export interface ApiConfig {
  port: number;
  /** Max rows returned by a single /trades or /liquidations query. */
  maxLimit: number;
  /** Default feed list for /health/feeds. */
  healthFeeds: string[];
  /** Max age (ms) before a feed is considered stale by /health/feeds. */
  feedFreshnessMs: number;
}

export class ApiServer {
  private readonly log = getLogger("api");
  private readonly app: Express;
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly subs = new Map<WebSocket, string | null>();

  constructor(private readonly cfg: ApiConfig, private readonly store: IndexerStore) {
    this.app = express();
    this.app.use(cors());
    this.app.use(express.json());

    this.app.get("/health", (_req: Request, res: Response) => {
      res.json({ ok: true, ts: Date.now() });
    });

    // Tier 4: per-feed freshness for the UI status dot.
    // Returns { ts, feeds: [{ feed, price, ageMs, fresh, source, packageTimestamp, writeTimestamp }] }.
    // `fresh` is true when ageMs < cfg.feedFreshnessMs (default 120s).
    this.app.get("/health/feeds", (req: Request, res: Response) => {
      const requested = typeof req.query.feeds === "string" && req.query.feeds.length > 0
        ? req.query.feeds.split(",").map((s) => s.trim()).filter(Boolean)
        : cfg.healthFeeds;
      const now = Date.now();
      const freshnessMs = cfg.feedFreshnessMs;
      const feeds = requested.map((feed) => {
        const row = this.store.getLatestOraclePrice(feed);
        if (!row) {
          return { feed, price: null, ageMs: null, fresh: false, source: null };
        }
        const ageMs = now - Number(row.packageTimestamp);
        return {
          feed,
          price: row.price,
          ageMs,
          fresh: ageMs >= 0 && ageMs < freshnessMs,
          source: row.source,
          packageTimestamp: row.packageTimestamp,
          writeTimestamp: row.writeTimestamp,
          txHash: row.txHash,
        };
      });
      const allFresh = feeds.every((f) => f.fresh);
      res.json({ ok: allFresh, ts: now, freshnessMs, feeds });
    });

    this.app.get("/prices/:feed/latest", (req: Request, res: Response) => {
      const feed = parseFeed(req);
      if (feed === null) {
        res.status(400).json({ error: "invalid feed" });
        return;
      }
      const row = this.store.getLatestOraclePrice(feed);
      if (row === null) {
        res.status(404).json({ error: "price not found" });
        return;
      }
      res.json(row);
    });

    this.app.get("/prices/:feed/history", (req: Request, res: Response) => {
      const feed = parseFeed(req);
      if (feed === null) {
        res.status(400).json({ error: "invalid feed" });
        return;
      }
      const limit = clampLimit(req, cfg.maxLimit);
      res.json(this.store.listOraclePrices(feed, limit));
    });

    this.app.get("/prices/:feed/candles", (req: Request, res: Response) => {
      const feed = parseFeed(req);
      if (feed === null) {
        res.status(400).json({ error: "invalid feed" });
        return;
      }
      const limit = clampLimit(req, cfg.maxLimit);
      const intervalSecs = clampIntervalSecs(req);
      const rows = this.store.listOraclePrices(feed, Math.min(cfg.maxLimit, limit * 20));
      res.json(toCandles(rows, intervalSecs, limit));
    });

    this.app.get("/positions", (req: Request, res: Response) => {
      const user = parseUser(req);
      const rows = this.store.listOpenPositions(user ?? undefined);
      res.json(rows);
    });

    this.app.get("/trades", (req: Request, res: Response) => {
      const user = parseUser(req);
      if (user === null) {
        res.status(400).json({ error: "user query parameter required" });
        return;
      }
      const limit = clampLimit(req, cfg.maxLimit);
      res.json(this.store.listTrades(user, limit));
    });

    this.app.get("/liquidations", (req: Request, res: Response) => {
      const user = parseUser(req);
      if (user === null) {
        res.status(400).json({ error: "user query parameter required" });
        return;
      }
      const limit = clampLimit(req, cfg.maxLimit);
      res.json(this.store.listLiquidations(user, limit));
    });

    this.app.get("/rwa-holders/:feed", (req: Request, res: Response) => {
      const feed = parseFeed(req);
      if (feed === null) {
        res.status(400).json({ error: "invalid feed" });
        return;
      }
      const limit = clampLimit(req, cfg.maxLimit);
      res.json(this.store.listRwaHolders(feed, limit));
    });

    this.app.get("/orders", (req: Request, res: Response) => {
      const trader = parseUser(req);
      const marketRaw = req.query.marketId;
      const marketId =
        typeof marketRaw === "string" && /^\d+$/.test(marketRaw)
          ? Number(marketRaw)
          : undefined;

      if (trader !== null) {
        const statusRaw = req.query.status;
        const status =
          statusRaw === "open" || statusRaw === "filled" || statusRaw === "cancelled"
            ? statusRaw
            : undefined;
        res.json(this.store.listUserOrders(trader, status));
        return;
      }
      res.json(this.store.listOpenOrders(marketId));
    });

    this.http = createServer(this.app);
    this.wss = new WebSocketServer({ server: this.http, path: "/ws" });

    this.wss.on("connection", (ws) => {
      this.subs.set(ws, null);
      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as { subscribe?: unknown };
          if (typeof msg.subscribe === "string" && /^G[A-Z2-7]{55}$/.test(msg.subscribe)) {
            this.subs.set(ws, msg.subscribe);
          } else {
            ws.send(JSON.stringify({ error: "invalid subscribe value" }));
          }
        } catch {
          ws.send(JSON.stringify({ error: "malformed message" }));
        }
      });
      ws.on("close", () => this.subs.delete(ws));
    });
  }

  start(): void {
    this.http.listen(this.cfg.port, () => {
      this.log.info({ port: this.cfg.port }, "indexer API listening");
    });
  }

  stop(): void {
    this.wss.close();
    this.http.close();
  }

  /** Broadcast a decoded event to subscribed WebSocket clients. */
  broadcast(ev: DecodedEvent): void {
    const type = ev.kind;
    let data: unknown;
    let user: string | null = null;

    if (ev.kind === "order_cancel") {
      data = { orderId: ev.orderId, ts: ev.ts };
    } else if (ev.kind === "order_fill") {
      data = { buyId: ev.buyId, sellId: ev.sellId, fillSize: ev.fillSize, ts: ev.ts };
    } else if (ev.kind === "rwa_holder") {
      data = ev.event;
      user = ev.event.kind === "transfer" ? null : ev.event.address;
    } else {
      data = ev.row;
      const row = ev.row as { user?: string; trader?: string };
      user = row.user ?? row.trader ?? null;
    }

    const payload = JSON.stringify({ type, data });

    for (const [ws, sub] of this.subs) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (sub !== null && sub !== user) continue;
      try {
        ws.send(payload);
      } catch (err) {
        this.log.warn({ err: (err as Error).message }, "ws send failed");
      }
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function parseUser(req: Request): string | null {
  const raw = req.query.user;
  if (typeof raw !== "string") return null;
  if (!/^G[A-Z2-7]{55}$/.test(raw)) return null;
  return raw;
}

function parseFeed(req: Request): string | null {
  const raw = req.params.feed;
  if (typeof raw !== "string") return null;
  const feed = raw.trim().toUpperCase();
  return /^[A-Z0-9_]{1,32}$/.test(feed) ? feed : null;
}

function clampLimit(req: Request, max: number): number {
  const raw = Number(req.query.limit ?? 50);
  if (!Number.isFinite(raw) || raw <= 0) return 50;
  return Math.min(max, Math.floor(raw));
}

function clampIntervalSecs(req: Request): number {
  const raw = Number(req.query.interval ?? 900);
  if (!Number.isFinite(raw) || raw < 60) return 900;
  return Math.min(86_400, Math.floor(raw));
}

interface PriceCandle {
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  source: "redstone" | "admin" | "mixed";
}

function toCandles(rowsDesc: OraclePriceRow[], intervalSecs: number, limit: number): PriceCandle[] {
  const rows = [...rowsDesc].reverse();
  const buckets = new Map<number, PriceCandle>();

  for (const row of rows) {
    const time = Math.floor(row.writeTimestamp / intervalSecs) * intervalSecs;
    const existing = buckets.get(time);
    if (!existing) {
      buckets.set(time, {
        time,
        open: row.price,
        high: row.price,
        low: row.price,
        close: row.price,
        source: row.source,
      });
      continue;
    }
    if (BigInt(row.price) > BigInt(existing.high)) existing.high = row.price;
    if (BigInt(row.price) < BigInt(existing.low)) existing.low = row.price;
    existing.close = row.price;
    if (existing.source !== row.source) existing.source = "mixed";
  }

  return [...buckets.values()].slice(-limit);
}
