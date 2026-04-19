/**
 * Wallet connection store (Zustand).
 *
 * Holds Freighter connection state, the connected G-address, and
 * current network passphrase. Persists nothing — Freighter is the
 * source of truth; we mirror here for cheap reactive reads.
 */

import { create } from "zustand";

export type WalletStatus = "disconnected" | "connecting" | "connected" | "error";

interface WalletState {
  status: WalletStatus;
  address: string | null;
  networkPassphrase: string | null;
  error: string | null;
  set: (patch: Partial<WalletState>) => void;
  reset: () => void;
}

export const useWalletStore = create<WalletState>((set) => ({
  status: "disconnected",
  address: null,
  networkPassphrase: null,
  error: null,
  set: (patch) => set(patch),
  reset: () =>
    set({
      status: "disconnected",
      address: null,
      networkPassphrase: null,
      error: null,
    }),
}));
