# Perpetual Futures DEX — Frontend UX/UI Design Research

> Compiled May 2026 from live site inspection, docs, and current product analysis.

---

## 1. HyperLiquid (app.hyperliquid.xyz)

**The leading perp DEX by volume. Custom L1 with fully on-chain order books.**

### Layout Structure
- **Classic 3-column CEX layout**: Chart centered, order book on left, order form on right
- **Top bar**: Market selector (dropdown with search), current pair info (price, 24h change, funding, volume, open interest)
- **Left sidebar**: Thin icon-based navigation (Trade, Portfolio, Leaderboard, Referrals, etc.)
- **Center-left**: Full order book (bids/asks with depth visualization, recent trades)
- **Center**: TradingView chart (v28.5 — fully embedded, custom studies)
- **Center-right below chart**: Tabs for Positions, Open Orders, Order History, Trade History, Account Value
- **Right panel**: Order entry form (Market/Limit/Stop/Take tabs, leverage slider, size input, TP/SL fields)

### Key Pages/Routes
| Route | Purpose |
|-------|---------|
| `/` (Trade) | Main trading screen |
| `/portfolio` | Account portfolio, PnL graphs, max drawdown |
| `/leaderboard` | PnL leaderboard (daily/weekly/all-time),ROI and volume rankings |
| `/referrals` | Referral code management |
| `/vaults` | Vault spot/perp trading vaults |
| `/earn` | Staking, delegation |

### Navigation Pattern
- **Left icon sidebar** (thin, ~48px) — icons only, expands on hover or click. Most minimal sidebar in the space.
- Top bar has market search, network selector, wallet connect, notification bell

