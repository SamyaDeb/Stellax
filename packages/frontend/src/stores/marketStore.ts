/**
 * Persists the user's selected market ID across React Router navigations
 * and page refreshes (within the same tab).
 *
 * The TradePage reads the stored ID as its initial `selectedId` state so the
 * user does not have to re-select their market after navigating away and back.
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

interface MarketState {
  selectedMarketId: number | null;
  setSelectedMarketId: (id: number | null) => void;
}

export const useMarketStore = create<MarketState>()(
  persist(
    (set) => ({
      selectedMarketId: null,
      setSelectedMarketId: (id) => set({ selectedMarketId: id }),
    }),
    {
      name: "stellax-market",
      storage: createJSONStorage(() => sessionStorage),
    },
  ),
);
