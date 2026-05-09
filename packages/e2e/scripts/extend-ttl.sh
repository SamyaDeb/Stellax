#!/usr/bin/env bash
# ── Extend TTL of all stellax core contract instances + wasm code ─────────────
#
# Why: open_position internally calls `instance().extend_ttl(...)` on perp,
# vault, funding, risk. The simulator turns those into RW footprint entries
# AND includes the 3 wasm code blobs (~30-50 KB each) in writeBytes — which
# alone exceeds the testnet per-tx writeBytes cap (66,560 bytes).
#
# Pre-extending BOTH the instance TTL AND the wasm-code TTL out-of-band makes
# the in-contract extend_ttl a no-op so the simulator won't include them as RW.
#
# Run: bash packages/e2e/scripts/extend-ttl.sh

set -euo pipefail

NETWORK=testnet
SOURCE=stellax-deployer
LEDGERS=535680  # ~30 days at 5s/ledger

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_FILE="$SCRIPT_DIR/../../../deployments/testnet.json"
read_id()   { node -e "console.log(require('$DEPLOY_FILE').contracts.$1 || '')"; }
read_hash() { node -e "console.log(require('$DEPLOY_FILE').wasm_hashes.stellax_$1 || '')"; }

CONTRACTS=(
  "perp_engine"
  "vault"
  "funding"
  "risk"
  "oracle"
)

echo "▸ extending TTL by $LEDGERS ledgers on testnet"
for c in "${CONTRACTS[@]}"; do
  CID=$(read_id "$c")
  HASH=$(read_hash "$c")
  if [[ -z "$CID" ]]; then
    echo "  ⚠  $c: no contract id, skipping"
    continue
  fi
  echo "  ▸ $c instance $CID"
  stellar contract extend \
    --network "$NETWORK" \
    --source-account "$SOURCE" \
    --id "$CID" \
    --ledgers-to-extend "$LEDGERS" \
    --ttl-ledger-only \
    2>&1 | sed 's/^/      /'
  if [[ -n "$HASH" && "$HASH" != "unused_direct_deploy" && "${#HASH}" -eq 64 ]]; then
    echo "  ▸ $c wasm   $HASH"
    stellar contract extend \
      --network "$NETWORK" \
      --source-account "$SOURCE" \
      --wasm-hash "$HASH" \
      --ledgers-to-extend "$LEDGERS" \
      --ttl-ledger-only \
      2>&1 | sed 's/^/      /'
  fi
done
echo "✓ done"
