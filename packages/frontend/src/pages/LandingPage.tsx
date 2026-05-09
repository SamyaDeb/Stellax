import { Link } from "react-router-dom";

/* ─── Stat ticker data ─── */
const STATS = [
  { label: "Total Volume", value: "$1.2B+" },
  { label: "Markets", value: "10+" },
  { label: "Max Leverage", value: "20x" },
  { label: "Avg Settlement", value: "<5s" },
];

/* ─── Feature cards ─── */
const FEATURES = [
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="h-7 w-7">
        <path d="M3 17l6-6 4 4 8-8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M17 7h4v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    title: "Perpetual Futures",
    desc: "Trade perpetual contracts with up to 20x leverage on major crypto pairs. Near-instant settlement on Stellar.",
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="h-7 w-7">
        <rect x="3" y="11" width="18" height="10" rx="2" stroke="currentColor" strokeWidth="2" />
        <path d="M7 11V7a5 5 0 0110 0v4" stroke="currentColor" strokeWidth="2" />
      </svg>
    ),
    title: "Vaults & Yield",
    desc: "Deposit collateral for margin trading or earn yield from the structured covered-call vault. Auto-compounding returns.",
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="h-7 w-7">
        <path d="M12 2L2 7l10 5 10-5-10-5z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <path d="M2 17l10 5 10-5" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <path d="M2 12l10 5 10-5" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      </svg>
    ),
    title: "Cross-Chain Bridge",
    desc: "Seamless cross-chain transfers via Axelar GMP. Lock on Stellar, mint on EVM chains with validator attestations.",
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="h-7 w-7">
        <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" stroke="currentColor" strokeWidth="2" />
        <path d="M12 6v6l4 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    ),
    title: "On-chain Governance",
    desc: "Multisig governance with timelock. Propose actions, collect approvals, then execute. Community-first protocol.",
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="h-7 w-7">
        <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M12 3a9 9 0 110 18 9 9 0 010-18z" stroke="currentColor" strokeWidth="2" />
      </svg>
    ),
    title: "Institutional Risk Engine",
    desc: "Cross-margin accounts, real-time maintenance checks, insurance fund backstop, and ADL waterfall for safe liquidations.",
  },
];

/* ─── Nav links ─── */
const LANDING_NAV = [
  { to: "/trade", label: "Trade" },
  { to: "/vaults", label: "Vaults" },
  { to: "/bridge", label: "Bridge" },
  { to: "/governance", label: "Governance" },
  { to: "/dashboard", label: "Dashboard" },
];

