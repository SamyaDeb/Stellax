/**
 * React context that bootstraps the wallet connection and keeps
 * the store in sync with Freighter. Children call `useWallet()`.
 */

import { createContext, useCallback, useContext, useEffect, type ReactNode } from "react";
import { useWalletStore } from "./store";
import { connectWallet, refreshWallet } from "./freighter";

interface WalletContextValue {
  status: ReturnType<typeof useWalletStore.getState>["status"];
  address: string | null;
  networkPassphrase: string | null;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
}

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const state = useWalletStore();

  const connect = useCallback(async () => {
    state.set({ status: "connecting", error: null });
    try {
      const w = await connectWallet();
      state.set({
        status: "connected",
        address: w.address,
        networkPassphrase: w.networkPassphrase,
        error: null,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      state.set({ status: "error", error: msg });
    }
    // intentionally omit `state` from deps — Zustand store is stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const disconnect = useCallback(() => {
    state.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Best-effort auto-reconnect on mount if user previously granted access.
  useEffect(() => {
    (async () => {
      const w = await refreshWallet();
      if (w) {
        state.set({
          status: "connected",
          address: w.address,
          networkPassphrase: w.networkPassphrase,
          error: null,
        });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value: WalletContextValue = {
    status: state.status,
    address: state.address,
    networkPassphrase: state.networkPassphrase,
    error: state.error,
    connect,
    disconnect,
  };

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (ctx === null) {
    throw new Error("useWallet must be used within <WalletProvider>");
  }
  return ctx;
}
