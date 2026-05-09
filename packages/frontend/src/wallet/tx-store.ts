/**
 * Transaction status store. Each call to `track()` produces a toast-like
 * entry in the global feed which surfaces through the `<Toasts>` component.
 */

import { create } from "zustand";

export type TxPhase = "pending" | "success" | "failed";

export interface TxAction {
  label: string;
  href: string;
}

export interface TxEntry {
  id: string;
  label: string;
  phase: TxPhase;
  hash?: string;
  message?: string;
  action?: TxAction;
  createdAt: number;
}

interface TxState {
  entries: TxEntry[];
  push: (entry: Omit<TxEntry, "createdAt">) => void;
  update: (id: string, patch: Partial<Omit<TxEntry, "id">>) => void;
  dismiss: (id: string) => void;
  clear: () => void;
}

export const useTxStore = create<TxState>((set) => ({
  entries: [],
  push: (entry) =>
    set((s) => ({
      entries: [...s.entries, { ...entry, createdAt: Date.now() }],
    })),
  update: (id, patch) =>
    set((s) => ({
      entries: s.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    })),
  dismiss: (id) =>
    set((s) => ({ entries: s.entries.filter((e) => e.id !== id) })),
  clear: () => set({ entries: [] }),
}));

let _counter = 0;
export function nextTxId(): string {
  _counter += 1;
  return `tx-${Date.now()}-${_counter}`;
}
