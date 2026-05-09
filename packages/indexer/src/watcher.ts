/**
 * watcher.ts — polls Soroban RPC for StellaX contract events and persists
 * them into the SQLite store. Also emits parsed events to a callback so the
 * API layer can forward them to WebSocket subscribers in real time.
 *
 * The watcher owns a single "next ledger to scan" cursor stored in the
 * `cursor` table, so restarts are resumable without double-counting.
 *
 * Event decoding
 * --------------
 * Soroban contract events are a topic tuple (`ScVal[]`) plus a data `ScVal`.
 * V2 contracts publish the following topics we care about:
 *
 *   perp-engine     symbol_short!("posopen",   user, position_id, market_id)
 *   perp-engine     symbol_short!("posclose",  user, position_id)
 *   perp-engine     symbol_short!("posmod",    user, position_id)
 *   risk            symbol_short!("liq",       user, position_id)
 *   bridge          symbol_short!("dep_in",    ...)
 *   bridge          symbol_short!("lock",      user, dest_chain, nonce)
 *   oracle          symbol_short!("price_upd", asset)   data=(price, package_timestamp_ms)
 *   oracle          symbol_short!("price_adm", asset)   data=(price, package_timestamp_ms)
 *   rwa-issuer      symbol_short!("mint"|"transfer"|"xfer_from"|"burn"|"yield_credit", ...)
 *                   → holder balance/yield snapshots for RWA yield drips
 */

import { rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { Logger } from "pino";
import { getLogger } from "./logger.js";
import type {
  IndexerStore,
  PositionRow,
  TradeRow,
  LiquidationRow,
  DepositRow,
  OrderRow,
  OraclePriceRow,
} from "./db.js";

export type RwaHolderEvent =
  | { feed: string; kind: "mint" | "burn" | "yield"; address: string; amount: string; ts: number }
  | { feed: string; kind: "transfer"; from: string; to: string; amount: string; ts: number };

export interface WatcherConfig {
  rpcUrl: string;
  contracts: {
    perpEngine: string;
    risk: string;
    bridge: string;
    clob: string;
    oracle: string;
    /** Map of RWA issuer contract id -> feed symbol, e.g. { C...: "BENJI" }. */
    rwaIssuers?: Record<string, string>;
  };
  /** If no cursor is stored, start N ledgers back from the latest. */
  initialLookbackLedgers: number;
  /** Max events to fetch per RPC round. */
  pageLimit: number;
}

/** Callback invoked for each decoded event (after it has been persisted). */
export type EventCallback = (ev: DecodedEvent) => void;

export type DecodedEvent =
  | { kind: "position_open";   row: PositionRow }
  | { kind: "position_close";  row: TradeRow }
  | { kind: "position_modify"; row: TradeRow }
  | { kind: "liquidation";     row: LiquidationRow }
  | { kind: "deposit";         row: DepositRow }
  | { kind: "order_place";     row: OrderRow }
  | { kind: "order_cancel";    orderId: string; ts: number }
  | { kind: "order_fill";      buyId: string; sellId: string; fillSize: string; ts: number }
  | { kind: "oracle_price";    row: OraclePriceRow }
  | { kind: "rwa_holder";      event: RwaHolderEvent };

const CURSOR_KEY = "watcher.next_ledger";

export class Watcher {
  private readonly log: Logger;
  private readonly server: rpc.Server;

  constructor(
    private readonly cfg: WatcherConfig,
    private readonly store: IndexerStore,
    private readonly onEvent: EventCallback,
  ) {
    this.log = getLogger("watcher");
    this.server = new rpc.Server(cfg.rpcUrl, { allowHttp: cfg.rpcUrl.startsWith("http://") });
  }

  /** Run a single poll. Intended to be called on an interval. */
  async tick(): Promise<void> {
    const startLedger = await this.resolveStartLedger();

    let cursor: string | undefined = undefined;
    let scanned = 0;
    let processed = 0;
    let lastLedger = startLedger;

    // Soroban RPC caps events-per-response and the ledger window, so we
    // iterate with `cursor` until the page is empty.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let resp: rpc.Api.GetEventsResponse;
      try {
        const req: rpc.Server.GetEventsRequest =
          cursor === undefined
            ? {
                startLedger,
                filters: contractFilters(this.cfg.contracts),
                limit: this.cfg.pageLimit,
              }
            : {
                cursor,
                filters: contractFilters(this.cfg.contracts),
                limit: this.cfg.pageLimit,
              };
        resp = await this.server.getEvents(req);
      } catch (err) {
        const recovered = this.recoverCursorFromRangeError(err);
        if (recovered) return;
        this.log.warn({ err: (err as Error).message }, "getEvents failed; retry next tick");
        return;
      }

      if (!resp.events || resp.events.length === 0) {
        if (resp.latestLedger) lastLedger = Math.max(lastLedger, resp.latestLedger);
        break;
      }

      for (const ev of resp.events) {
        scanned += 1;
        const decoded = this.decode(ev);
        if (decoded) {
          this.persist(decoded);
          this.onEvent(decoded);
          processed += 1;
        }
        if (ev.ledger) lastLedger = Math.max(lastLedger, ev.ledger);
      }

      if (resp.cursor && resp.events.length === this.cfg.pageLimit) {
        cursor = resp.cursor;
      } else {
        if (resp.latestLedger) lastLedger = Math.max(lastLedger, resp.latestLedger);
        break;
      }
    }

    // Advance cursor to lastLedger + 1 so next tick resumes just past the
    // most recent ledger we observed.
    this.store.setCursor(CURSOR_KEY, String(lastLedger + 1));
    this.log.debug({ scanned, processed, startLedger, nextLedger: lastLedger + 1 }, "watcher tick");
  }

  private async resolveStartLedger(): Promise<number> {
    const stored = this.store.getCursor(CURSOR_KEY);
    const latest = await this.server.getLatestLedger();
    const latestSequence = Number(
      (latest as { sequence?: number; latestLedger?: number }).sequence ??
      (latest as { sequence?: number; latestLedger?: number }).latestLedger ??
      0,
    );
    const minStart = Math.max(1, latestSequence - this.cfg.initialLookbackLedgers);
    if (stored !== null) {
      const storedLedger = Number(stored);
      if (Number.isFinite(storedLedger) && storedLedger >= minStart) {
        return storedLedger;
      }
      this.store.setCursor(CURSOR_KEY, String(minStart));
      this.log.warn(
        { storedLedger, minStart, latestLedger: latestSequence },
        "watcher cursor was outside RPC range; clamped to lookback window",
      );
      return minStart;
    }

    // First run: start N ledgers back from the latest.
    return minStart;
  }

  private recoverCursorFromRangeError(err: unknown): boolean {
    const message = (err as Error).message ?? String(err);
    const match = /ledger range:\s*(\d+)\s*-\s*(\d+)/i.exec(message);
    if (!match) return false;
    const minLedger = Number(match[1]);
    if (!Number.isFinite(minLedger) || minLedger <= 0) return false;
    this.store.setCursor(CURSOR_KEY, String(minLedger));
    this.log.warn({ minLedger }, "watcher cursor reset to RPC ledger range; retry next tick");
    return true;
  }

  // ── Decoding ───────────────────────────────────────────────────────────────

  private decode(raw: rpc.Api.EventResponse): DecodedEvent | null {
    // Topics are XDR ScVals; the first is a symbol tag.
    const topics = raw.topic.map((t: xdr.ScVal) => scValToNative(t));
    const tag = typeof topics[0] === "string" ? topics[0] : null;
    if (tag === null) return null;

    const data = scValToNative(raw.value);
    const ts = raw.ledgerClosedAt ? Math.floor(new Date(raw.ledgerClosedAt).getTime() / 1000) : 0;
    const txHash = raw.txHash ?? "";
    const contractId = String((raw as { contractId?: string }).contractId ?? "");
    const rwaFeed = this.cfg.contracts.rwaIssuers?.[contractId];

    try {
      if (rwaFeed) {
        const rwa = decodeRwaHolderEvent(rwaFeed, tag, topics, data, ts);
        if (rwa) return { kind: "rwa_holder", event: rwa };
      }
      switch (tag) {
        case "posopen":   return decodePosOpen(topics, data, ts, txHash);
        case "posclose":  return decodePosClose(topics, data, ts, txHash);
        case "posmod":    return decodePosMod(topics, data, ts, txHash);
        case "liq":       return decodeLiquidation(topics, data, ts, txHash);
        case "dep_in":    return decodeDepositIn(data, ts, txHash);
        case "lock":      return decodeLock(topics, data, ts, txHash);
        case "ordplace":  return decodeOrderPlace(topics, data, ts, txHash);
        case "ordcancel": return decodeOrderCancel(topics, ts);
        case "settled":   return decodeOrderSettle(topics, data, ts);
        case "price_upd": return decodeOraclePrice(topics, data, ts, txHash, "redstone");
        case "price_adm": return decodeOraclePrice(topics, data, ts, txHash, "admin");
        default: return null;
      }
    } catch (err) {
      this.log.warn({ tag, err: (err as Error).message }, "event decode failed");
      return null;
    }
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  private persist(ev: DecodedEvent): void {
    switch (ev.kind) {
      case "position_open":
        this.store.insertPosition(ev.row);
        this.store.insertTrade({
          user: ev.row.user,
          positionId: ev.row.positionId,
          marketId: ev.row.marketId,
          kind: "open",
          size: ev.row.size,
          price: ev.row.entryPrice,
          pnl: null,
          isLong: ev.row.isLong,
          ts: ev.row.openedAt,
          txHash: ev.row.openTxHash,
        });
        break;
      case "position_close":
        this.store.deletePosition(ev.row.positionId);
        this.store.insertTrade(ev.row);
        break;
      case "position_modify":
        this.store.insertTrade(ev.row);
        break;
      case "liquidation":
        this.store.deletePosition(ev.row.positionId);
        this.store.insertLiquidation(ev.row);
        break;
      case "deposit":
        this.store.insertDeposit(ev.row);
        break;
      case "order_place":
        this.store.insertOrder(ev.row);
        break;
      case "order_cancel":
        this.store.cancelOrder(ev.orderId, ev.ts);
        break;
      case "order_fill":
        // The `settled` event only identifies the two order ids. Apply the
        // fill to both sides; fillOrder() is a no-op if the order isn't in
        // our table (e.g. placed before the indexer was started).
        this.store.fillOrder(ev.buyId, BigInt(ev.fillSize), ev.ts);
        this.store.fillOrder(ev.sellId, BigInt(ev.fillSize), ev.ts);
        break;
      case "oracle_price":
        this.store.insertOraclePrice(ev.row);
        break;
      case "rwa_holder":
        if (ev.event.kind === "transfer") {
          this.store.applyRwaTransfer(ev.event.feed, ev.event.from, ev.event.to, ev.event.amount, ev.event.ts);
        } else if (ev.event.kind === "mint") {
          this.store.applyRwaMint(ev.event.feed, ev.event.address, ev.event.amount, ev.event.ts);
        } else if (ev.event.kind === "burn") {
          this.store.applyRwaBurn(ev.event.feed, ev.event.address, ev.event.amount, ev.event.ts);
        } else {
          this.store.applyRwaYield(ev.event.feed, ev.event.address, ev.event.amount, ev.event.ts);
        }
        break;
    }
  }
}

function contractFilters(contracts: WatcherConfig["contracts"]): rpc.Server.GetEventsRequest["filters"] {
  const ids = [
    contracts.perpEngine,
    contracts.risk,
    contracts.bridge,
    contracts.clob,
    contracts.oracle,
    ...Object.keys(contracts.rwaIssuers ?? {}),
  ].filter((c) => c.length > 0);
  const filters: rpc.Server.GetEventsRequest["filters"] = [];
  for (let i = 0; i < ids.length; i += 5) {
    filters.push({ type: "contract", contractIds: ids.slice(i, i + 5) });
  }
  return filters;
}

// ── Per-topic decoders ───────────────────────────────────────────────────────
//
// `topics[0]` is the symbol tag; indices here start from topics[1].
// `data` is whatever the contract published as the event body.

function decodePosOpen(
  topics: unknown[],
  data: unknown,
  ts: number,
  txHash: string,
): DecodedEvent {
  // topics: (symbol, user: Address, position_id: u64, market_id: u32)
  // data:   (size: i128, execution_price: i128, leverage: u32, is_long: bool)
  const user = String(topics[1]);
  const positionId = toStr(topics[2]);
  const marketId = Number(topics[3] ?? 0);
  const [size, price, leverage, isLong] = data as [unknown, unknown, unknown, unknown];

  const row: PositionRow = {
    positionId,
    user,
    marketId,
    isLong: isLong ? 1 : 0,
    size: toStr(size),
    entryPrice: toStr(price),
    leverage: Number(leverage),
    openedAt: ts,
    openTxHash: txHash,
  };
  return { kind: "position_open", row };
}

function decodePosClose(
  topics: unknown[],
  data: unknown,
  ts: number,
  txHash: string,
): DecodedEvent {
  // topics: (symbol, user, position_id)
  // data:   (execution_price: i128, total_pnl: i128)
  const user = String(topics[1]);
  const positionId = toStr(topics[2]);
  const [price, pnl] = data as [unknown, unknown];

  const row: TradeRow = {
    user,
    positionId,
    marketId: 0,           // not available on the close topic; join on positions if needed
    kind: "close",
    size: "0",
    price: toStr(price),
    pnl: toStr(pnl),
    isLong: 0,
    ts,
    txHash,
  };
  return { kind: "position_close", row };
}

function decodePosMod(
  topics: unknown[],
  data: unknown,
  ts: number,
  txHash: string,
): DecodedEvent {
  const user = String(topics[1]);
  const positionId = toStr(topics[2]);
  const row: TradeRow = {
    user,
    positionId,
    marketId: 0,
    kind: "modify",
    size: "0",
    price: toStr((data as unknown[] | undefined)?.[0] ?? 0n),
    pnl: null,
    isLong: 0,
    ts,
    txHash,
  };
  return { kind: "position_modify", row };
}

function decodeLiquidation(
  topics: unknown[],
  data: unknown,
  ts: number,
  txHash: string,
): DecodedEvent {
  // topics: (symbol, user, position_id)
  // data:   (oracle_price, remaining_margin, keeper_reward)
  const user = String(topics[1]);
  const positionId = toStr(topics[2]);
  const [oraclePrice, remainingMargin, keeperReward] = data as [unknown, unknown, unknown];

  const row: LiquidationRow = {
    user,
    positionId,
    oraclePrice: toStr(oraclePrice),
    remainingMargin: toStr(remainingMargin),
    keeperReward: toStr(keeperReward),
    ts,
    txHash,
  };
  return { kind: "liquidation", row };
}

function decodeOraclePrice(
  topics: unknown[],
  data: unknown,
  ts: number,
  txHash: string,
  source: OraclePriceRow["source"],
): DecodedEvent {
  // topics: (symbol, feed: Symbol)
  // data:   (price: i128, package_timestamp_ms: u64)
  const feed = String(topics[1] ?? "").toUpperCase();
  const [price, packageTimestamp] = data as [unknown, unknown];
  return {
    kind: "oracle_price",
    row: {
      feed,
      price: toStr(price),
      packageTimestamp: toStr(packageTimestamp),
      writeTimestamp: ts,
      source,
      txHash,
    },
  };
}

function decodeDepositIn(data: unknown, ts: number, txHash: string): DecodedEvent {
  // bridge `dep_in` payload: (user, amount) or similar tuple
  const tuple = Array.isArray(data) ? (data as unknown[]) : [data, 0n];
  const user = String(tuple[0] ?? "");
  const amount = toStr(tuple[1] ?? 0n);
  const row: DepositRow = {
    direction: "in",
    user,
    amount,
    destChain: null,
    ts,
    txHash,
  };
  return { kind: "deposit", row };
}

function decodeLock(
  _topics: unknown[],
  data: unknown,
  ts: number,
  txHash: string,
): DecodedEvent {
  // bridge outbound `lock` — emit as "out" deposit
  const tuple = Array.isArray(data) ? (data as unknown[]) : [data];
  const user = String(tuple[0] ?? "");
  const amount = toStr(tuple[1] ?? 0n);
  const destChain = typeof tuple[2] === "string" ? (tuple[2] as string) : null;
  const row: DepositRow = {
    direction: "out",
    user,
    amount,
    destChain,
    ts,
    txHash,
  };
  return { kind: "deposit", row };
}

function decodeRwaHolderEvent(
  feed: string,
  tag: string,
  topics: unknown[],
  data: unknown,
  ts: number,
): RwaHolderEvent | null {
  const payload = Array.isArray(data) ? (data as unknown[]) : [data];
  const amount = toStr(payload[0] ?? 0n);
  switch (tag) {
    case "mint":
      return { feed, kind: "mint", address: String(topics[1] ?? ""), amount, ts };
    case "burn":
      return { feed, kind: "burn", address: String(topics[1] ?? ""), amount, ts };
    case "burn_from":
      return { feed, kind: "burn", address: String(topics[1] ?? ""), amount, ts };
    case "transfer":
      return {
        feed,
        kind: "transfer",
        from: String(topics[1] ?? ""),
        to: String(topics[2] ?? ""),
        amount,
        ts,
      };
    case "xfer_from":
      return {
        feed,
        kind: "transfer",
        from: String(topics[1] ?? ""),
        to: String(topics[2] ?? ""),
        amount,
        ts,
      };
    case "yield_credit":
      return { feed, kind: "yield", address: String(topics[1] ?? ""), amount, ts };
    default:
      return null;
  }
}

// CLOB decoders -------------------------------------------------------------

function decodeOrderPlace(
  topics: unknown[],
  data: unknown,
  ts: number,
  txHash: string,
): DecodedEvent {
  // topics: (symbol, trader, order_id)
  // data:   (market_id, size, price, is_long)
  const trader = String(topics[1] ?? "");
  const orderId = toStr(topics[2] ?? 0n);
  const tuple = Array.isArray(data) ? (data as unknown[]) : [];
  const marketId = Number(tuple[0] ?? 0);
  const size = toStr(tuple[1] ?? 0n);
  const price = toStr(tuple[2] ?? 0n);
  const isLong = tuple[3] ? 1 : 0;

  const row: OrderRow = {
    orderId,
    trader,
    marketId,
    isLong: isLong === 1 ? 1 : 0,
    price,
    size,
    filledSize: "0",
    status: "open",
    placedAt: ts,
    updatedAt: ts,
    placeTxHash: txHash,
  };
  return { kind: "order_place", row };
}

function decodeOrderCancel(topics: unknown[], ts: number): DecodedEvent {
  // topics: (symbol, caller, order_id)
  const orderId = toStr(topics[2] ?? 0n);
  return { kind: "order_cancel", orderId, ts };
}

function decodeOrderSettle(topics: unknown[], data: unknown, ts: number): DecodedEvent {
  // topics: (symbol, buy_id, sell_id)
  // data:   (fill_size, fill_price, market_id)
  const buyId = toStr(topics[1] ?? 0n);
  const sellId = toStr(topics[2] ?? 0n);
  const tuple = Array.isArray(data) ? (data as unknown[]) : [];
  const fillSize = toStr(tuple[0] ?? 0n);
  return { kind: "order_fill", buyId, sellId, fillSize, ts };
}

// ── Utils ────────────────────────────────────────────────────────────────────

function toStr(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  if (v == null) return "0";
  return String(v);
}
