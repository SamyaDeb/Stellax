/**
 * usePositions — React hook that returns the user's open perp positions,
 * sourced from the StellaX event indexer (`packages/indexer`) when available
 * and falling back to the in-browser session store otherwise.
 *
 * Behaviour
 * ---------
 *   1. On mount, fetches `GET {indexer}/positions?user=<address>`.
 *   2. Opens a WebSocket to `{indexer}/ws` and sends `{ subscribe: <address> }`.
 *      Position-change events (`position_open`, `position_close`,
 *      `liquidation`) refetch the REST list so the returned array stays in
 *      sync without needing to reimplement every event merge client-side.
 *   3. If the indexer URL is unreachable or `config.indexer.enabled` is false,
 *      the hook surfaces the session store's positions so the UI still works.
 *
 * The returned value is a list of `SessionPosition`-shaped records so existing
 * callers (`PositionsTable`, `TradePage`) require no other changes.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { config } from "@/config";
import { useSessionStore, type SessionPosition } from "@/stores/sessionStore";

interface IndexerPositionRow {
  positionId: string;
  user: string;
  marketId: number;
  isLong: 0 | 1;
  size: string;         // i128 decimal
  entryPrice: string;   // i128 decimal (7dp)
  leverage: number;     // leverage multiplier (e.g. 5 for 5×)
  openedAt: number;
  openTxHash: string;
}

/**
 * Shape returned to callers. Matches `SessionPosition` so existing table
 * components keep working.
 *
 * When data comes from the indexer, fields the indexer does not publish
 * (e.g. liquidation price, funding index snapshot) default to `0n`. Full
 * on-chain detail can be refetched via the perp-engine client when a row
 * is selected.
 */
export type DisplayPosition = SessionPosition;

interface UsePositionsResult {
  positions: DisplayPosition[];
  /** "indexer" when live data is flowing, "session" when using fallback. */
  source: "indexer" | "session";
  /** True while the first REST fetch is in flight. */
  loading: boolean;
}

