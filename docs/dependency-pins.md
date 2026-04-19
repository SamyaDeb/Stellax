# Dependency Pinning Notes

The project's MSRV is **Rust 1.84.0** (matching `rust-toolchain.toml` and the
Stellar CLI 26.0.0 expected baseline). Several transitive dependencies have
since published versions that require `edition2024` (Rust ≥ 1.85), so the
following precise pins are kept in `Cargo.lock` to keep the build green on
1.84:

| Crate         | Pinned Version | Reason                                |
|---------------|----------------|---------------------------------------|
| `base64ct`    | `1.7.3`        | `1.8.x` requires edition2024          |
| `time`        | `0.3.41`       | `0.3.47` requires Rust 1.88           |
| `time-core`   | `0.1.4`        | `0.1.7+` requires edition2024         |
| `time-macros` | `0.2.22`       | `0.2.27` requires Rust 1.88           |
| `indexmap`    | `2.7.1`        | `2.14.0` requires edition2024         |
| `serde_with`  | `3.12.0`       | `3.18.0` pulls `time ~0.3.47`         |

To re-apply after a `cargo update`:

```bash
cargo update -p base64ct    --precise 1.7.3
cargo update -p serde_with  --precise 3.12.0
cargo update -p indexmap    --precise 2.7.1
cargo update -p time        --precise 0.3.41
cargo update -p time-core   --precise 0.1.4
cargo update -p time-macros --precise 0.2.22
```

When MSRV moves to 1.88+, all of these pins can be dropped.
