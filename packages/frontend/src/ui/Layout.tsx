import { NavLink, Outlet, Link, useLocation } from "react-router-dom";
import clsx from "clsx";
import { useWallet } from "@/wallet";
import { shortAddress } from "./format";
import { Toasts } from "./Toasts";
import { FeedHealthDot } from "./FeedHealthDot";
import { NetworkGuard } from "./NetworkGuard";
import { isTestnet } from "@/config";

const NAV_LINKS = [
  { to: "/trade",      label: "Trade" },
  { to: "/portfolio",  label: "Portfolio" },
  { to: "/staking",    label: "Staking" },
  { to: "/bridge",     label: "Bridge" },
] as const;

export function Layout() {
  const { status, address, connect, disconnect, error } = useWallet();
  const location = useLocation();
  const isTrade = location.pathname === "/trade";

  return (
    <div className="flex min-h-screen flex-col">
      <header className="app-nav">
        <div className="app-nav-inner">
          {/* Left: logo + nav */}
          <div className="app-nav-left">
            <Link to="/" className="app-logo">
              <span className="app-logo-text">Stellax</span>
            </Link>
            <nav className="app-nav-links">
              {NAV_LINKS.map((n) => (
                <NavLink
                  key={n.to}
                  to={n.to}
                  className={({ isActive }) =>
                    clsx("app-nav-link", isActive && "active")
                  }
                >
                  {n.label}
                </NavLink>
              ))}
              <NavLink
                to="/deposit"
                className={({ isActive }) =>
                  clsx("app-nav-cta", isActive && "active")
                }
              >
                Deposit
              </NavLink>
            </nav>
          </div>

          {/* Right: network pill + wallet */}
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
  );
}
