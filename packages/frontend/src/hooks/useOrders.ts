/**
 * useOrders — React hook returning live CLOB limit-order state from the
 * StellaX indexer (`packages/indexer`).
 *
 * Two modes:
 *   useOrders({ marketId })        — all open orders for the market (order book)
 *   useOrders({ trader })          — orders for a specific trader (user panel)
 *
 * Behaviour mirrors `usePositions`:
 *   1. Initial REST fetch from `GET /orders`.
 *   2. WebSocket on `/ws` — any `order_place | order_cancel | order_fill`
 *      message triggers a REST refetch.
 *   3. Silent fallback to empty array if the indexer is unreachable.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { config } from "@/config";

export interface IndexerOrderRow {
  orderId: string;
  trader: string;
  marketId: number;
  isLong: 0 | 1;
  /** 18-dec limit price. */
  price: string;
  /** 18-dec requested size (base units). */
  size: string;
  /** 18-dec filled size. */
  filledSize: string;
  status: "open" | "filled" | "cancelled";
  placedAt: number;
  updatedAt: number;
  placeTxHash: string;
}

export interface UseOrdersOptions {
  /** Fetch open orders for this market. Ignored when `trader` is set. */
  marketId?: number | null;
  /** Fetch all orders placed by this trader. */
  trader?: string | null;
  /** When `trader` is set, filter by status. Defaults to "open". */
  status?: "open" | "filled" | "cancelled" | "all";
}

interface UseOrdersResult {
  orders: IndexerOrderRow[];
  loading: boolean;
  /** True when WebSocket is connected. */
  connected: boolean;
}

export function useOrders(opts: UseOrdersOptions): UseOrdersResult {
  const { marketId = null, trader = null, status = "open" } = opts;
  const [rows, setRows] = useState<IndexerOrderRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const refetchTimerRef = useRef<number | null>(null);

  const indexerEnabled = config.indexer.enabled && config.indexer.url.length > 0;

  const queryUrl = useMemo(() => {
    if (!indexerEnabled) return null;
    const base = config.indexer.url.replace(/\/$/, "");
    const params = new URLSearchParams();
    if (trader !== null && trader.length > 0) {
      params.set("user", trader);
      if (status !== "all") params.set("status", status);
    } else if (marketId !== null) {
      params.set("marketId", String(marketId));
    } else {
      return null;
    }
    return `${base}/orders?${params.toString()}`;
  }, [indexerEnabled, marketId, trader, status]);

  // ── REST fetch ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (queryUrl === null) {
      setRows([]);
      return;
    }
    let cancelled = false;
    const fetchRows = async () => {
      setLoading(true);
      try {
        const res = await fetch(queryUrl);
        if (!res.ok) throw new Error(`indexer ${res.status}`);
        const data = (await res.json()) as IndexerOrderRow[];
        if (!cancelled) setRows(data);
      } catch {
        if (!cancelled) setRows([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void fetchRows();

    refetchTimerRef.current = window.setInterval(() => void fetchRows(), 15_000);
    return () => {
      cancelled = true;
      if (refetchTimerRef.current !== null) {
        window.clearInterval(refetchTimerRef.current);
        refetchTimerRef.current = null;
      }
    };
  }, [queryUrl]);

  // ── WebSocket live updates ─────────────────────────────────────────────────
  useEffect(() => {
    if (queryUrl === null) {
      setConnected(false);
      return;
    }
    const wsUrl = toWsUrl(config.indexer.url);
    let ws: WebSocket | null = null;
    let closed = false;

    const open = () => {
      if (closed) return;
      try {
        ws = new WebSocket(wsUrl);
        ws.onopen = () => {
          setConnected(true);
          // When scoped to a single trader, request a filtered stream.
          if (trader !== null && trader.length > 0) {
            ws?.send(JSON.stringify({ subscribe: trader }));
          }
        };
        ws.onmessage = (ev: MessageEvent<string>) => {
          try {
            const msg = JSON.parse(ev.data) as { type?: string };
            if (
              msg.type === "order_place" ||
              msg.type === "order_cancel" ||
              msg.type === "order_fill"
            ) {
              void fetch(queryUrl)
                .then((r) => (r.ok ? r.json() : []))
                .then((data) => setRows(data as IndexerOrderRow[]))
                .catch(() => { /* ignore */ });
            }
          } catch {
            // ignore malformed frames
          }
        };
        ws.onclose = () => {
          setConnected(false);
          if (!closed) window.setTimeout(open, 2_000);
        };
        ws.onerror = () => ws?.close();
      } catch {
        // socket construction failed; silent fallback
      }
    };
    open();

    return () => {
      closed = true;
      setConnected(false);
      ws?.close();
    };
  }, [queryUrl, trader]);

  return { orders: rows, loading, connected };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function toWsUrl(httpUrl: string): string {
  const trimmed = httpUrl.replace(/\/$/, "");
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice(8)}/ws`;
  if (trimmed.startsWith("http://"))  return `ws://${trimmed.slice(7)}/ws`;
  return `${trimmed}/ws`;
}
