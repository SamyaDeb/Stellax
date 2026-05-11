# @stellax/telegram-bot

Phase X — Telegram bot skeleton for StellaX.

## Run

```bash
export TELEGRAM_BOT_TOKEN=...   # from BotFather
export SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
export STELLAX_PERP_ADDR=...
export STELLAX_ORACLE_ADDR=...

pnpm -F @stellax/telegram-bot build
pnpm -F @stellax/telegram-bot start
```

## Commands

- `/price <symbol>` — oracle spot price (XLM, BTC, ETH, ...).
- `/position <G-addr>` — open perp positions for a Stellar address.
- `/help` — list commands.

The skeleton uses long-polling (`getUpdates`) with no third-party
dependencies. Wire the `OracleClient` / `PerpEngineClient` from `@stellax/sdk`
into `handleCommand` to enable live data.
