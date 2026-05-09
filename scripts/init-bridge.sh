#!/usr/bin/env bash
# scripts/init-bridge.sh — Initialize the StellaX Stellar bridge and register an EVM trusted source.
#
# Usage:
#   scripts/init-bridge.sh <EVM_BRIDGE_ADDRESS>
#
#   Example:
#   scripts/init-bridge.sh 0xAbCd1234...
#
# Prerequisites:
#   - stellar CLI v26+ installed
#   - Identity 'stellax-deployer' configured (testnet)
#   - Bridge contract already deployed (address in deployments/testnet.json)
#   - deployments/testnet.env sourced or present

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <EVM_BRIDGE_ADDRESS>" >&2
  echo "  Example: $0 0xAbCd1234..." >&2
  exit 1
fi

EVM_BRIDGE_ADDR="$1"

# ── Load deployment config ───────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$ROOT_DIR/deployments/testnet.env"

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$ENV_FILE"
fi

BRIDGE="${STELLAX_BRIDGE:-CDTZX3CTVVHN67ONILVY7PHSQDGZHMKCP3EM4NHATYUYA5J5NYSDZMVL}"
VAULT="${STELLAX_VAULT:-CDDA3QFNHWZDX4IWHHNISPOI3R5KX4OPEUIQC5NA2RAB2HTMOS7YW4IM}"
TREASURY="${STELLAX_TREASURY:-CCPGPJKOUTI5ES2DPFH5PPM2AP5RQPAESREHYEEPWJ46FY7JM6K7JUTF}"
USDC_SAC="${STELLAX_USDC:-CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA}"
DEPLOYER="${STELLAX_DEPLOYER:-GAVFAXLV54GY7M4WZYIZQGP5NFRAJOUQA2LA4UDDUWVJCOIEPEMKYNQG}"
IDENTITY="stellax-deployer"
NETWORK="testnet"

# Axelar Stellar testnet infrastructure addresses
# Source: https://docs.axelar.dev/resources/contract-addresses/testnet
AXELAR_GATEWAY="CCSNWHMQSPTW4PS7L32OIMH7Z6NFNCKYZKNFSWRSYX7MK64KHBDZDT5I"
AXELAR_GAS_SVC="CAZUKAFB5XHZKFZR7B5HIKB6BBMYSZIV3V2VWFTQWKYEMONWK2ZLTZCT"

# Axelar chain identifier for Avalanche Fuji (must match contract constant)
FUJI_CHAIN_NAME="Avalanche"

echo ""
echo "=== StellaX Bridge Initialization ==="
echo "Network     : $NETWORK"
echo "Bridge      : $BRIDGE"
echo "EVM bridge  : $EVM_BRIDGE_ADDR"
echo "Chain name  : $FUJI_CHAIN_NAME"
echo ""

# ── Step 1 — Check if already initialized ───────────────────────────────────
echo ">> Checking bridge initialization status..."
INIT_CHECK=$(stellar contract invoke \
  --id "$BRIDGE" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- version 2>&1 || echo "ERROR")

if echo "$INIT_CHECK" | grep -q "ERROR\|InvalidConfig"; then
  echo "   Bridge not initialized. Running initialize..."

  stellar contract invoke \
    --id "$BRIDGE" \
    --source "$IDENTITY" \
    --network "$NETWORK" \
    -- initialize \
    --config "{
      \"admin\": \"$DEPLOYER\",
      \"gateway\": \"$AXELAR_GATEWAY\",
      \"gas_service\": \"$AXELAR_GAS_SVC\",
      \"its\": \"$DEPLOYER\",
      \"vault\": \"$VAULT\",
      \"treasury\": \"$TREASURY\",
      \"protocol_fee_bps\": 30
    }"

  echo "   Bridge initialized."
else
  echo "   Bridge already initialized (version: $INIT_CHECK). Skipping."
fi

# ── Step 2 — Register trusted source ────────────────────────────────────────
echo ""
echo ">> Registering trusted source: $FUJI_CHAIN_NAME → $EVM_BRIDGE_ADDR"

stellar contract invoke \
  --id "$BRIDGE" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- set_trusted_source \
  --chain_name "$FUJI_CHAIN_NAME" \
  --remote_address "$EVM_BRIDGE_ADDR"

echo "   Trusted source registered."

# ── Step 3 — Verify trusted source ──────────────────────────────────────────
echo ""
echo ">> Verifying trusted source..."
IS_TRUSTED=$(stellar contract invoke \
  --id "$BRIDGE" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- is_trusted_source \
  --chain_name "$FUJI_CHAIN_NAME" \
  --remote_address "$EVM_BRIDGE_ADDR")

if [[ "$IS_TRUSTED" == *"true"* ]]; then
  echo "   Verified: is_trusted_source = true ✓"
else
  echo "   ERROR: trusted source not found after registration!" >&2
  exit 1
fi

# ── Step 4 — Register USDC token ─────────────────────────────────────────────
# Axelar ITS token ID for aUSDC on Stellar testnet.
# This is the 32-byte token ID from Axelar's ITS registry for the interchain USDC token.
# Source: stellar contract invoke on ITS contract, or query:
#   curl https://testnet.api.axelarscan.io/assets | jq '.[] | select(.denom=="uausdc")'
#
# For testnet bootstrapping, use a 32-byte zero token ID as a placeholder.
# Replace USDC_TOKEN_ID with the actual ITS token ID once obtained from Axelar.
USDC_TOKEN_ID="0000000000000000000000000000000000000000000000000000000000000000"

echo ""
echo ">> Registering USDC token (token_id: $USDC_TOKEN_ID → $USDC_SAC)..."

stellar contract invoke \
  --id "$BRIDGE" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- register_token \
  --token_id "$USDC_TOKEN_ID" \
  --local_token "$USDC_SAC"

echo "   USDC token registered."

# ── Step 5 — Verify token ─────────────────────────────────────────────────────
echo ""
echo ">> Verifying token registration..."
LOCAL_TOKEN=$(stellar contract invoke \
  --id "$BRIDGE" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- get_local_token \
  --token_id "$USDC_TOKEN_ID")

if echo "$LOCAL_TOKEN" | grep -q "$USDC_SAC"; then
  echo "   Verified: get_local_token = $USDC_SAC ✓"
else
  echo "   Warning: token lookup returned: $LOCAL_TOKEN"
fi

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "=== Bridge initialization complete! ==="
echo ""
echo "Next steps:"
echo "  1. Update EVM_BRIDGE in packages/frontend/src/wallet/evmWallet.ts"
echo "     Set: export const EVM_BRIDGE = \"$EVM_BRIDGE_ADDR\" as const;"
echo ""
echo "  2. Update EVM_BRIDGE_ADDR in packages/keeper/src/workers/bridge-keeper.ts"
echo "     Set: const EVM_BRIDGE_ADDR = \"$EVM_BRIDGE_ADDR\";"
echo ""
echo "  3. Start the bridge keeper:"
echo "     STELLAX_ADMIN_SECRET=<deployer_secret> npx tsx packages/keeper/src/workers/bridge-keeper.ts"
echo ""
echo "  4. Get testnet aUSDC for Avalanche Fuji:"
echo "     https://faucet.circle.com  (select Avalanche, aUSDC)"
echo ""
echo "  5. Get Fuji AVAX for relayer gas:"
echo "     https://faucet.avax.network"
echo ""
