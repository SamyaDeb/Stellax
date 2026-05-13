import { NavLink } from "react-router-dom";
import clsx from "clsx";
import {
  CandlestickChart,
  Wallet,
  Landmark,
  ArrowLeftRight,
  Zap,
  BarChart3,
  Scroll,
  Trophy,
  CirclePlus,
  Settings,
} from "lucide-react";

const SIDEBAR_ITEMS = [
  { to: "/trade",       label: "Trade",      Icon: CandlestickChart },
  { to: "/portfolio",   label: "Portfolio",  Icon: Wallet },
  { to: "/vaults",      label: "Vaults",     Icon: Landmark },
  { to: "/bridge",      label: "Bridge",     Icon: ArrowLeftRight },
  { to: "/staking",     label: "Staking",    Icon: Zap },
  { to: "/leaderboard", label: "Leaderboard",Icon: Trophy },
  { to: "/dashboard",   label: "Dashboard",  Icon: BarChart3 },
  { to: "/governance",  label: "Governance", Icon: Scroll },
] as const;

export function Sidebar() {
  return (
    <aside className="sidebar">
      {/* ── Nav items ─── */}
      <nav className="sidebar-nav">
        {SIDEBAR_ITEMS.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              clsx("sidebar-item", isActive && "active")
            }
            title={label}
          >
            <Icon size={18} strokeWidth={1.8} />
            <span className="sidebar-label">{label}</span>
          </NavLink>
        ))}

        {/* ── Deposit CTA ─── */}
        <NavLink
          to="/deposit"
          className={({ isActive }) =>
            clsx("sidebar-item sidebar-deposit", isActive && "active")
          }
          title="Deposit"
        >
          <CirclePlus size={18} strokeWidth={1.8} />
          <span className="sidebar-label">Deposit</span>
        </NavLink>
      </nav>

      {/* ── Bottom: Settings ─── */}
      <NavLink
        to="/settings"
        className={({ isActive }) =>
          clsx("sidebar-item sidebar-settings", isActive && "active")
        }
        title="Settings"
      >
        <Settings size={18} strokeWidth={1.8} />
        <span className="sidebar-label">Settings</span>
      </NavLink>
    </aside>
  );
}
