# @stellax/keeper

Off-chain keeper bots for the StellaX derivatives protocol on Stellar/Soroban.

## Responsibilities

The keeper is a persistent Node.js service that performs the automated,
permissioned or incentivised actions StellaX contracts expect to happen
between user-initiated calls:

| Worker             | Cadence (default) | What it does                                                                                |
| ------------------ | ----------------- | ------------------------------------------------------------------------------------------- |
| `oracle-pusher`    | 10 s              | Fetches signed price payloads from RedStone and calls `StellaxOracle.write_prices`.         |
| `funding-updater`  | 1 h               | Calls `FundingEngine.update_funding(market_id)` for every configured perp market.           |
| `liquidation-bot`  | 5 s               | Scans open positions, simulates `RiskEngine.get_account_health`, liquidates under-margin.   |
| `option-settler`   | 1 h               | Batches expired option IDs into `OptionsEngine.settle_expired_options`.                     |
| `vault-roller`     | 60 s              | Calls `StructuredVault.roll_epoch()` at epoch boundaries for each configured vault.         |

A health server exposes `/health` (JSON) and `/metrics` (Prometheus) on
`HEALTH_PORT` (default `9090`). Critical failures (e.g. low keeper XLM
balance, all-liquidations-failing) are forwarded to Discord and/or Telegram
webhooks when configured.

## Quick start

```bash
# from repo root
pnpm install

# configure
cp packages/keeper/.env.example packages/keeper/.env
$EDITOR packages/keeper/.env

# run tests
pnpm -F @stellax/keeper test

# typecheck
pnpm -F @stellax/keeper typecheck

# build
pnpm -F @stellax/keeper build

# run (dev, tsx)
pnpm -F @stellax/keeper dev

# run (prod, built js)
pnpm -F @stellax/keeper start
```

## Architecture

```
src/
├── index.ts         # entrypoint; wires config → clients → workers → health
├── config.ts        # typed env loader
├── logger.ts        # pino + pretty transport
├── stellar.ts       # SorobanClient (simulate/invoke/retry/scVal helpers)
├── worker.ts        # BaseWorker scheduler
├── alert.ts         # Discord + Telegram alerting
├── redstone.ts      # RedStone payload fetcher
├── health.ts        # HTTP /health + /metrics
└── workers/
    ├── oracle-pusher.ts
    ├── funding-updater.ts
    ├── liquidation-bot.ts
    ├── option-settler.ts
    └── vault-roller.ts
```

All blockchain access is funnelled through the `StellarClient` interface
(`src/stellar.ts`), which makes every worker unit-testable with a mocked
client (`src/test/helpers.ts`).

## Indexer integration

The keeper does not index the chain itself. The liquidation, option-settler,
and vault-roller workers depend on three pluggable sources:

- `PositionSource.getOpenPositions()`
- `OptionExpirySource.getExpiredUnsettled()`
- `VaultScheduleSource.getCurrentEpochEnd(vaultId)`

`src/index.ts` currently wires **stub** implementations that return empty
data. Before running against mainnet, swap them for real implementations
backed by your indexer of choice (Subsquid, custom Horizon watcher, etc.).

## Environment variables

See `.env.example` for the full list with inline documentation. Highlights:

- `STELLAR_RPC_URL` / `STELLAR_NETWORK_PASSPHRASE` — Soroban RPC endpoint.
- `KEEPER_SECRET_KEY` — must start with `S`, account funded with XLM.
- `*_CONTRACT_ID` — one per deployed StellaX contract.
- `REDSTONE_*` — oracle gateway URL, feeds, signer threshold.
- `*_INTERVAL_MS` / `WORKER_*_ENABLED` — per-worker cadence and on/off switch.
- `ALERT_DISCORD_WEBHOOK`, `ALERT_TELEGRAM_*` — optional alert channels.
- `MIN_KEEPER_BALANCE_STROOPS`, `ORACLE_STALENESS_ALERT_MS` — alert thresholds.

## Operations

- Keeper is stateless; safe to run multiple replicas. Liquidations use
  `maxRetries: 1` so losing a race to another keeper is cheap and logged,
  not treated as an error.
- `/health` returns HTTP 200 iff every enabled worker has ticked at least
  once without throwing in its last run.
- `/metrics` exposes `stellax_keeper_worker_ticks_total`,
  `stellax_keeper_worker_errors_total`, and `stellax_keeper_worker_last_tick_ms`
  labelled by worker name.

## Testing

```bash
pnpm -F @stellax/keeper test
```

All 17 worker unit tests run with a mocked `StellarClient` — no RPC, no
network, no keys. Add new tests under `src/**/*.test.ts` using the helpers
in `src/test/helpers.ts`.
