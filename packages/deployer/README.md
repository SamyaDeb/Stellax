# @stellax/deployer

End-to-end deployer for StellaX Soroban contracts.

## What it does

1. Builds all contracts (`stellar contract build`) and optimizes each wasm.
2. Ensures a funded Stellar identity exists (creates + Friendbot-funds on testnet if absent).
3. Uploads every contract WASM, records its hash.
4. Instantiates contracts in dependency order, passing correct constructor args.
5. Runs post-deploy wiring: vault `add_authorized_caller`, treasury `add_authorized_source`,
   perp `register_market` per `environments.toml`, oracle `set_fallback` (if Reflector set).
6. Writes results to `deployments/<network>.json` and `deployments/<network>.env`.

## Usage

```bash
# From repo root
pnpm --filter @stellax/deployer install
pnpm --filter @stellax/deployer run deploy:testnet
```

Requires:
- `stellar` CLI v22+ (`brew install stellar-cli`).
- Rust toolchain with `wasm32v1-none` target.
- `wasm-opt` in PATH (installed via `brew install binaryen`).

Identity used: `stellax-deployer` (generated automatically if missing on testnet).