export function usePositions(address: string | null): UsePositionsResult {
  const sessionPositions = useSessionStore((s) => s.positions);
  const [indexerRows, setIndexerRows] = useState<IndexerPositionRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const refetchTimerRef = useRef<number | null>(null);

  const indexerEnabled = config.indexer.enabled && config.indexer.url.length > 0;

  // ── REST refresher ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!indexerEnabled || address === null) {
      setIndexerRows(null);
      return;
    }
    let cancelled = false;
    const fetchRows = async () => {
      setLoading(true);
      try {
        const url = `${config.indexer.url.replace(/\/$/, "")}/positions?user=${encodeURIComponent(address)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`indexer ${res.status}`);
        const rows = (await res.json()) as IndexerPositionRow[];
        if (!cancelled) setIndexerRows(rows);
      } catch {
        if (!cancelled) setIndexerRows(null); // triggers session fallback
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void fetchRows();

    // Attach refetch handle for WS callbacks below.
    refetchTimerRef.current = window.setInterval(() => void fetchRows(), 30_000);
    return () => {
      cancelled = true;
      if (refetchTimerRef.current !== null) {
        window.clearInterval(refetchTimerRef.current);
        refetchTimerRef.current = null;
      }
    };
  }, [address, indexerEnabled]);

  // ── WebSocket live updates ─────────────────────────────────────────────────
  useEffect(() => {
    if (!indexerEnabled || address === null) {
      setConnected(false);
      return;
    }
    const url = toWsUrl(config.indexer.url);
    let ws: WebSocket | null = null;
    let closed = false;

    const open = () => {
      if (closed) return;
      try {
        ws = new WebSocket(url);
        wsRef.current = ws;
        ws.onopen = () => {
          setConnected(true);
          ws?.send(JSON.stringify({ subscribe: address }));
        };
        ws.onmessage = (ev: MessageEvent<string>) => {
          try {
            const msg = JSON.parse(ev.data) as { type?: string };
            if (
              msg.type === "position_open" ||
              msg.type === "position_close" ||
              msg.type === "liquidation"
            ) {
              // Trigger a REST refetch rather than reimplementing state merges.
              void refetchFromIndexer(address).then((rows) => {
                if (rows !== null) setIndexerRows(rows);
              });
            }
          } catch {
            // ignore malformed frames
          }
        };
        ws.onclose = () => {
          setConnected(false);
          if (!closed) {
            // Reconnect with backoff
            window.setTimeout(open, 2_000);
          }
        };
        ws.onerror = () => {
          ws?.close();
        };
      } catch {
        // socket construction failed; fall back silently
      }
    };
    open();

    return () => {
      closed = true;
      setConnected(false);
      ws?.close();
      wsRef.current = null;
    };
  }, [address, indexerEnabled]);

  // ── Output ─────────────────────────────────────────────────────────────────
  const positions = useMemo<DisplayPosition[]>(() => {
    if (indexerRows !== null && indexerRows.length > 0) {
      // Merge: start with indexed rows, then append any session positions that
      // the indexer doesn't know about yet (e.g. just-opened, not yet indexed).
      const indexedIds = new Set(indexerRows.map((r) => BigInt(r.positionId)));
      const pendingSession = sessionPositions.filter(
        (p) => !indexedIds.has(p.positionId),
      );
      return [...indexerRows.map(rowToSessionPosition), ...pendingSession];
    }
    // Indexer returned nothing (unreachable or empty) — use session store.
    return sessionPositions;
  }, [indexerRows, sessionPositions]);

  const source: "indexer" | "session" =
    indexerRows !== null && indexerRows.length > 0 && (connected || !loading)
      ? "indexer"
      : "session";

  return { positions, source, loading };
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function refetchFromIndexer(
  address: string,
): Promise<IndexerPositionRow[] | null> {
  try {
    const url = `${config.indexer.url.replace(/\/$/, "")}/positions?user=${encodeURIComponent(address)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as IndexerPositionRow[];
  } catch {
    return null;
  }
}

function toWsUrl(httpUrl: string): string {
  const trimmed = httpUrl.replace(/\/$/, "");
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice(8)}/ws`;
  if (trimmed.startsWith("http://"))  return `ws://${trimmed.slice(7)}/ws`;
  return `${trimmed}/ws`;
}

/**
 * Adapts an indexer row to the `SessionPosition` shape expected by the UI.
 *
 * Fields absent from the indexer event (funding snapshot, liquidation price,
 * realized pnl at open) default to `0n`. The `PositionsTable` already
 * recomputes unrealized PnL and liq price client-side from the oracle price
 * plus `entry_price` and `size`, so the rendered view is accurate.
 */
function rowToSessionPosition(r: IndexerPositionRow): SessionPosition {
  const sizeBase = BigInt(r.size);
  const entryPrice = BigInt(r.entryPrice);
  // Convert base-asset size → USD notional (18-dec) so formatUsd and the
  // PnL formula in PositionsTable work correctly:
  //   notional = sizeBase * entryPrice / 1e18
  const PRECISION = 10n ** 18n;
  const sizeUsd = entryPrice > 0n ? (sizeBase * entryPrice) / PRECISION : sizeBase;
  // Derive margin from notional / leverage so ROE in PositionsTable is correct
  // (the indexer doesn't store margin separately).
  const lev = BigInt(r.leverage > 0 ? r.leverage : 1);
  const margin = sizeUsd / lev;
  return {
    positionId: BigInt(r.positionId),
    owner: r.user,
    marketId: r.marketId,
    isLong: r.isLong === 1,
    size: sizeUsd,
    entryPrice,
    leverage: r.leverage,
    margin,
    lastFundingIdx: 0n,
    openTimestamp: BigInt(r.openedAt),
  };
}
