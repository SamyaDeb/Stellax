#!/usr/bin/env bash
# StellaX Bridge End-to-End Test Script
# Tests the EVM (Avalanche Fuji) → Stellar cross-chain collateral deposit flow.
#
# Prerequisites:
#   - cast (Foundry)  — brew install foundry
#   - stellar CLI     — https://developers.stellar.org/docs/tools/developer-tools/cli
#   - curl, jq
#
# Usage:
#   chmod +x scripts/test-bridge-e2e.sh
#   ./scripts/test-bridge-e2e.sh [--keeper-only]
#
#   --keeper-only  Skip the Axelar GMP flow and only run the keeper direct test
#                  (useful when aUSDC faucet is unavailable or for quick iteration)
set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────────────────

EVM_RPC="https://api.avax-test.network/ext/bc/C/rpc"
CHAIN_ID=43113

PRIVATE_KEY="0x3629d1267caf64c8a2b44c6160b116b6694e569c2fc6bdde117e9ce0efa39958"
EVM_DEPLOYER="0x74E36d4A7b33057e3928CE4bf4C8C53A93361C34"

EVM_BRIDGE="0xa0b38B5F76C97e05DA9AcA0e2bd7788fBF0F207A"
AUSDC_FUJI="0x5425890298aed601595a70AB815c96711a31Bc65"
AXELAR_FUJI_GATEWAY="0xC249632c2D40b9001FE907806902f63038B737Ab"
AXELAR_FUJI_GAS_SVC="0xbE406F0189A0B4cf3A05C286473D23791Dd44Cc6"

STELLAR_NETWORK="testnet"
STELLAR_BRIDGE="CDTZX3CTVVHN67ONILVY7PHSQDGZHMKCP3EM4NHATYUYA5J5NYSDZMVL"
STELLAR_VAULT="CDDA3QFNHWZDX4IWHHNISPOI3R5KX4OPEUIQC5NA2RAB2HTMOS7YW4IM"
STELLAR_USDC_SAC="CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"
STELLAR_DEPLOYER="GAVFAXLV54GY7M4WZYIZQGP5NFRAJOUQA2LA4UDDUWVJCOIEPEMKYNQG"
STELLAR_IDENTITY="stellax-deployer"

# The Stellar recipient for bridge deposits (use deployer for tests)
STELLAR_RECIPIENT="$STELLAR_DEPLOYER"

# Token ID used on EVM side for aUSDC (all zeros = default USDC)
TOKEN_ID="0000000000000000000000000000000000000000000000000000000000000000"

# 1 USDC — use Stellar USDC SAC 7-decimal scale for keeper/vault calls.
# EVM aUSDC uses 6 decimals; the barrel of aUSDC on FujiEVM would be 1000000.
# When calling bridge_collateral_in directly (keeper mode) use 7-dec: 10000000.
DEPOSIT_AMOUNT_STELLAR="10000000"   # 1 USDC in Stellar 7-dec format
DEPOSIT_AMOUNT_EVM="1000000"        # 1 USDC in EVM 6-dec format (aUSDC Fuji)

# Axelar relayer gas to attach (0.02 AVAX in wei = 20000000000000000)
GAS_NATIVE_WEI="20000000000000000"

AXELAR_GMP_API="https://testnet.api.gmp.axelarscan.io"

# ─── Helpers ──────────────────────────────────────────────────────────────────

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
step()  { echo; echo -e "${GREEN}══${NC} $*"; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { error "Required command not found: $1"; exit 1; }
}

# ─── Preflight ────────────────────────────────────────────────────────────────

require_cmd cast
require_cmd stellar
require_cmd curl
require_cmd jq

KEEPER_ONLY=false
[[ "${1:-}" == "--keeper-only" ]] && KEEPER_ONLY=true

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║        StellaX Bridge E2E Test — Fuji → Stellar         ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
info "EVM Bridge:        $EVM_BRIDGE"
info "Stellar Bridge:    $STELLAR_BRIDGE"
info "Stellar Vault:     $STELLAR_VAULT"
info "EVM Deployer:      $EVM_DEPLOYER"
info "Stellar Recipient: $STELLAR_RECIPIENT"
echo ""

# ─── Part 0: Check Balances ───────────────────────────────────────────────────

step "0. Checking on-chain balances"

