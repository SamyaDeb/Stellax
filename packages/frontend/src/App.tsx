import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WalletProvider } from "./wallet";
import { Layout } from "./ui/Layout";
import { LandingPage } from "./pages/LandingPage";
import { TradePage } from "./pages/TradePage";
import { VaultsPage } from "./pages/VaultsPage";
import { BridgePage } from "./pages/BridgePage";
import { DashboardPage } from "./pages/DashboardPage";
import { GovernancePage } from "./pages/GovernancePage";
import { StakingPage } from "./pages/StakingPage";
import { DepositPage } from "./pages/DepositPage";
import { useOraclePriceEvents } from "./hooks/useOraclePriceEvents";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: true,
      staleTime: 5_000,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <OraclePriceEventBridge />
      <WalletProvider>
        <BrowserRouter>
          <Routes>
            {/* Landing page — standalone, no app Layout */}
            <Route index element={<LandingPage />} />

            {/* App pages — inside the app Layout with app navbar */}
            <Route element={<Layout />}>
              <Route path="/trade" element={<TradePage />} />
              <Route path="/vaults" element={<VaultsPage />} />
              <Route path="/bridge" element={<BridgePage />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/governance" element={<GovernancePage />} />
              <Route path="/staking" element={<StakingPage />} />
              <Route path="/deposit" element={<DepositPage />} />
              <Route path="*" element={<Navigate to="/trade" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </WalletProvider>
    </QueryClientProvider>
  );
}

function OraclePriceEventBridge() {
  useOraclePriceEvents();
  return null;
}
