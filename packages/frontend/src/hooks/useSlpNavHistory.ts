/**
 * useSlpNavHistory — builds a rolling window of (timestamp, nav) points
 * by appending each `navPerShare` poll result as it arrives.
 *
 * Points are persisted to localStorage so the history survives page refreshes
 * and tab closes. The rolling window keeps up to MAX_POINTS entries and
 * discards anything older than TTL_MS (7 days).
 *
 * Returns up to MAX_POINTS data points, oldest first.
 */

import { useEffect, useRef, useState } from "react";
import { useSlpNavPerShare } from "./queries";

export interface NavPoint {
  /** Unix milliseconds */
  timestamp: number;
  /** 18-decimal NAV per share, stored as decimal string for JSON compat */
  nav: bigint;
}

const MAX_POINTS = 200;
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const LS_KEY = "stellax-nav-history";

// ── localStorage helpers (BigInt-safe) ───────────────────────────────────────

interface StoredPoint {
  timestamp: number;
  nav: string; // bigint as decimal string
}

function loadFromStorage(): NavPoint[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredPoint[];
    const cutoff = Date.now() - TTL_MS;
    return parsed
      .filter((p) => p.timestamp >= cutoff)
      .map((p) => ({ timestamp: p.timestamp, nav: BigInt(p.nav) }));
  } catch {
    return [];
  }
}

function saveToStorage(points: NavPoint[]): void {
  try {
    const stored: StoredPoint[] = points.map((p) => ({
      timestamp: p.timestamp,
      nav: p.nav.toString(),
    }));
    localStorage.setItem(LS_KEY, JSON.stringify(stored));
  } catch {
    // quota exceeded or private browsing — fail silently
  }
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useSlpNavHistory(): NavPoint[] {
  const navQ = useSlpNavPerShare();

  // Initialise from localStorage on first render
  const [history, setHistory] = useState<NavPoint[]>(() => loadFromStorage());
  const bufferRef = useRef<NavPoint[]>(history);

  useEffect(() => {
    if (navQ.data === undefined) return;

    const last = bufferRef.current[bufferRef.current.length - 1];
    // Only append when the value actually changes (or buffer is empty).
    if (last === undefined || last.nav !== navQ.data) {
      const cutoff = Date.now() - TTL_MS;
      const point: NavPoint = { timestamp: Date.now(), nav: navQ.data };
      const next = [...bufferRef.current, point]
        .filter((p) => p.timestamp >= cutoff)
        .slice(-MAX_POINTS);
      bufferRef.current = next;
      setHistory(next);
      saveToStorage(next);
    }
  }, [navQ.data]);

  return history;
}