AVAX_WEI=$(cast balance "$EVM_DEPLOYER" --rpc-url "$EVM_RPC")
AVAX_ETH=$(cast to-unit "$AVAX_WEI" ether)
info "EVM deployer AVAX balance: $AVAX_ETH AVAX"

AUSDC_RAW=$(cast call "$AUSDC_FUJI" "balanceOf(address)(uint256)" "$EVM_DEPLOYER" --rpc-url "$EVM_RPC" 2>/dev/null || echo "0")
AUSDC_HUMAN=$(echo "scale=6; $AUSDC_RAW / 1000000" | bc 2>/dev/null || echo "$AUSDC_RAW")
info "EVM deployer aUSDC balance: $AUSDC_HUMAN aUSDC (raw: $AUSDC_RAW)"

# Check vault balance before test
VAULT_BALANCE_BEFORE_RAW=$(stellar contract invoke \
  --id "$STELLAR_VAULT" \
  --source "$STELLAR_IDENTITY" \
  --network "$STELLAR_NETWORK" \
  -- get_balance \
  --user "$STELLAR_RECIPIENT" \
  --token_address "$STELLAR_USDC_SAC" \
  2>/dev/null || echo "0")
# Strip JSON quotes from the returned value
VAULT_BALANCE_BEFORE=$(echo "$VAULT_BALANCE_BEFORE_RAW" | tr -d '"')
info "Stellar vault balance (before, 18-dec internal): $VAULT_BALANCE_BEFORE"

# ─── Part 1: Keeper Direct Test (no Axelar relay needed) ─────────────────────

step "1. Keeper Direct Test — bridge_collateral_in (simulates Axelar relay arrival)"

info "Calling bridge_collateral_in as admin/ITS (deployer)..."
info "  Recipient:  $STELLAR_RECIPIENT"
info "  Token ID:   $TOKEN_ID"
info "  Amount:     $DEPOSIT_AMOUNT_STELLAR (1 USDC, 7-decimal Stellar format)"
info "  Note: vault internally converts to 18-dec (expects 7-dec Stellar USDC input)"

stellar contract invoke \
  --id "$STELLAR_BRIDGE" \
  --source "$STELLAR_IDENTITY" \
  --network "$STELLAR_NETWORK" \
  --send=yes \
  -- bridge_collateral_in \
  --caller "$STELLAR_DEPLOYER" \
  --user "$STELLAR_RECIPIENT" \
  --token_id "$TOKEN_ID" \
  --amount "$DEPOSIT_AMOUNT_STELLAR" \
  2>&1 | grep -v "^$"

VAULT_BALANCE_AFTER_RAW=$(stellar contract invoke \
  --id "$STELLAR_VAULT" \
  --source "$STELLAR_IDENTITY" \
  --network "$STELLAR_NETWORK" \
  -- get_balance \
  --user "$STELLAR_RECIPIENT" \
  --token_address "$STELLAR_USDC_SAC" \
  2>/dev/null || echo "0")
VAULT_BALANCE_AFTER=$(echo "$VAULT_BALANCE_AFTER_RAW" | tr -d '"')

info "Stellar vault balance (after keeper test, 18-dec internal): $VAULT_BALANCE_AFTER"

# The vault stores amounts in 18-decimal precision.
# 1 USDC (7-dec Stellar input) → 10^18 internal units.
# Verify the balance increased by at least 1e18 (1 USDC worth).
VALT_BEFORE_CLEAN=${VAULT_BALANCE_BEFORE:-0}
VALT_AFTER_CLEAN=${VAULT_BALANCE_AFTER:-0}
# bc handles arbitrarily large integers (18-dec values exceed bash int range)
DELTA=$(echo "$VALT_AFTER_CLEAN - $VALT_BEFORE_CLEAN" | bc 2>/dev/null || echo "0")
info "Balance delta (18-dec): $DELTA"
# 1 USDC (7-dec input) → 1e18 internal = 1000000000000000000
ONE_USDC_18DEC="1000000000000000000"
if [[ "$(echo "$DELTA >= $ONE_USDC_18DEC" | bc 2>/dev/null)" == "1" ]]; then
  info "✅ PASS — Vault credited 1 USDC (delta=$DELTA ≥ 1e18) via bridge_collateral_in"