### Color Scheme / Theme
- **Dark mode only** — `#303030` background (dark charcoal)
- Accent: HyperLiquid uses a **blue/cyan** primary (#2196F3-ish) for buys, **red/pink** (#F23645) for sells/losses
- Green for positive PnL, red for negative — standard trading palette
- Very clean, minimal UI with tight spacing — feels like Binance/Coinbit

### Charting
- **TradingView v28.5** fully embedded (loaded from `/charting_library_v28.5/`)
- Full indicator suite, drawing tools, multi-timeframe
- Custom theme integration with HyperLiquid's dark palette

### Order Types Supported
- Market, Limit, Stop Market, Stop Limit, Take Market, Take Limit
- **Scale orders** (multiple limit orders across a price range)
- **TWAP orders** (automated time-weighted execution over configurable duration, 30s intervals, max 3% slippage)
- Reduce Only, Post Only (ALO), Immediate or Cancel (IOC), GTC
- TP/SL on position level (attached to positions, not separate orders)

### Portfolio / Account Page
- Portfolio value graph over time (account value history)
- Max drawdown calculation displayed (pnl-based)
- Open positions table with unrealized PnL, entry price, liquidation price, leverage
- Cross-margin by default; Portfolio Margin mode (Alpha)
- Sub-accounts supported

### Bridge / Deposit Flow
- **Native bridging** from Ethereum (L1 → HyperLiquid via hyperbridge)
- Direct ETH/USDC deposits from Arbitrum
- "Deposit" button prominent in top-right area, opens modal
- No third-party widget — built-in bridge
- Withdrawal to Ethereum mainnet supported

### Unique Features
- **Leaderboard**: The most prominent in DeFi — shows top traders by PnL, daily/weekly/all-time. Key social/competitive feature.
- **TWAP orders**: Unique algorithmic order type for large position entry
- **Scale orders**: Grid-like batch limit order placement
- **Hyperps**: Index perpetuals (basket perps tracking indices)
- **Portfolio margin (Alpha)**: Cross-collateral across perps and spot
- **Account abstraction**: EOA, Smart Contract Wallets, and HyperLiquid-native abstraction modes
- **Builder codes**: Referral/affiliate system with fee sharing
- **Vaults**: User-created trading vaults others can deposit into (copy-trading adjacent)

### Mobile Responsiveness
- Desktop-first design; mobile web app exists but is a compressed version
- Touch-friendly order form on mobile
- No native iOS/Android app
- `meta viewport` set for mobile, uses `maximum-scale=1, user-scalable=no`

---

## 2. dYdX (dydx.exchange / dydx.trade)

**Order-book perp DEX. Now on its own Cosmos-based L1 (MegaDrive). The "CEX-like" DEX.**

### Layout Structure
- **Full CEX-style 4-column layout** — the closest to Binance/Bybit of any DEX
- **Left column**: Market list/watchlist with search, favorites, volume sorting
- **Center-left**: Order book with depth chart toggle
- **Center**: TradingView chart (full featured)
- **Center-right**: Recent trades feed
- **Right column**: Order entry panel
- **Bottom panel**: Tabs — Positions, Open Orders, Order History, Trade History, Transfers, Funding

### Key Pages/Routes
| Route | Purpose |
|-------|---------|
| `/trade/:market` | Main trading view |
| `/markets` | All markets overview with stats |
| `/portfolio` | Portfolio overview, balances |
| `/history` | Full trade history |
| `/rewards` | Trading rewards, fee discounts |
| `/profile/:address` | Public trader profile |
| `/earn` | Staking dYdX token |

### Navigation Pattern
- **Left sidebar navigation** (expanded, ~200px) — full text labels with icons
- Sections: Trade, Portfolio, Rewards, Earn, Transfer, Help
- Top bar: Market selector, search, wallet, settings

### Color Scheme / Theme
- **Dark mode default** — deep black (#000000) background with dark gray panels
- Accent: **White/gray text** on dark — very high contrast
- Green (#00DC82) for positive, Red (#FF3860) for negative
- dYdX purple (#6B47FB) used sparingly for branding elements
- Webflow-built marketing site is separate from the React trading app
- Typography: Inter or similar sans-serif, very clean

### Charting
- **Custom charting** (was TradingView, now custom-built on v4 app)
- Full candlestick, depth, volume studies
- Drawing tools, indicators
- v4 app rebuilt charts from scratch for performance

### Order Types Supported
- Market, Limit, Stop Market, Stop Limit, Take Profit Market, Take Profit Limit
- Good 'Til Cancel (GTC), Immediate or Cancel (IOC), Post Only
- Reduce Only option
- TP/SL attached to orders
- **Advanced**: Conditional close orders, trailing stops (on v4)

### Portfolio / Account Page
- Balances by asset with total equity
- Margin usage visualization (pie chart)
- Unrealized/realized PnL breakdown
- Position table with size, entry, mark, PnL, liquidation price
- Transfer/deposit/withdraw integrated
- Cross-margin only (no isolated margin)

### Bridge / Deposit Flow
- **Deposit from any chain** via third-party bridges (mostly native Cosmos IBC transfers to the dYdX chain)
- Built-in deposit modal with chain selection
- Withdrawal via IBC or bridge back to Ethereum
- "Transfer" tab for cross-chain

### Unique Features
- **Mobile apps**: dYdX is the ONLY perp DEX with full native **iOS and Android apps** — this is a major differentiator
- **Telegram trading bot**: Official @dYdX_bot for placing trades
- **High-performance API**: REST + WebSocket APIs for programmatic trading, matching CEX quality
- **200+ markets**: Widest market selection in DeFi perps
- **Instant listings**: New markets listed quickly
- **Reward campaigns**: Incentive programs with blinking green dot in nav
- **VIP program**: Fee tiers based on volume
- **Public profiles**: Shareable trader profiles with stats

### Mobile Responsiveness
- **Native iOS and Android apps** — fully featured, not just mobile web
- Mobile web also responsive
- Desktop app is primary; mobile apps have slightly simplified order book view
- Marketing site is separate (Webflow-built at dydx.xyz)

---

## 3. GMX (app.gmx.io)

**Oracle-based (AMM) perp DEX on Arbitrum & Avalanche. The "swap-like" perp trading experience.**

### Layout Structure
- **Simplified 2-column layout** — NOT a traditional CEX layout
- **Left/Center**: Chart area with TradingView
- **Right side panel**: Swap-style order form (Long/Short toggle, leverage slider, token input, "Enable Contract" then "Long" / "Short" buttons)
- **Below chart**: Positions table, Orders table, Trades history
- **No traditional order book** — GMX uses oracle pricing + AMM, no visible order book
- Sticky header with: GMX logo, Trade/Earn/Buy/Swap tabs, network selector (Arbitrum/Avalanche), wallet connect

### Key Pages/Routes
| Route | Purpose |
|-------|---------|
| `/#/trade` | Perps trading (default) |
| `/#/earn` | GMX/GLP staking, rewards |
| `/#/buy` | Buy GMX token |
| `/#/swap` | Token swap (1inch integration) |
| `/#/portfolio` | Positions & orders |
| `/#/nft` | GMX NFTs (for fee discounts) |

### Navigation Pattern
- **Top tab navigation** — horizontally aligned tabs: Trade, Earn, Buy, Swap
- No left sidebar — everything accessible from top tabs
- Swap-centric design philosophy — the perp trading form looks like Uniswap's swap UI

### Color Scheme / Theme
- **Dark mode by default** (#15182B deep navy/dark blue background)
- Panels: Darker navy (#1B1E31) with subtle borders
- Accent: **Blue/cyan (#47 nine-shade)** for primary actions, GMX brand blue
- Green (#3CBCB0 teal-ish) for long profits, Red (#CC4C4C) for losses/short
- Clean, minimal, somewhat "flat" aesthetic
- Font: Inter

### Charting
- **TradingView** (loaded from `/charting_library/charting_library.standalone.js`)
- Full indicator suite, drawing tools
- Integrated with GMX's oracle price feed

### Order Types Supported
- **Market orders only** (oracle-based execution)
- **Limit orders**: Set trigger price (executed by keepers when oracle hits price)
- **Stop-loss orders**: Trigger-based, keeper-executed
- **No traditional order book orders** — GMX is oracle-priced, not order-book based
- Leverage: Up to 100x on some pairs (adjustable via slider)
- TP/SL can be set after opening position

### Portfolio / Account Page
- Positions table showing: Market, Side (Long/Short), Size, Collateral, Entry Price, Mark Price, PnL ($ and %), Liq. Price
- Open orders (pending limit/stop)
- Trade history
- Total account equity and available margin displayed at top
- Simple, uncluttered

### Bridge / Deposit Flow
- **Built-in bridge/swap**: Users can deposit ETH, USDC, or any token
- GMX routes through 1inch/Paraswap for conversions
- "Enable Contract" approval step for each new token
- Network switcher (Arbitrum ↔ Avalanche) in header
- Avax/Arb deposit via native bridges

### Unique Features
- **GLP/GMX tokenomics**: Earn page shows staking rewards, APR
- **No order book**: Oracle pricing means guaranteed execution (no partial fills, no front-running visible)
- **Price impact displayed upfront**: Shows "Price Impact" and execution price before confirming
- **NFT fee discounts**: Special GMX NFTs reduce trading fees
- **Swap-style UX**: The trading form is intentionally simplified — select token, choose long/short, set leverage, execute. Designed for DeFi native users, not professional traders.
- **Multi-chain**: Arbitrum and Avalanche deployment with network switcher

### Mobile Responsiveness
- Responsive web app, stacks to single column on mobile
- Order form becomes full-width below chart
- No native app
- Reasonable mobile experience but clearly desktop-first

---

## 4. Polymarket (polymarket.com)

**Prediction market with perp-like positions. Included because it represents a different paradigm — event-driven outcomes as tradeable assets.**

### Layout Structure
- **Card-based discovery layout** — NOT a traditional trading interface
- **Home**: Grid of event cards with probabilities, categories, trending
- **Event page**: Shows outcome probabilities as progress bars, order book (simplified), recent trades, comments
- **Portfolio page**: Holdings grouped by event, PnL per position
- Minimal charting — probability line charts, not candlestick
- No leverage, no complex order types — binary outcome contracts ($0 to $1)

### Key Pages/Routes
| Route | Purpose |
|-------|---------|
| `/` | Discover/browse markets |
| `/event/[slug]` | Individual event with outcomes |
| `/portfolio` | User's positions |
| `/profile/[username]` | Public profile |
| `/leaderboard` | Top traders |

### Navigation Pattern
- **Top navigation bar**: Logo, Search, Browse, Portfolio
- **Category filters**: Sports, Politics, Crypto, Science, etc.
- Card-grid layout for market discovery

### Color Scheme / Theme
- **Dark mode by default (#0B0B0F background)**
- Cards on (#16171F dark panels)
- Accent: **Purple/Violet (#6655F7)** for brand, **Green/Red** for buy/sell outcomes
- Outcome shares shown as colored progress bars
- Clean, modern, consumer-friendly design — more like Robinhood than Binance

### Charting
- **Custom simple line charts** showing probability over time
- No candlestick, no technical indicators
- Focus on probability visualization rather than price action

### Order Types Supported
- **Limit orders** (buy/sell at price)
- **Market orders** (instant fill)
- No stop losses, no TP/SL, no leverage
- Binary outcomes: shares priced $0.01–$0.99

### Portfolio / Account Page
- Holdings listed by event with current value and PnL
- Total portfolio value, realized/unrealized PnL
- Share quantities, avg purchase price, current value

### Bridge / Deposit Flow
- USDC on Polygon (now Polymarket runs on Polygon)
- Deposit via direct USDC transfer
- Also supports crypto card purchases (MoonPay integration)
- Simple deposit modal

### Unique Features
- **Social/comment system**: Every market has a comment thread (like Twitter), biggest differentiator
- **Leaderboard**: Ranked by PnL, top predictors
- **Embed cards**: Shareable market outcome visualizations
- **API**: Public API for programmatic access
- **CLOB backend**: Uses order book matching via锰 (Mangrove) / CTF exchange
- **Consumer-friendly**: The entire UX is designed for non-crypto-natives — it feels more like a betting app than a DEX

### Mobile Responsiveness
- **Mobile-first design** — works beautifully on phone browsers
- Card grid adapts to screen width
- No native app but PWA-like experience

> **Note**: Polymarket isn't a "perp DEX" in the traditional sense but represents the prediction-market paradigm which some perp DEXes (like Polynomial) draw from for UI patterns.

---

## 5. Jupiter Perps (jup.ag/perps)

**Solana-based perp DEX. Part of Jupiter's DeFi super-app (swap + limit orders + perps + lending).**

### Layout Structure
- **Centered swap-style order form** (Jupiter's signature style)
- **Chart**: TradingView embedded chart (from `static.jup.ag/tv/charting_library/`)
- **Left panel**: Market info, positions, trade history
- **Right panel**: Order form (Long/Short, leverage slider, size, TP/SL)
- **Bottom section**: Positions, orders, trade history tabs
- Market selector: Dropdown with search, categories (All, Crypto, Forex, Metals)
- Clean, minimal — the "Jupiter aesthetic"

### Key Pages/Routes
| Route | Purpose |
|-------|---------|
| `/perps` | Perp trading |
| `/swap` | Token swap (Jupiter's core product) |
| `/limit` | Limit orders for spot |
| `/earn` | Lending/borrowing |
| `/portfolio` | All positions across products |

### Navigation Pattern
- **Top tab navigation**: Swap, Limit, Perps, Earn, Stake — product verticals
- Within Perps: sub-tabs for Markets, Positions, Orders, History
- No left sidebar — top-level navigation is product-based

### Color Scheme / Theme
- **Dark mode primary** (#1C2936 deep blue-gray background, theme-color meta)
- Accent: **Jupiter Orange (#F7931A Bitcoin-orange derivative)** — warm orange for primary actions
- Green/#22C55E for profits, Red/#EF4444 for losses
- Very clean, lots of whitespace, Inter font
- Minimalist — fewer visual elements than any competitor

### Charting
- **TradingView** (hosted at `static.jup.ag/tv/`) — full integration
- Custom-styled to match Jupiter's dark theme
- Standard indicators, multi-timeframe

### Order Types Supported
- Market, Limit
- Stop Market, Stop Limit
- Take Profit / Stop Loss (on positions)
- **Up to 250x leverage** on some pairs
- Jupiter-specific: "Perps on Jupiter" branded, powered by JLP liquidity pool

### Portfolio / Account Page
- Unified portfolio view across Swap, Limit, Perps, Earn
- Position table with: Market, Side, Size, Entry, Mark, PnL, Liq Price
- Margin/collateral management
- Cross-margin (Jupiter uses a shared liquidity pool model)

### Bridge / Deposit Flow
- Native Solana — deposit SOL, USDC, or any Solana token
- Jupiter Swap integration means you can swap any token to margin collateral in-app
- Simple deposit modal, no bridging needed (all on Solana)

### Unique Features
- **Jupiter Super-App**: Perps is ONE tab of Jupiter's multi-product interface — users seamlessly switch between swap/limit/perps/earn
- **JLP token**: Jupiter Liquidity Provider token — earn fees by providing liquidity to the perp pool
- **250x leverage**: Highest max leverage in DeFi perps
- **Solana speed**: Orders confirmed in ~400ms (Solana finality)
- **Price impact shown**: Clear display of execution price vs mark price
- **Staked JUP**: Governance and fee-sharing

### Mobile Responsiveness
- Responsive web app, works well on mobile
- Stacks to vertical layout on small screens
- No native app
- Inter font optimized for mobile readability

---

## 6. Drift Protocol (app.drift.trade)

**Solana perp DEX with hybrid AMM + order book model. "BETS" (Borrow, Earn, Trade, Swap) approach.**

### Layout Structure
- **Left sidebar** (~64-80px icon + text nav): Trade, Swap, Earn, Borrow/Lend, Insurance Fund, Rewards
- **Main area**: Chart centered with order book overlay or side panel
- **Right panel**: Order entry — swap-style Long/Short with leverage
- **Bottom panel**: Tabs for Positions, Orders, History, Activity
- Market selector in top bar with search
- "Account health" indicator prominently displayed (bar showing maintenance margin ratio)
- Background: `bg-main-bg` (dark), text: `text-sm font-inter`

### Key Pages/Routes
| Route | Purpose |
|-------|---------|
| `/trade` | Perp trading (default) |
| `/swap` | Token swap |
| `/earn/borrow-lend` | Lend/borrow markets |
| `/earn/insurance-fund` | Insurance fund staking |
| `/protect` | AMPLIFY positions (leveraged yield) |
| `/rewards` | Trading rewards |

### Navigation Pattern
- **Left icon sidebar** — persistent, with icons for: Trade, Swap, Earn, Borrow/Lend, Protect, Rewards
- Top bar: Market selector, wallet, network status
- Sub-navigation within sections (e.g., Earn → Borrow/Lend tabs)

### Color Scheme / Theme
- **Dark mode default** (black #000 background, meta theme-color)
- Accent: **Drift Blue/Purple (#5B4FBE / purple tones)** for brand
- Green for long/profit, Red for short/loss
- Font: Inter (font-inter class), tabular numbers (`font-feature-settings: 'tnum', 'lnum'`)
- Health bar: gradient from red → yellow → green based on margin health
- Clean but more information-dense than Jupiter

### Charting
- Custom TradingView integration (not externally hosted)
- Full candlestick chart with indicators
- Oracle price overlay when relevant (_AMM vs order book pricing)

### Order Types Supported
- **Market orders** (JIT auction mechanism — 5-second Dutch auction with market makers)
- **Limit orders** (post to DLOB, executed by keepers)
- **Advanced orders**: Stop Market, Stop Limit, Take Profit, Trailing Stop
- **Reduce Only** flag
- **Post Only** flag (maker-only)
- **IOC** (Immediate or Cancel)
- **Oracle price conditional orders** (trigger on oracle price, not just mark)
- **Perp vs Spot**: Different order flows for perps and spot markets

### Portfolio / Account Page
- Cross-margined account showing total equity, free collateral, maintenance margin
- **Account Health Bar**: Visual indicator of how close to liquidation (red/yellow/green)
- Positions table: Market, Side, Size, Entry, Mark Price, PnL ($, %), Liq Price
- Unsettled PnL displayed separately
- Sub-accounts supported
- Deposit/withdraw integrated

### Bridge / Deposit Flow
- **Solana-native**: Deposit SOL, USDC, or any Solana token
- **Cross-collateral**: Multiple tokens accepted as collateral (SOL, USDC, mSOL, etc.)
- **Swap integration**: Can swap tokens for deposit collateral in-app
- Simple wallet connection (Phantom, Solflare, Backpack, or **passwordless login**)
- Sub-account management for multiple strategies

### Unique Features
- **JIT Auction**: Market orders trigger a 5-second Dutch auction — market makers compete to fill, improving execution
- **AMM + DLOB hybrid**: Combines an on-chain AMM with a decentralized limit order book
- **Borrow/Lend integrated**: Lending markets are part of the same UI, not a separate product
- **AMPLIFY**: Leveraged yield strategies (borrow to leverage yield-bearing positions)
- **Passwordless login**: Email/social login option (via Civic or similar)
- **Insurance Fund staking**: Users can stake in the insurance fund for yield
- **KEEPER bots**: Decentralized keeper network for order execution
- **SWIFT API**: Off-chain signed orders for faster execution
- **Pre-launch markets**: Trade tokens before they launch

### Mobile Responsiveness
- Responsive web app with `overflow-x-hidden` class
- Bottom panels collapse into tabs
- No native app
- Mobile wallet support (Phantom mobile browser)

---

## 7. Vertex Protocol (app.vertex.protocol)

**Cross-margin perp DEX on Arbitrum. Combines spot + perp + money markets.**

> Note: The app.vertex.protocol site returned a transport error during research; findings are based on documentation and prior product knowledge.

### Layout Structure
- **CEX-style 3-panel layout**: Order book left, chart center, order form right
- **Top bar**: Logo, navigation (Trade, Portfolio, Earn), network, wallet
- **Left panel**: Order book with depth visualization, recent trades
- **Center**: TradingView chart
- **Right panel**: Order entry (Market/Limit/Stop tabs, leverage, size, TP/SL)
- **Bottom**: Positions, Orders, Trade History, Funding

### Key Pages/Routes
| Route | Purpose |
|-------|---------|
| `/trade` | Perp & spot trading |
| `/portfolio` | Account overview, PnL |
| `/earn` | Money market (lend/borrow) |
| `/rewards` | Vertex rewards program |

### Navigation Pattern
- **Top navigation bar** with dropdown sections
- Primary: Trade, Portfolio, Earn
- Settings and network switcher in top right

### Color Scheme / Theme
- **Dark mode default** — deep navy/black (#0D0D2B background)
- Accent: **Vertex Blue (#4C82FB)** for primary actions
- Green/Red for long/short
- Clean, professional aesthetic similar to HyperLiquid

### Charting
- TradingView integration
- Full indicator suite, custom styling

### Order Types Supported
- Market, Limit, Stop Market, Stop Limit
- Take Profit / Stop Loss
- Reduce Only
- Post Only
- IOC, GTC

### Portfolio / Account Page
- Cross-margin account showing total portfolio value
- Margin usage visualization
- Realized/Unrealized PnL
- Position management (close, add margin)
- Spot + Perp positions unified view

### Bridge / Deposit Flow
- Arbitrum-native (deposit ETH/USDC on Arbitrum)
- Built-in bridge from Ethereum mainnet
- USDC, USDb, ARB accepted as collateral
- Simple deposit modal with chain selection

### Unique Features
- **Cross-margin by default**: All positions share margin — capital efficient
- **Integrated money market**: Lend unused collateral to earn yield while trading
- **Spot + Perp unified**: Trade spot and perps from the same margin account
- **-orderbook + AMM hybrid**: Uses a central limit order book with AMM backstop
- **Liquidation protection**: Auto-deleveraging system
- **VRTX token**: Governance and fee share

### Mobile Responsiveness
- Responsive web, desktop-primary
- No native mobile app

---

## 8. Synthetix Perps (perps.synthetix.io)

**Optimism-based perp DEX with off-chain order book (Pyth oracle). Now rebranded as "Snax".**

### Layout Structure
- **Classic 3-column layout** from the documentation:
  - **Left**: Order book + recent trades
  - **Center**: TradingView chart with tabs above (depth, funding history, asset details)
  - **Right**: Order entry panel (Market/Limit tabs, leverage, size, TP/SL)
- **Below chart**: Tabs for open positions, open orders, account balances, PnL
- **Top bar**: Market selector, account info, network, wallet

> From Synthetix docs: *"The default trading page brings together the chart, order book, recent trades, order entry, and account panels in a single workspace."*

### Key Pages/Routes
| Route | Purpose |
|-------|---------|
| `/trade` | Main trading view (default landing) |
| `/markets` | All markets overview with sortable stats (price, 24h change, funding, OI, volume) |
| `/portfolio` | Account dashboard, balances, margin, PnL, history |
| `/vaults` | SLP Vault (liquidity provision) |

### Navigation Pattern
- **Left sidebar navigation**: Trade, Markets, Portfolio, Vaults
- Persistent sidebar with icons + text labels
- Market selector accessible from top of trading page

### Color Scheme / Theme
- **Dark mode only** (#0E0E1A deep purple-black)
- Accent: **Synthetix purple/pink (#8A39E8)** for brand elements
- Panel backgrounds: Dark navy (#13132A)
- Green for positive, Red for negative
- Clean, modern — feels like a professional trading terminal
- Font: Inter with tabular numbers

### Charting
- **TradingView** — full integration with custom Synthetix theme
- Standard indicators, multi-timeframe, drawing tools
- Tabs above chart: Chart, Depth, Funding History, Asset Details

### Order Types Supported
From Synthetix docs:
- **Market orders**: Immediate execution at best available book price
- **Limit orders**: Fill at selected price or better, with **Chase** feature (re-price to best bid/ask)
- **Stop-loss orders**: Triggered at specified price
- **Take-profit orders**: Triggered at target price
- **Conditional exit orders** (TP/SL): Auto-exit positions
- **Reduce Only**: Restricts order to position reduction
- **Time in Force**: GTC (Good 'Til Canceled), IOC (Immediate or Cancel)
- **Post Only (ALO)**: Maker-only, rejected if it would take liquidity
- **Advanced order types**: OCO (One-Cancels-Other), trailing stops
- **Order Chase**: Re-prices existing limit to current best bid/ask

### Portfolio / Account Page
From Synthetix docs:
- **Current collateral & available margin** displayed prominently
- Unrealized & realized PnL across positions
- Trade & order history
- Margin in use vs. free margin
- Cross-margin by default (all positions share sUSD collateral)
- "Control center for your account" — tracks overall performance, not individual trades

### Bridge / Deposit Flow
- Deposit **sUSD** (Synthetix USD stablecoin) as primary collateral
- Also accepts ETH, USDC, USDT, and other tokens (via 1inch aggregation)
- Optimism-native — deposit on Optimism L2
- Bridge from Ethereum mainnet via official Optimism bridge
- "Deposit collateral" page with token selection and amount input

### Unique Features
- **"Snax" rebrand**: The perps interface is now branded as Snax (synthetix.exchange domain also redirects)
- **Off-chain order book** with on-chain settlement via Pyth oracle
- **Chase orders**: Unique feature that re-prices limit orders to current best bid/ask
- **Cross-margin with sUSD**: All positions share sUSD collateral
- **SLP Vault**: External liquidity providers earn fees from perp traders
- **Delegated trading**: Allow others to trade on your subaccount
- **Subaccounts**: Multiple trading accounts under one wallet
- **Advanced order types**: OCO, trailing stops, conditional orders
- **Funding rate display**: 1h funding rates shown prominently in market overview

### Mobile Responsiveness
- Desktop-first design
- Responsive web but optimized for desktop trading
- No native app
- Synthetix docs explicitly guide users to desktop for best experience

---

## Comparative Analysis

### Layout Philosophy Comparison

| DEX | Layout Style | Philosophy |
|-----|-------------|-----------|
| **HyperLiquid** | Classic 3-col CEX | Professional trader terminal |
| **dYdX** | Full 4-col CEX | Binance/Bybit clone, maximum information density |
| **GMX** | Swap-style 2-col | DeFi-native, simplified, Uniswap-like |
| **Polymarket** | Card grid (events) | Consumer prediction market, not traditional trading |
| **Jupiter** | Minimal 2-col (swap-style) | Super-app tab, clean, approachable |
| **Drift** | Left-nav + 3-col | Features-dense, Solana ecosystem |
| **Vertex** | Classic 3-col CEX | Professional, cross-margin focus |
| **Synthetix** | Classic 3-col CEX | Professional with advanced features (Chase, OCO) |

### Order Types Comparison

| Feature | HL | dYdX | GMX | Jupiter | Drift | Vertex | Synthetix |
|---------|-----|------|-----|---------|-------|--------|-----------|
| Market | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Limit | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Stop Market | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Stop Limit | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ |
| Take Profit | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Trailing Stop | ❌ | ✅ | ❌ | ❌ | ✅ | ? | ✅ |
| Reduce Only | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ |
| Post Only | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ |
| IOC | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ |
| TWAP | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Scale/Grid | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| OCO | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Chase | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Oracle Trigger | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |

### Key Differentiators Summary

| DEX | Killer Feature | Target User |
|-----|---------------|-------------|
| **HyperLiquid** | TWAP/Scale orders, Leaderboard, fastest on-chain order book | Professional traders, quant algo traders |
| **dYdX** | Only native mobile app, 200+ markets, API quality | Anywhere/anytime traders, mobile-first |
| **GMX** | Simplest UX, oracle-based guaranteed fills, GLP staking | DeFi-native casual traders, swap users |
| **Polymarket** | Social/comment system, consumer-friendly, event-driven | Non-crypto-native speculators |
| **Jupiter** | Super-app integration (swap + perps + earn), 250x leverage | Solana ecosystem traders, Jupiter users |
| **Drift** | JIT auction execution, Borrow/Lend integration, passwordless login | Solana power users, yield farmers |
| **Vertex** | Cross-margin + money market, unified spot/perp | Capital-efficient traders |
| **Synthetix** | Chase orders, advanced conditional orders, delegated trading | Advanced retail, algorithmic traders |

### Design Pattern Takeaways for Building a Great Perp DEX UX

1. **Three-column CEX layout** is the gold standard for professional perp trading (HL, dYdX, Vertex, Synthetix all use it)
2. **Swap-style layouts** (GMX, Jupiter) lower the barrier for DeFi-native users but sacrifice information density
3. **TradingView integration** is universal — build on v28+ for the best experience
4. **Dark mode only** is the norm — light mode is not expected in perp trading
5. **Left icon sidebar** (HL, Drift) is preferred over top tabs or full sidebar for clean navigation
6. **Account health / margin bar** should be always visible (Drift's implementation is excellent)
7. **TP/SL on position** (not just as separate orders) is now table stakes
8. **Leaderboard/PnL rankings** drive massive engagement (HL's leaderboard is iconic)
9. **Cross-margin by default** — isolated margin is rarely used and confuses users
10. **Mobile apps** (dYdX) or responsive web — pick one and do it well