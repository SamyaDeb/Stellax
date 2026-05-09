# Phase Z — Upgrade vs Redeploy

StellaX contracts are designed to be **upgradeable** without changing their
on-chain addresses. Each contract exposes:

```rust
pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), Error>
```

The admin uploads the new WASM via `stellar contract upload --wasm <file>` to
get a hash, then calls the contract's `upgrade(hash)` entry. Existing storage
(positions, balances, governance state) is preserved.

## When to upgrade vs redeploy

| Change                                              | Upgrade | Redeploy |
|-----------------------------------------------------|:-------:|:--------:|
| Add new entry / new error / new DataKey variant     | ✅      |          |
| Append new struct field at the end of an existing struct | ⚠️ test deserialisation first | |
| Reorder/remove existing struct fields               |         | ✅       |
| Change existing entry signature (rename, retype)    |         | ✅       |
| Bump `CONTRACT_VERSION`                             | ✅      |          |
| New contract added to the suite                     |         | ✅ (new ID) |

## Phase mapping (S → Z)

All contract changes in this phase batch are **ABI-additive** and upgrade-safe:

| Phase | Contract                | Change                                 | Strategy   |
|-------|-------------------------|----------------------------------------|------------|
| S     | `stellax-vault`         | +4 entries, +1 error, +1 DataKey       | Upgrade    |
| T     | `stellax-vault`         | +1 entry (`atomic_swap`)               | Upgrade    |
| U     | `stellax-treasury`      | +5 entries, +2 errors, +2 DataKey      | Upgrade    |
| V     | `stellax-options`       | +4 entries, +4 errors, +3 DataKey      | Upgrade    |
| W     | (SDK only)              | New `stellar/` module                  | n/a        |
| X     | (PWA + bot, off-chain)  | New package + manifest                 | n/a        |
| Y     | (no contract change)    | Use existing `add_market` admin entry  | n/a        |
| Z     | (this doc + scripts)    | Deploy script + docs                   | n/a        |

## Upgrade procedure

1. **Build optimised WASM**:

   ```bash
   make optimize
   ```

2. **Upload the new WASM** and capture the hash:

   ```bash
   HASH=$(stellar contract upload \
     --wasm target/wasm32v1-none/release/stellax_vault.optimized.wasm \
     --source stellax-deployer --network testnet)
   echo "new hash: $HASH"
   ```

3. **Call `upgrade(new_wasm_hash)`** with the contract's existing address:

   ```bash
   ADDR=$(jq -r .stellax_vault deployments/testnet.json)
   stellar contract invoke --id "$ADDR" \
     --source stellax-deployer --network testnet \
     -- upgrade --new_wasm_hash "$HASH"
   ```

4. **Verify** the version bumped:

   ```bash
   stellar contract invoke --id "$ADDR" --network testnet -- version
   ```

5. **Smoke-test** the new entries against the deployed contract via the
   keeper or `packages/e2e` suite.

## Redeploy procedure

When a breaking change is required, redeploy the affected contract and any
contract that takes its address as a constructor argument. After redeploy:

1. Run `scripts/deploy.sh testnet` to get a new ID, or deploy individually.
2. Update `deployments/testnet.json` with the new address.
3. Re-run the post-deploy wiring (`set_authorized_caller`, `set_*_contract`)
   on every contract that references the redeployed one.
4. Notify the keeper to reload its config.