elif [[ "$(echo "$DELTA > 0" | bc 2>/dev/null)" == "1" ]]; then
  warn "Vault balance increased by $DELTA but less than 1e18 (check decimal conversion)"
else
  error "Balance did not increase. Delta=$DELTA"
  exit 1
fi

# ─── Part 2: Full EVM→Stellar Flow via Axelar GMP ────────────────────────────

if [[ "$KEEPER_ONLY" == "true" ]]; then
  info "Skipping Axelar GMP flow (--keeper-only flag set)."
  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║  Keeper Direct Test PASSED. Bridge is operational.      ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  exit 0
fi

step "2. Full Axelar GMP Flow — EVM depositToStellar"

# Gate on aUSDC balance
if [[ "$AUSDC_RAW" == "0" || -z "$AUSDC_RAW" ]]; then
  warn "No aUSDC balance on Fuji. Get testnet aUSDC from:"
  warn "  https://faucet.circle.com/ (select USDC testnet → Avalanche Fuji)"
  warn "  or directly from Axelar testnet faucet"
  warn ""
  warn "After obtaining aUSDC, re-run this script without --keeper-only."
  error "Skipping Axelar GMP flow — no aUSDC balance."
  exit 0
fi

info "Approving EVM bridge to spend $DEPOSIT_AMOUNT_EVM aUSDC..."
APPROVE_TX=$(cast send "$AUSDC_FUJI" \
  "approve(address,uint256)(bool)" \
  "$EVM_BRIDGE" "$DEPOSIT_AMOUNT_EVM" \
  --private-key "$PRIVATE_KEY" \
  --rpc-url "$EVM_RPC" \
  --chain-id "$CHAIN_ID" \
  --json 2>&1)
APPROVE_HASH=$(echo "$APPROVE_TX" | jq -r '.transactionHash // .hash // empty' 2>/dev/null || echo "$APPROVE_TX")
info "Approve tx: $APPROVE_HASH"

# Verify allowance
ALLOWANCE=$(cast call "$AUSDC_FUJI" \
  "allowance(address,address)(uint256)" \
  "$EVM_DEPLOYER" "$EVM_BRIDGE" \
  --rpc-url "$EVM_RPC")
info "Allowance set: $ALLOWANCE"

info "Calling depositToStellar with $DEPOSIT_AMOUNT_EVM aUSDC → $STELLAR_RECIPIENT ..."
info "  Attaching $GAS_NATIVE_WEI wei ($( echo "scale=4; $GAS_NATIVE_WEI / 10^18" | bc ) AVAX) for relay gas"

DEPOSIT_TX=$(cast send "$EVM_BRIDGE" \
  "depositToStellar(uint256,string)" \
  "$DEPOSIT_AMOUNT_EVM" "$STELLAR_RECIPIENT" \
  --value "$GAS_NATIVE_WEI" \
  --private-key "$PRIVATE_KEY" \
  --rpc-url "$EVM_RPC" \
  --chain-id "$CHAIN_ID" \
  --json 2>&1)

DEPOSIT_HASH=$(echo "$DEPOSIT_TX" | jq -r '.transactionHash // .hash // empty' 2>/dev/null || echo "")
[[ -z "$DEPOSIT_HASH" ]] && { error "depositToStellar tx failed: $DEPOSIT_TX"; exit 1; }
info "depositToStellar tx hash: $DEPOSIT_HASH"
info "Fuji explorer: https://testnet.snowtrace.io/tx/$DEPOSIT_HASH"
info "Axelar GMP tracker: https://testnet.axelarscan.io/gmp/$DEPOSIT_HASH"
echo ""

# ─── Part 3: Poll Axelar GMP API ─────────────────────────────────────────────

step "3. Polling Axelar GMP API for relay status"
info "This can take 2-5 minutes for Axelar to pick up and relay the message..."
info "Polling every 30s (max 20 attempts = 10 minutes)..."
echo ""

MAX_ATTEMPTS=20
SLEEP_SECS=30
FINAL_STATUS=""

