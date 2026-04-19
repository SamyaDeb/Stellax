import { NavLink, Outlet } from "react-router-dom";
import clsx from "clsx";
import { ConnectButton } from "./ConnectButton";
import { Toasts } from "./Toasts";
import { LiveBadge } from "./LiveBadge";

const NAV = [
  { to: "/trade", label: "Trade" },
  { to: "/options", label: "Options" },
  { to: "/vaults", label: "Vaults" },
  { to: "/bridge", label: "Bridge" },
  { to: "/governance", label: "Governance" },
  { to: "/dashboard", label: "Dashboard" },
] as const;

export function Layout() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-stella-border bg-stella-bg/80 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between px-6 py-3">
          <div className="flex items-center gap-6">
            <NavLink to="/trade" className="flex items-center gap-2">
              <span className="text-lg font-semibold tracking-tight text-white">StellaX</span>
              <span className="rounded bg-stella-surface px-1.5 py-0.5 text-[10px] text-stella-muted">
                TESTNET
              </span>
            </NavLink>
            <nav className="flex items-center gap-1">
              {NAV.map((n) => (
                <NavLink
                  key={n.to}
                  to={n.to}
                  className={({ isActive }) =>
                    clsx(
                      "rounded-md px-3 py-1.5 text-sm transition-colors",
                      isActive
                        ? "bg-stella-surface text-white"
                        : "text-stella-muted hover:text-white",
                    )
                  }
                >
                  {n.label}
                </NavLink>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <LiveBadge />
            <ConnectButton />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1400px] flex-1 px-6 py-6">
        <Outlet />
      </main>
      <Toasts />
    </div>
  );
}
