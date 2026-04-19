/**
 * Session-local position and option store (Zustand, in-memory only).
 *
 * The on-chain perp/options contracts support only point lookups
 * (user + ID → record), not enumeration. Until a backend indexer exists,
 * we track IDs opened/written in the current browser session here.
 *
 * On page refresh the store resets — positions/options are not lost on-chain,
 * they just won't appear in the UI until an indexer is available.
 */

import { create } from "zustand";
import type { Position } from "@stellax/sdk";

/** Perp position augmented with its on-chain ID (returned by openPosition). */
export interface SessionPosition extends Position {
  positionId: bigint;
}

/** Minimal record of an option opened/bought this session. */
export interface SessionOption {
  optionId: bigint;
  role: "writer" | "holder";
  /** Asset symbol, e.g. "XLM". Stored so ActionCell can resolve spot price. */
  underlying: string;
}

interface SessionState {
  positions: SessionPosition[];
  options: SessionOption[];

  addPosition: (pos: SessionPosition) => void;
  removePosition: (positionId: bigint) => void;

  addOption: (opt: SessionOption) => void;
  removeOption: (optionId: bigint) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  positions: [],
  options: [],

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

  addOption: (opt) =>
    set((s) => ({
      options: [
        ...s.options.filter((o) => o.optionId !== opt.optionId),
        opt,
      ],
    })),

  removeOption: (optionId) =>
    set((s) => ({
      options: s.options.filter((o) => o.optionId !== optionId),
    })),
}));
