# Phase Y — RWA Perpetuals

StellaX supports tokenised real-world-asset (RWA) perpetuals out of the box —
no contract changes are required. New markets are added via the existing
admin entry on `stellax-perp-engine`:

```rust
add_market(
    market_id: u32,
    base_asset: Symbol,   // oracle feed symbol, e.g. symbol_short!("BENJI")
    is_active: bool,
)
```

The same `OracleClient::set_price` / NAV-feed primitives the keeper uses for
crypto markets are reused for RWA NAV pushes.

## Launch markets

| `market_id` | Symbol     | Underlying                                      | Oracle feed |
|-------------|------------|-------------------------------------------------|-------------|
| `100`       | `BENJI`    | Franklin Templeton OnChain U.S. Government Money Fund | NAV daily   |
| `101`       | `USDY`     | Ondo USDY                                       | NAV daily   |
| `102`       | `OUSG`     | Ondo Short-Term U.S. Govt Bond ETF              | NAV daily   |

## Operator runbook

1. **Push initial oracle price** for the symbol via the keeper:

   ```bash
   stellar contract invoke --id $STELLAX_ORACLE_ADDR --source $KEEPER \
     --network testnet -- set_price \
     --feed_id BENJI --price 1000000000000000000 --timestamp $(date +%s)
   ```

2. **Register the market** on the perp engine:

   ```bash
   stellar contract invoke --id $STELLAX_PERP_ENGINE_ADDR --source $ADMIN \
     --network testnet -- add_market \
     --market_id 100 --base_asset BENJI --is_active true
   ```

3. **Configure conservative risk parameters** (RWA assets have low volatility
   but illiquid liquidation paths). Recommended starting values:

   | Param                    | Value     |
   |--------------------------|-----------|
   | `initial_margin_bps`     | `2000`    |
   | `maintenance_margin_bps` | `1000`    |
   | `max_leverage`           | `5`       |
   | `funding_clamp_bps`      | `50`      |

4. **NAV feed cadence** — push price daily (NAV updates once per business
   day for most RWA tokens). The oracle staleness guard tolerates 24h.

## Open items

- A dedicated NAV oracle adapter (`stellax-oracle::set_nav_price`) that
  enforces a max-daily-move guard would harden against keeper malfunction.
  Not required for testnet; tracked as Phase Y2.
- Frontend must show a "RWA" badge and a "settles to NAV" disclaimer
  (UI-only, no contract change).
