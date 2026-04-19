#!/usr/bin/env bash
# Deploys all StellaX contracts to the chosen Stellar network in dependency order.
# Usage: scripts/deploy.sh [testnet|mainnet]
#
# Prerequisites:
#   - `stellar` CLI v26+ installed
#   - Identity `stellax-deployer` (testnet) or `stellax-deployer-mainnet` configured & funded
#   - Optimized WASMs present in target/wasm32v1-none/release/*.optimized.wasm
#
# This script is intentionally fail-fast (set -euo pipefail). Phase 14/15 will
# extend it with full constructor argument plumbing and post-deploy wiring.

set -euo pipefail

NETWORK="${1:-testnet}"

case "$NETWORK" in
  testnet)
    IDENTITY="stellax-deployer"
    ;;
  mainnet)
    IDENTITY="stellax-deployer-mainnet"
    ;;
  *)
    echo "Unknown network: $NETWORK (expected testnet|mainnet)" >&2
    exit 1
    ;;
esac

WASM_DIR="target/wasm32v1-none/release"

CONTRACTS=(
  stellax_oracle
  stellax_vault
  stellax_funding
  stellax_risk
  stellax_perp_engine
  stellax_options
  stellax_structured
  stellax_treasury
  stellax_governor
  stellax_bridge
)

mkdir -p .stellar/deployments
DEPLOY_FILE=".stellar/deployments/${NETWORK}.json"
echo "{}" > "$DEPLOY_FILE.tmp"

for c in "${CONTRACTS[@]}"; do
  WASM="$WASM_DIR/${c}.optimized.wasm"
  if [[ ! -f "$WASM" ]]; then
    echo "Missing optimized WASM: $WASM (run 'make optimize')" >&2
    exit 1
  fi
  echo ">> Deploying $c to $NETWORK"
  ID=$(stellar contract deploy \
    --wasm "$WASM" \
    --source "$IDENTITY" \
    --network "$NETWORK")
  echo "   $c => $ID"
  jq --arg k "$c" --arg v "$ID" '.[$k]=$v' "$DEPLOY_FILE.tmp" > "$DEPLOY_FILE.tmp.next"
  mv "$DEPLOY_FILE.tmp.next" "$DEPLOY_FILE.tmp"
done

mv "$DEPLOY_FILE.tmp" "$DEPLOY_FILE"
echo "All contracts deployed. Addresses written to $DEPLOY_FILE"
