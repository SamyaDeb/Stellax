import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WalletProvider } from "./wallet";
import { Layout } from "./ui/Layout";
import { TradePage } from "./pages/TradePage";
import { OptionsPage } from "./pages/OptionsPage";
import { VaultsPage } from "./pages/VaultsPage";
import { BridgePage } from "./pages/BridgePage";
import { DashboardPage } from "./pages/DashboardPage";
import { GovernancePage } from "./pages/GovernancePage";

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
      <WalletProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<Navigate to="/trade" replace />} />
              <Route path="/trade" element={<TradePage />} />
              <Route path="/options" element={<OptionsPage />} />
              <Route path="/vaults" element={<VaultsPage />} />
              <Route path="/bridge" element={<BridgePage />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/governance" element={<GovernancePage />} />
              <Route path="*" element={<Navigate to="/trade" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </WalletProvider>
    </QueryClientProvider>
  );
}
