#!/usr/bin/env bash
# ── Upgrade existing StellaX core contracts in-place on testnet ──────────────
#
# We removed in-contract `instance().extend_ttl(...)` so that <contractCode>
# and <instance> entries no longer get pulled into the RW footprint on every
# state-mutating call. This keeps writeBytes well under the per-tx network
# cap (132,096 on testnet).
#
# Each contract exposes `upgrade(new_wasm_hash)` (admin-gated; auth as
# `stellax-deployer`). Steps per contract:
#   1. `stellar contract upload` optimized.wasm → captures wasm_hash
#   2. `stellar contract invoke ... -- upgrade --new_wasm_hash <hash>`
# Then patch deployments/testnet.json (wasm_hashes + upgraded_at).
#
# Run: bash scripts/upgrade-testnet.sh

set -euo pipefail

NETWORK=testnet
SOURCE=stellax-deployer
WASM_DIR=target/wasm32v1-none/release
DEPLOY_FILE=deployments/testnet.json

CONTRACTS=(
  "stellax_perp_engine perp_engine"
  "stellax_vault       vault"
  "stellax_funding     funding"
  "stellax_risk        risk"
  "stellax_oracle      oracle"
)

echo "▸ uploading + upgrading 5 contracts on $NETWORK as $SOURCE"

# Build "name=hash;name=hash;…" string to feed into the patch step.
HASH_PAIRS=""

for entry in "${CONTRACTS[@]}"; do
  read -r WASM_NAME CID_KEY <<<"$entry"
  WASM="$WASM_DIR/${WASM_NAME}.optimized.wasm"
  CID=$(node -e "console.log(require('./$DEPLOY_FILE').contracts.$CID_KEY)")

  echo
  echo "▸ $WASM_NAME ($CID)"

  if [[ ! -f "$WASM" ]]; then echo "  ✘ missing wasm: $WASM" >&2; exit 1; fi
  if [[ -z "$CID" ]];      then echo "  ✘ no contract id for $CID_KEY" >&2; exit 1; fi

  echo "  ▸ uploading $WASM"
  HASH=$(stellar contract upload \
    --wasm "$WASM" \
    --source-account "$SOURCE" \
    --network "$NETWORK" 2>/dev/null | tr -d '[:space:]')
  echo "    hash: $HASH"
  if [[ ${#HASH} -ne 64 ]]; then
    echo "  ✘ unexpected hash length: '$HASH'" >&2; exit 1
  fi

  echo "  ▸ invoke upgrade(new_wasm_hash=$HASH)"
  stellar contract invoke \
    --id "$CID" \
    --source-account "$SOURCE" \
    --network "$NETWORK" \
    -- upgrade --new_wasm_hash "$HASH" 2>&1 | sed 's/^/      /'

  HASH_PAIRS+="${WASM_NAME}=${HASH};"
done

echo
echo "▸ patching $DEPLOY_FILE wasm_hashes + upgraded_at"
TS=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
HASH_PAIRS="$HASH_PAIRS" TS="$TS" DEPLOY_FILE="$DEPLOY_FILE" node -e '
  const fs = require("fs");
  const path = process.env.DEPLOY_FILE;
  const j = JSON.parse(fs.readFileSync(path, "utf8"));
  const pairs = process.env.HASH_PAIRS.split(";").filter(Boolean);
  for (const p of pairs) {
    const [k, v] = p.split("=");
    j.wasm_hashes[k] = v;
  }
  j.upgraded_at = process.env.TS;
  fs.writeFileSync(path, JSON.stringify(j, null, 2) + "\n");
  console.log("  ✓ patched");
'

echo
echo "✓ upgrade complete"

# ── Post-upgrade: seed treasury vault balance ─────────────────────────────────
# The perp engine's settle_position_close pays user profits via
#   vault.move_balance(treasury → user, profit_amount)
# This requires the treasury contract address to have a non-zero internal vault
# balance.  We seed it after every upgrade to ensure a fresh deployment never
# blocks profitable close simulations with VaultError::InsufficientBalance (#8).
echo
echo "▸ seeding treasury vault balance (post-upgrade step)"
node scripts/seed-treasury-vault.mjs || {
  echo "  ⚠ treasury seed failed — run manually: node scripts/seed-treasury-vault.mjs"
}
