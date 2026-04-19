# @stellax/frontend

Production frontend for the **StellaX** unified derivatives exchange on Stellar/Soroban.

Built with React 18 + Vite 5 + TypeScript, TanStack Query for server state, Zustand for wallet state, Tailwind CSS for styling, and Lightweight Charts v4 for price visualization. Talks to Soroban contracts through `@stellax/sdk` and signs transactions via the Freighter browser extension.

## Surfaces

| Route            | Description                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| `/trade`         | Perp trading — market selector, mark-price chart, long/short order form, positions table, account PnL |
| `/vaults`        | Collateral vault (deposit/withdraw) + structured yield vault (shares/NAV/epoch) + epoch history      |
| `/options`       | Cash-settled option writer (call/put, strike/size/expiry, premium quote) + holder/writer portfolio   |
| `/bridge`        | EVM lock intents, deposit status with validator attestation progress, release claims                  |
| `/dashboard`     | Protocol-wide stats (TVL, open interest, insurance fund, structured NAV) + per-market table          |

## Architecture

```
src/
├── config.ts               # Env-driven contract IDs, network passphrase, RPC URL
├── stellar/
│   ├── server.ts           # Shared rpc.Server instance
│   └── clients.ts          # Lazy singletons for each SDK client
├── wallet/
│   ├── store.ts            # Zustand store (address, status, network)
│   ├── freighter.ts        # Freighter detection + signer wrapper
│   ├── WalletContext.tsx   # Provider + connect/disconnect lifecycle
│   └── useTx.ts            # `run(build)` → simulate → sign → send → poll
├── hooks/
│   └── queries.ts          # All TanStack Query hooks + query-key factory
├── ui/                     # Shared primitives: Button, Card, Input, Select, Table, ConnectButton, format helpers
├── pages/
│   ├── trade/              # MarketSelector, PriceChart, OrderForm, PositionsTable, AccountSummary
│   ├── vaults/             # CollateralVaultCard, StructuredVaultCard, EpochHistory
│   ├── options/            # OptionWriterPanel, OptionsPortfolio
│   ├── bridge/             # BridgeLockForm, BridgeStatus, ValidatorList
│   └── dashboard/          # StatTile, MarketsTable
└── test/                   # Vitest + Testing Library suites
```

### Data flow

1. **Read path** — React components invoke query hooks from `hooks/queries.ts`. Each hook calls an SDK client method (e.g. `perpClient.getMarket(marketId)`), which simulates a contract call against the Soroban RPC and decodes the result. TanStack Query caches the result keyed by `qk.*` and re-fetches every 5 s for live prices.
2. **Write path** — Components use `useTx().run((address) => client.method(args).buildTransaction(...))`. `useTx` simulates, prompts Freighter for a signature, submits the signed XDR, and polls for `SUCCESS`.
3. **Wallet** — `WalletContext` wires Freighter's `signTransaction` into the store. All SDK clients consume an `Executor` interface; `useTx` provides the signing executor on demand.

## Environment

Copy `.env.example` to `.env.local` and set:

```bash
VITE_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
VITE_SOROBAN_RPC_URL="https://soroban-testnet.stellar.org"

VITE_CONTRACT_PERPS="C..."
VITE_CONTRACT_RISK="C..."
VITE_CONTRACT_VAULT="C..."
VITE_CONTRACT_STRUCTURED="C..."
VITE_CONTRACT_OPTIONS="C..."
VITE_CONTRACT_BRIDGE="C..."
VITE_CONTRACT_ORACLE="C..."
VITE_CONTRACT_GOVERNOR="C..."
VITE_CONTRACT_TREASURY="C..."
```

Contract IDs are emitted by the Phase 13 deployment pipeline.

## Development

```bash
pnpm install
pnpm --filter @stellax/frontend dev         # Vite dev server at :5173
pnpm --filter @stellax/frontend typecheck   # tsc --noEmit
pnpm --filter @stellax/frontend test        # vitest run
pnpm --filter @stellax/frontend build       # production bundle → dist/
pnpm --filter @stellax/frontend preview     # serve dist/
```

## Testing

Vitest + @testing-library/react with jsdom. Freighter and SDK clients are mocked at the module boundary (`vi.mock('@stellar/freighter-api')`, `vi.mock('@/stellar/clients')`) so tests never touch the network.

Current suites:

- `test/format.test.ts` — fixed-point ↔ decimal conversion, USD/percent/address formatters (12 tests)
- `test/wallet.test.tsx` — Freighter connect/disconnect lifecycle through `WalletContext` (3 tests)
- `test/order-form.test.tsx` — long/short submission, slippage/leverage validation, simulate-then-sign path (4 tests)

Run a single file: `pnpm --filter @stellax/frontend test src/test/order-form.test.tsx`.

## Notes & known limitations

- Position identity: Soroban `Position` does not expose a stable id yet; `PositionsTable` keys rows by `marketId` as a stopgap. Phase 14 indexer will emit canonical position ids.
- Price polling is a plain 5 s `refetchInterval` over oracle `getPrice`. Production should swap this for the Phase 14 WebSocket feed.
- The produced bundle is ~1.4 MB (400 KB gzipped) — dominated by `@stellar/stellar-sdk`. Code-splitting per route is a Phase 14 optimisation.