export function LandingPage() {
  return (
    <div className="landing-page">
      {/* ════════ NAVBAR (same style as app navbar) ════════ */}
      <header className="app-nav">
        <div className="app-nav-inner">
          <div className="app-nav-left">
            <Link to="/" className="app-logo">
              <span className="app-logo-text">Stellax</span>
            </Link>
            <nav className="app-nav-links">
              {LANDING_NAV.map((n) => (
                <Link key={n.to} to={n.to} className="app-nav-link">
                  {n.label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="app-nav-right">
            <a
              href="https://github.com/SamyaDeb/Stellax"
              target="_blank"
              rel="noopener noreferrer"
              className="app-nav-link"
              aria-label="GitHub"
              style={{ display: "flex", alignItems: "center" }}
            >
              <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
                <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
              </svg>
            </a>
            <a
              href="https://x.com"
              target="_blank"
              rel="noopener noreferrer"
              className="app-nav-link"
              aria-label="X / Twitter"
              style={{ display: "flex", alignItems: "center" }}
            >
              <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
            </a>
            <Link to="/trade" className="app-connect-btn" id="connect-wallet-btn">
              Connect Wallet
            </Link>
          </div>
        </div>
      </header>

      {/* ════════ HERO ════════ */}
      <section className="landing-hero">
        <div className="landing-hero-glow"></div>
        <p className="landing-hero-tag">BUILT ON STELLAR · INSTITUTIONAL-GRADE EXECUTION</p>
        <h1 className="landing-hero-title">
          <span className="landing-hero-accent">Trade</span> with conviction
        </h1>
        <p className="landing-hero-sub">
          Trade across 10+ hottest markets with up to 20x leverage.<br />
          Perpetuals, vaults, and structured products - all on Stellar.
        </p>
        <div className="landing-hero-actions" style={{ margin: "2rem 0 3rem" }}>
          <Link to="/trade" className="landing-hero-btn-primary" id="start-trading-btn">
            Start Trading
          </Link>
          <Link to="/vaults" className="landing-hero-btn-secondary" id="start-earning-btn">
            Start Earning
          </Link>
        </div>
      </section>

      {/* ════════ PLATFORM PREVIEW ════════ */}
      <section className="landing-image-section" id="hero-image-slot">
        <div className="landing-preview-frame">
          <img
            src="/images/platform-preview.png"
            alt="Stellax trading platform — perpetual futures with real-time charts, order form, and position management"
            className="landing-preview-img"
          />
        </div>
      </section>

      {/* ════════ STATS TICKER ════════ */}
      <section className="landing-stats">
        <div className="landing-stats-inner">
          {STATS.map((s) => (
            <div key={s.label} className="landing-stat">
              <span className="landing-stat-value">{s.value}</span>
              <span className="landing-stat-label">{s.label}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ════════ BENTO FEATURES ════════ */}
      <section className="relative text-white z-10 py-20 px-4 mt-20">
        <div className="w-full max-w-[1100px] mx-auto relative z-10">
          
          {/* Header */}
          <div className="landing-features-head mb-10 md:mb-16">
            <p className="landing-features-tag">YOUR ALL-IN-ONE DEFI SUITE</p>
            <h2 className="landing-features-title">
              Everything you need to trade<br />and earn on <span className="text-stella-gold">Stellar</span>
            </h2>
          </div>

          <div className="grid grid-cols-12 md:grid-rows-6 gap-4 lg:gap-6 lg:h-[700px]">

            {/* Card 1: Perpetual Futures */}
            <div className="col-span-12 md:col-span-7 md:row-span-3 group cursor-default">
              <div className="h-full bg-white/5 backdrop-blur-xl border border-white/10 rounded-3xl p-6 text-white relative overflow-hidden transition-all duration-300 shadow-2xl">
                <div className="absolute inset-0 bg-gradient-to-br from-stella-gold/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 rounded-3xl"></div>
                <div className="relative z-10 h-full flex flex-col">
                  <div className="flex items-start justify-between mb-6">
                    <div>
                      <h2 className="text-2xl font-thin leading-tight mb-2 text-white">Perpetual Futures</h2>
                      <p className="text-white/90 text-sm font-light">Up to 20x leverage</p>
                    </div>
                    <div className="w-10 h-10 bg-white/10 backdrop-blur-sm rounded-xl flex items-center justify-center">
                      <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6 text-white">
                        <path d="M3 17l6-6 4 4 8-8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                        <path d="M17 7h4v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </div>
                  </div>
                  <div className="flex-1 flex flex-col justify-center">
                    <div className="bg-black/20 backdrop-blur-sm rounded-2xl p-4 mb-4 border border-white/10 text-center">
                      <p className="text-white/60 text-xs uppercase tracking-wide mb-1">Settlement Time</p>
                      <p className="text-3xl font-bold">5s</p>
                      <p className="text-stella-gold text-sm">Near-instant execution</p>
                    </div>
                    <p className="text-white/70 text-sm font-light">Trade perpetual contracts on major crypto pairs perfectly secured by the Stellar network validator consensus.</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Card 2: Vaults & Yield */}
            <div className="col-span-12 md:col-span-5 md:row-span-3 group cursor-default">
              <div className="h-full bg-white/5 backdrop-blur-xl border border-white/10 rounded-3xl p-6 relative overflow-hidden transition-all duration-300 shadow-xl">
                <div className="absolute inset-0 bg-gradient-to-br from-stella-gold/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 rounded-3xl"></div>
                <div className="relative z-10 h-full flex flex-col justify-center">
                  <div className="mb-6 text-center">
                    <div className="w-14 h-14 bg-gradient-to-br from-stella-gold/20 to-transparent rounded-2xl flex items-center justify-center mx-auto mb-4 border border-stella-gold/20">
                      <svg viewBox="0 0 24 24" fill="none" className="h-7 w-7 text-stella-gold">
                        <rect x="3" y="11" width="18" height="10" rx="2" stroke="currentColor" strokeWidth="2"/>
                        <path d="M7 11V7a5 5 0 0110 0v4" stroke="currentColor" strokeWidth="2"/>
                      </svg>
                    </div>
                    <h3 className="text-xl font-thin mb-2 text-white">Vaults & Yield</h3>
                    <p className="text-white/90 text-sm font-light">Auto-compounding returns</p>
                  </div>
                  <div className="grid grid-cols-2 gap-3 mb-6">
                    <div className="bg-white/5 border border-white/10 rounded-xl p-3 text-center">
                      <div className="text-stella-muted text-[10px] uppercase tracking-wider mb-1">Collateral</div>
                      <div className="text-white font-bold text-lg">USDC</div>
                    </div>
                    <div className="bg-stella-surface border border-stella-gold/20 rounded-xl p-3 text-center relative overflow-hidden">
                      <div className="text-stella-gold text-[10px] uppercase tracking-wider mb-1">Structured</div>
                      <div className="text-white font-bold text-lg">Vault</div>
                    </div>
                  </div>
                  <p className="text-white/70 text-sm font-light text-center">Deposit collateral for margin trading or earn yield from the structured covered-call vault automatically.</p>
                </div>
              </div>
            </div>

            {/* Card 3: Governance */}
            <div className="col-span-12 md:col-span-4 md:row-span-3 group cursor-default">
              <div className="h-full bg-white/5 backdrop-blur-xl border border-white/10 rounded-3xl p-5 md:p-6 relative overflow-hidden transition-all duration-300 shadow-xl flex flex-col justify-between">
                <div className="absolute inset-0 bg-gradient-to-br from-stella-gold/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 rounded-3xl"></div>
                <div className="relative z-10 w-full h-full flex flex-col">
                  <div className="mb-4 text-center">
                    <h3 className="text-xl md:text-2xl font-thin mb-1 text-white">Governance</h3>
                    <p className="text-white/60 text-sm font-light">Community-first protocol.</p>
                  </div>
                  <div className="space-y-4 flex-1 flex flex-col justify-center">
                    
                    <div className="group/item relative bg-white/5 hover:bg-white/10 transition-colors rounded-xl p-4 border border-white/10 overflow-hidden">
                      <div className="absolute top-0 right-0 p-3">
                        <div className="bg-stella-long/20 text-stella-long text-[9px] font-bold px-2 py-1 rounded-[4px] uppercase tracking-wide">Active</div>
                      </div>
                      <div className="flex items-center gap-3 mb-3">
                        <div className="w-9 h-9 bg-stella-gold/10 rounded-xl flex items-center justify-center border border-stella-gold/20">
                          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 text-stella-gold"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" stroke="currentColor" strokeWidth="2"/><path d="M12 6v6l4 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                        </div>
                        <div className="text-sm font-medium text-white">Multisig Quorum</div>
                      </div>
                      <div className="w-full bg-black/40 h-1.5 rounded-full overflow-hidden">
                        <div className="bg-gradient-to-r from-stella-gold/80 to-stella-gold w-[65%] h-full rounded-full relative">
                          <div className="absolute right-0 top-0 bottom-0 w-4 bg-white/50 blur-[2px]"></div>
                        </div>
                      </div>
                    </div>

                    <div className="group/item relative bg-white/5 hover:bg-white/10 transition-colors rounded-xl p-4 border border-white/10 overflow-hidden">
                      <div className="absolute top-0 right-0 p-3">
                        <div className="bg-white/10 text-white/50 text-[9px] font-bold px-2 py-1 rounded-[4px] uppercase tracking-wide">Enforced</div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 bg-white/5 rounded-xl flex items-center justify-center border border-white/10">
                          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 text-white/60"><path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        </div>
                        <div className="text-sm font-medium text-white/90">7-Day Timelock</div>
                      </div>
                    </div>

                  </div>
                </div>
              </div>
            </div>

            {/* Card 5: Inst Risk Engine */}
            <div className="col-span-12 md:col-span-4 md:row-span-2 group cursor-default">
              <div className="h-full bg-white/5 backdrop-blur-xl border border-white/10 rounded-3xl p-5 md:p-6 relative overflow-hidden transition-all duration-300 shadow-xl flex flex-col justify-between">
                <div className="absolute inset-0 bg-gradient-to-br from-stella-short/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 rounded-3xl"></div>
                <div className="relative z-10 w-full h-full flex flex-col justify-between">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-stella-surface border border-white/10 rounded-xl flex items-center justify-center shadow-[0_4px_20px_rgba(229,72,77,0.15)] overflow-hidden relative">
                        <div className="absolute bottom-0 w-full h-[2px] bg-stella-short"></div>
                        <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5 text-white/90">
                          <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          <path d="M12 3a9 9 0 110 18 9 9 0 010-18z" stroke="currentColor" strokeWidth="2"/>
                        </svg>
                      </div>
                      <h3 className="text-lg font-thin text-white">Risk Engine</h3>
                    </div>
                    <div className="px-2 py-1 bg-stella-short/15 border border-stella-short/30 rounded text-[9px] uppercase font-bold tracking-wider text-stella-short animate-pulse">Active</div>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-2 mb-3">
                    <div className="bg-white/5 rounded-lg p-2 text-center border border-white/5">
                      <p className="text-[9px] text-white/50 uppercase tracking-wider mb-1">Architecture</p>
                      <p className="text-xs font-medium text-white">Cross-Margin</p>
                    </div>
                    <div className="bg-stella-short/5 rounded-lg p-2 text-center border border-stella-short/20">
                      <p className="text-[9px] text-stella-short/60 uppercase tracking-wider mb-1">Defense</p>
                      <p className="text-xs font-medium text-stella-short">ADL System</p>
                    </div>
                  </div>

                  <p className="text-white/60 text-[11px] font-light leading-relaxed mt-auto">Maintenance checks designed to survive extreme market turbulence without cascading liquidations.</p>
                </div>
              </div>
            </div>

            {/* Card 6: Cross Chain Bridge */}
            <div className="col-span-12 md:col-span-4 md:row-span-1 group cursor-default">
              <div className="h-full bg-white/5 backdrop-blur-xl border border-white/10 rounded-3xl p-4 md:p-6 relative overflow-hidden transition-all duration-300 shadow-xl flex items-center">
                <div className="absolute inset-0 bg-gradient-to-br from-stella-gold/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 rounded-3xl"></div>
                <div className="relative z-10 w-full flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-thin text-white mb-1">Cross-Chain Bridge</h3>
                    <p className="text-[10px] font-light text-white/60">Axelar GMP Integration</p>
                  </div>
                  <div className="w-8 h-8 bg-stella-gold/20 rounded-lg flex flex-shrink-0 items-center justify-center border border-stella-gold/20">
                    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 text-stella-gold">
                      <path d="M12 2L2 7l10 5 10-5-10-5z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/>
                      <path d="M2 17l10 5 10-5" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/>
                      <path d="M2 12l10 5 10-5" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/>
                    </svg>
                  </div>
                </div>
              </div>
            </div>

          </div>
        </div>
      </section>

      {/* ════════ CTA BANNER ════════ */}
      <section className="landing-cta-section">
        <div className="landing-cta-inner">
          <h2 className="landing-cta-title">Start trading & earning in seconds</h2>
          <p className="landing-cta-sub">
            Connect your Freighter wallet and access perpetuals, vaults, and governance - all powered by Stellar.
          </p>
          <div className="landing-hero-actions" style={{ marginTop: "2rem" }}>
            <Link to="/trade" className="landing-hero-btn-primary">
              Launch App
            </Link>
            <a
              href="https://github.com/SamyaDeb/Stellax"
              target="_blank"
              rel="noopener noreferrer"
              className="landing-hero-btn-secondary"
            >
              View on GitHub
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}
