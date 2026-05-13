import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { PriceData } from "@stellax/sdk";
import { config } from "@/config";
import { qk } from "@/hooks/queries";

export interface OraclePriceEventRow {
  feed: string;
  price: string;
  packageTimestamp: string;
  writeTimestamp: number;
  source: "redstone" | "admin";
  txHash: string;
}

interface IndexerWsMessage {
  type?: string;
  data?: unknown;
}

const RWA_FEEDS = new Set(["BENJI", "USDY", "OUSG"]);

/**
 * Keeps oracle-backed frontend prices current with indexer WebSocket events.
 *
 * Polling in `usePrice()` remains the source-of-truth fallback. This hook only
 * removes the 5s polling delay when the indexer sees a `price_upd` or
 * `price_adm` event from the oracle.
 */
export function useOraclePriceEvents(): { connected: boolean } {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!config.indexer.enabled || config.indexer.url.length === 0) {
      setConnected(false);
      return;
    }

    const wsUrl = toWsUrl(config.indexer.url);
    let ws: WebSocket | null = null;
    let closed = false;
    let retryTimer: number | null = null;

    const reconnect = () => {
      if (closed) return;
      retryTimer = window.setTimeout(open, 2_000);
    };

    const open = () => {
      if (closed) return;
      try {
        ws = new WebSocket(wsUrl);
        ws.onopen = () => setConnected(true);
        ws.onmessage = (ev: MessageEvent<string>) => {
          try {
            const msg = JSON.parse(ev.data) as IndexerWsMessage;
            if (msg.type !== "oracle_price") return;
            const row = parseOraclePriceEvent(msg.data);
            if (row === null) return;

            const feed = row.feed.toUpperCase();
            const data: PriceData & { source: OraclePriceEventRow["source"]; txHash: string } = {
              price: BigInt(row.price),
              packageTimestamp: BigInt(row.packageTimestamp),
              writeTimestamp: BigInt(row.writeTimestamp),
              source: row.source,
              txHash: row.txHash,
            };

            qc.setQueryData(qk.price(feed), data);
            if (RWA_FEEDS.has(feed)) {
              void qc.invalidateQueries({ queryKey: qk.price(feed), exact: true });
              // Trigger immediate candle + ticker refetch so the chart updates on every keeper push
              void qc.invalidateQueries({ queryKey: ["indexer", "rwa-candles", feed] });
              void qc.invalidateQueries({ queryKey: ["indexer", "rwa-ticker24h", feed] });
            }
          } catch {
            // Ignore malformed websocket frames.
          }
        };
        ws.onclose = () => {
          setConnected(false);
          reconnect();
        };
        ws.onerror = () => ws?.close();
      } catch {
        setConnected(false);
        reconnect();
      }
    };

    open();

    // Cleanup: set `closed` before closing the socket so that the `onclose`
    // handler's reconnect() call is a no-op.  This makes the hook safe under
    // React Strict Mode (double-mount in dev): the first mount's cleanup
    // blocks its own reconnect before the second mount opens a fresh socket.
    return () => {
      closed = true;
      setConnected(false);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      ws?.close();
    };
  }, [qc]);

  return { connected };
}

function parseOraclePriceEvent(data: unknown): OraclePriceEventRow | null {
  if (data === null || typeof data !== "object") return null;
  const row = data as Partial<OraclePriceEventRow>;
  if (typeof row.feed !== "string") return null;
  if (typeof row.price !== "string") return null;
  if (typeof row.packageTimestamp !== "string") return null;
  if (typeof row.writeTimestamp !== "number") return null;
  if (row.source !== "redstone" && row.source !== "admin") return null;
  if (typeof row.txHash !== "string") return null;
  return {
    feed: row.feed,
    price: row.price,
    packageTimestamp: row.packageTimestamp,
    writeTimestamp: row.writeTimestamp,
    source: row.source,
    txHash: row.txHash,
  };
}

function toWsUrl(httpUrl: string): string {
  const trimmed = httpUrl.replace(/\/$/, "");
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice(8)}/ws`;
  if (trimmed.startsWith("http://")) return `ws://${trimmed.slice(7)}/ws`;
  return `${trimmed}/ws`;
}