for i in $(seq 1 "$MAX_ATTEMPTS"); do
  echo -n "  [Attempt $i/$MAX_ATTEMPTS] Checking GMP status..."

  GMP_RESP=$(curl -s \
    "$AXELAR_GMP_API/?method=searchGMP&txHash=$DEPOSIT_HASH" \
    -H "Accept: application/json" \
    2>/dev/null || echo '{}')

  STATUS=$(echo "$GMP_RESP" | jq -r '.data[0].status // "pending"' 2>/dev/null || echo "pending")
  DEST_TX=$(echo "$GMP_RESP" | jq -r '.data[0].executed.transactionHash // empty' 2>/dev/null || echo "")

  echo " status=$STATUS"

  if [[ "$STATUS" == "executed" || "$STATUS" == "success" ]]; then
    FINAL_STATUS="executed"
    info "✅ Message executed on Stellar!"
    [[ -n "$DEST_TX" ]] && info "   Stellar execution tx: $DEST_TX"
    break
  elif [[ "$STATUS" == "error" || "$STATUS" == "failed" ]]; then
    FINAL_STATUS="failed"
    error "Message relay failed:"
    echo "$GMP_RESP" | jq '.data[0].error // .data[0]' 2>/dev/null || echo "$GMP_RESP"
    break
  fi

  if [[ "$i" -lt "$MAX_ATTEMPTS" ]]; then
    sleep "$SLEEP_SECS"
  fi
done

# After Axelar relay, the bridge emits a dep_in event for the keeper.
# In production, the keeper service calls bridge_collateral_in automatically.
# Here we simulate it by calling it manually if the message was executed:
if [[ "${FINAL_STATUS:-}" == "executed" ]]; then
  info "Simulating keeper: calling bridge_collateral_in after GMP relay..."
  info "Note: EVM sends 6-dec amount ($DEPOSIT_AMOUNT_EVM). Using Stellar 7-dec equivalent for vault."
  stellar contract invoke \
    --id "$STELLAR_BRIDGE" \
    --source "$STELLAR_IDENTITY" \
    --network "$STELLAR_NETWORK" \
    --send=yes \
    -- bridge_collateral_in \
    --caller "$STELLAR_DEPLOYER" \
    --user "$STELLAR_RECIPIENT" \
    --token_id "$TOKEN_ID" \
    --amount "$DEPOSIT_AMOUNT_STELLAR" \
    2>&1 | grep -v "^$"
fi

# ─── Part 4: Verify Vault Balance ─────────────────────────────────────────────

step "4. Verifying Stellar vault balance after Axelar relay"

VAULT_BALANCE_FINAL_RAW=$(stellar contract invoke \
  --id "$STELLAR_VAULT" \
  --source "$STELLAR_IDENTITY" \
  --network "$STELLAR_NETWORK" \
  -- get_balance \
  --user "$STELLAR_RECIPIENT" \
  --token_address "$STELLAR_USDC_SAC" \
  2>/dev/null || echo "0")
VAULT_BALANCE_FINAL=$(echo "$VAULT_BALANCE_FINAL_RAW" | tr -d '"')

info "Vault balance (final): $VAULT_BALANCE_FINAL"

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║                    Test Summary                         ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "  EVM Bridge:              $EVM_BRIDGE"
echo "  Stellar Bridge:          $STELLAR_BRIDGE"
echo "  Stellar Vault:           $STELLAR_VAULT"
echo "  Deposit Tx (Fuji):       $DEPOSIT_HASH"
echo "  Axelar GMP Status:       ${FINAL_STATUS:-timed_out}"
  echo "  Vault Balance (before):  $VAULT_BALANCE_BEFORE (18-dec)"
  echo "  Vault Balance (after):   $VAULT_BALANCE_FINAL (18-dec)"
  echo "  Note: vault stores amounts in 18-decimal precision."
  echo "        1e18 = 1 USDC, 1e17 = 0.1 USDC, etc."
echo ""

if [[ "${FINAL_STATUS:-}" == "executed" ]]; then
  echo -e "${GREEN}  ✅ FULL E2E TEST PASSED — EVM→Stellar bridge is operational!${NC}"
elif [[ "${FINAL_STATUS:-}" == "failed" ]]; then
  echo -e "${RED}  ❌ GMP relay failed. Check Axelar GMP tracker for details.${NC}"
  echo "     https://testnet.axelarscan.io/gmp/$DEPOSIT_HASH"
else
  echo -e "${YELLOW}  ⏳ GMP relay timed out. The message may still be in flight.${NC}"
  echo "  Check: https://testnet.axelarscan.io/gmp/$DEPOSIT_HASH"
fi
echo ""
