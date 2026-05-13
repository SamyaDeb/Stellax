import { Outlet, Link, useLocation } from "react-router-dom";
import clsx from "clsx";
import { useState } from "react";
import { useWallet } from "@/wallet";
import { shortAddress } from "./format";
import { Toasts } from "./Toasts";
import { FeedHealthDot } from "./FeedHealthDot";
import { NetworkGuard } from "./NetworkGuard";
import { Sidebar } from "@/components/Sidebar";
import { isTestnet } from "@/config";

export function Layout() {
  const { status, address, connect, disconnect, error } = useWallet();
  const location = useLocation();
  const isTrade = location.pathname === "/trade";
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="app-shell">
      {/* ── Left icon sidebar ─── */}
      <div className={clsx("sidebar-mobile-wrap", sidebarOpen && "open")}>
        <div className="sidebar-mobile-backdrop" onClick={() => setSidebarOpen(false)} />
        <Sidebar />
      </div>

      {/* ── Main area offset by sidebar ─── */}
      <div className="app-shell-main">
        {/* ── Slim top bar ─── */}
        <header className="app-nav app-nav-slim">
          <div className="app-nav-inner">
            {/* Mobile hamburger */}
            <button
              className="sidebar-hamburger"
              onClick={() => setSidebarOpen((v) => !v)}
              aria-label="Toggle navigation"
              style={{
                display: "none",
                alignItems: "center",
                justifyContent: "center",
                width: 32,
                height: 32,
                border: "1px solid var(--border)",
                borderRadius: 3,
                background: "var(--bg2)",
                color: "var(--t2)",
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M3 6h18" /><path d="M3 12h18" /><path d="M3 18h18" />
              </svg>
            </button>
            <Link to="/" className="app-logo" aria-label="Stellax home">
              <span className="app-logo-text">Stellax</span>
            </Link>

            {/* Spacer fills between logo and right controls */}
            <div className="flex-1" />

            {/* Right: feed health + network + wallet */}
            <div className="app-nav-right">
              <FeedHealthDot />
              <div className="app-network-pill">
                <span className="app-network-dot" />
                {isTestnet() ? "Testnet" : "Stellar Mainnet"}
              </div>
              {status === "connected" && address !== null ? (
                <>
                  <span className="app-connected-addr">
                    <span className="dot" />
                    {shortAddress(address)}
                  </span>
                  <button className="app-disconnect-btn" onClick={disconnect}>
                    Disconnect
                  </button>
                </>
              ) : (
                <>
                  {error !== null && (
                    <span
                      className="text-xs"
                      style={{ color: "var(--red)" }}
                      title={error}
                    >
                      Wallet error
                    </span>
                  )}
                  <button
                    className="app-connect-btn"
                    onClick={() => void connect()}
                    disabled={status === "connecting"}
                  >
                    {status === "connecting" ? "Connecting..." : "Connect Wallet"}
                  </button>
                </>
              )}
            </div>
          </div>
        </header>

        <main className={clsx("app-main", isTrade && "app-main-trade")}>
          <NetworkGuard />
          <Outlet />
        </main>
        <Toasts />
      </div>
    </div>
  );
}
