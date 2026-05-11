/**
 * Persistent position store (Zustand, persisted to localStorage).
 *
 * The on-chain perp contracts support only point lookups
 * (user + ID → record), not enumeration. Until a backend indexer exists,
 * we track IDs opened here and persist them to localStorage so positions
 * survive tab close, page refresh, and cross-tab navigation.
 *
 * BigInt values are round-tripped via `{ __bigint__: "<decimal string>" }`
 * because the JSON spec does not natively support BigInt.
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { Position } from "@stellax/sdk";

/** Perp position augmented with its on-chain ID (returned by openPosition). */
export interface SessionPosition extends Position {
  positionId: bigint;
}

/**
 * Record of a closed position captured from the on-chain `posclose` event
 * (user-initiated close) or `liq` event (keeper-initiated liquidation).
 * Stored for the lifetime of the browser tab; lost when the tab is closed.
 */
export interface ClosedTrade {
  positionId: bigint;
  marketId: number;
  isLong: boolean;
  leverage: number;
  /** Entry price, 18-decimal fixed-point (same as on-chain storage). */
  entryPrice: bigint;
  /** Position size, 18-decimal fixed-point. */
  size: bigint;
  /** Exit price decoded from the on-chain event (18-dp). */
  exitPrice: bigint;
  /** Net PnL after fee, decoded from the on-chain event (18-dp). Signed. */
  netPnl: bigint;
  /** Close fee / liquidation penalty paid, from the on-chain event (18-dp). */
  closeFee: bigint;
  /** Stellar transaction hash of the close / liquidation tx. */
  txHash: string;
  /** Unix timestamp (ms) when the close was confirmed. */
  closedAt: number;
  /**
   * "user" for voluntary closes (default); "liquidation" for keeper-triggered
   * liquidations detected via the `liq` event on the risk contract.
   */
  kind?: "user" | "liquidation";
  /**
   * Keeper reward portion of the liquidation penalty (18-dp).
   * Only set when kind === "liquidation".
   */
  keeperReward?: bigint;
  /**
   * Insurance fund portion of the liquidation penalty (18-dp).
   * Equal to keeperReward at the default 50/50 split.
   * Only set when kind === "liquidation".
   */
  insuranceDelta?: bigint;
}

interface SessionState {
  positions: SessionPosition[];
  closedTrades: ClosedTrade[];

  addPosition: (pos: SessionPosition) => void;
  removePosition: (positionId: bigint) => void;
  recordClose: (trade: ClosedTrade) => void;
}

// ── BigInt-safe JSON storage ──────────────────────────────────────────────────

/**
 * Custom replacer/reviver so BigInt values survive localStorage round-trips.
 * Encodes `bigint` as `{ "__bigint__": "<decimal>" }` and decodes back.
 */
const bigintStorage = createJSONStorage(() => localStorage, {
  replacer: (_key: string, value: unknown) =>
    typeof value === "bigint" ? { __bigint__: value.toString() } : value,
  reviver: (_key: string, value: unknown) => {
    if (
      value !== null &&
      typeof value === "object" &&
      "__bigint__" in (value as object)
    ) {
      return BigInt((value as { __bigint__: string }).__bigint__);
    }
    return value;
  },
});

// ── Store ────────────────────────────────────────────────────────────────────

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      positions: [],
      closedTrades: [],

      addPosition: (pos) =>
        set((s) => ({
          // Deduplicate by positionId
          positions: [
            ...s.positions.filter((p) => p.positionId !== pos.positionId),
            pos,
          ],
        })),

      removePosition: (positionId) =>
        set((s) => ({
          positions: s.positions.filter((p) => p.positionId !== positionId),
        })),

      recordClose: (trade) =>
        set((s) => ({
          // Prepend so newest trade appears first; deduplicate by positionId
          closedTrades: [
            trade,
            ...s.closedTrades.filter((t) => t.positionId !== trade.positionId),
          ],
        })),
    }),
    {
      name: "stellax-positions",
      storage: bigintStorage,
    },
  ),
);
