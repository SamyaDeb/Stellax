#!/usr/bin/env bash
# Generates TypeScript bindings for every deployed StellaX contract using
# `stellar contract bindings typescript`. Output is written into the SDK
# package under packages/sdk/src/generated/<contract>.
#
# Prerequisites:
#   - Optimized WASMs in target/wasm32v1-none/release
#   - Network deployment file at .stellar/deployments/<network>.json (optional)
#
# Phase 11 / Phase 12 wires the generated clients into the SDK and frontend.

set -euo pipefail

NETWORK="${1:-testnet}"
OUT_DIR="packages/sdk/src/generated"
WASM_DIR="target/wasm32v1-none/release"

mkdir -p "$OUT_DIR"

for wasm in "$WASM_DIR"/stellax_*.optimized.wasm; do
  name=$(basename "$wasm" .optimized.wasm)
  echo ">> Generating bindings for $name"
  stellar contract bindings typescript \
    --wasm "$wasm" \
    --output-dir "$OUT_DIR/$name" \
    --overwrite \
    --network "$NETWORK" || true
done

echo "Bindings emitted to $OUT_DIR"
