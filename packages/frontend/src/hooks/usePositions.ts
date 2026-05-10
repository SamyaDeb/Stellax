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
 *      the hook tries `perpEngine.getUserPositions(user)` as an on-chain
 *      fallback. If that also returns nothing, the session store is used.
 *
 * Source discrimination:
 *   - "indexer"  — indexer responded 200 (even with empty []).
 *   - "chain"    — indexer unreachable; data from perpEngine.getUserPositions.
 *   - "session"  — indexer AND on-chain both unavailable; session store only.
 *
 * The returned value is a list of `SessionPosition`-shaped records so existing
 * callers (`PositionsTable`, `TradePage`) require no other changes.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { config, hasContract } from "@/config";
import { useSessionStore, type SessionPosition } from "@/stores/sessionStore";
import { getClients } from "@/stellar/clients";

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
  /**
   * Data origin:
   *   "indexer"  — indexer reachable (may be empty)
   *   "chain"    — indexer down; data from perpEngine.getUserPositions
   *   "session"  — both indexer and on-chain unavailable; session store
   */
  source: "indexer" | "chain" | "session";
  /** True while the first REST fetch is in flight. */
  loading: boolean;
  /**
   * True only when the indexer is confirmed unreachable (HTTP error / network
   * failure). False when the indexer returns 200 + empty array.
   */
  indexerOffline: boolean;
}

export function usePositions(address: string | null): UsePositionsResult {
  const sessionPositions = useSessionStore((s) => s.positions);
  // null  → initial state (no attempt yet / not applicable)
  // []    → indexer reachable but returned empty
  // [...]  → indexer reachable with rows
  const [indexerRows, setIndexerRows] = useState<IndexerPositionRow[] | null>(null);
  /** True only when the indexer request failed (not when it returned []). */
  const [indexerOffline, setIndexerOffline] = useState(false);
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false);

  // On-chain fallback rows (from perpEngine.getUserPositions).
  const [chainRows, setChainRows] = useState<SessionPosition[] | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const refetchTimerRef = useRef<number | null>(null);

  const indexerEnabled = config.indexer.enabled && config.indexer.url.length > 0;

  // ── REST refresher ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!indexerEnabled || address === null) {
      setIndexerRows(null);
      setIndexerOffline(false);
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
        if (!cancelled) {
          // Indexer reachable — even an empty array is a valid "online" response.
          setIndexerRows(rows);
          setIndexerOffline(false);
          setChainRows(null); // clear stale on-chain cache
        }
      } catch {
        if (!cancelled) {
          setIndexerRows(null);
          setIndexerOffline(true);
          // Try the on-chain fallback.
          void fetchOnChainFallback(address).then((rows) => {
            if (!cancelled) setChainRows(rows);
          });
        }
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
                if (rows !== null) {
                  setIndexerRows(rows);
                  setIndexerOffline(false);
                }
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
    if (indexerRows !== null) {
      // Indexer is reachable. Merge indexed rows with any pending session positions.
      const indexedIds = new Set(indexerRows.map((r) => BigInt(r.positionId)));
      const pendingSession = sessionPositions.filter(
        (p) => !indexedIds.has(p.positionId),
      );
      return [...indexerRows.map(rowToSessionPosition), ...pendingSession];
    }
    // Indexer offline — try on-chain rows, then session.
    if (chainRows !== null && chainRows.length > 0) {
      const chainIds = new Set(chainRows.map((r) => r.positionId));
      const pendingSession = sessionPositions.filter(
        (p) => !chainIds.has(p.positionId),
      );
      return [...chainRows, ...pendingSession];
    }
    // Final fallback: session store only.
    return sessionPositions;
  }, [indexerRows, chainRows, sessionPositions]);

  const source: "indexer" | "chain" | "session" = useMemo(() => {
    if (indexerRows !== null && (connected || !loading)) return "indexer";
    if (chainRows !== null && chainRows.length > 0) return "chain";
    return "session";
  }, [indexerRows, chainRows, connected, loading]);

  return { positions, source, loading, indexerOffline };
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

/**
 * On-chain position enumeration via `perpEngine.getUserPositions`.
 * Currently a stub (returns []) until the contract supports enumeration.
 * Wired here so it activates automatically when the SDK is upgraded.
 */
async function fetchOnChainFallback(
  address: string,
): Promise<SessionPosition[]> {
  try {
    if (!hasContract(config.contracts.perpEngine)) return [];
    const positions = await getClients().perpEngine.getUserPositions(address);
    return positions.map((p, i) => ({
      // getUserPositions doesn't return IDs; use a synthetic negative ID so
      // it never collides with real session-store IDs (which are on-chain u64).
      positionId: BigInt(-(i + 1)),
      owner: address,
      marketId: p.marketId,
      isLong: p.isLong,
      size: p.size,
      entryPrice: p.entryPrice,
      leverage: p.leverage,
      margin: p.margin,
      lastFundingIdx: p.lastFundingIdx,
      openTimestamp: p.openTimestamp,
    }));
  } catch {
    return [];
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
