// ── WASM build + optimize step ────────────────────────────────────────────────

import { existsSync } from "node:fs";
import { join } from "node:path";
import { stellar } from "./shell.js";
import { CONTRACTS } from "./config.js";

/**
 * Absolute path to the optimized WASM for a contract. Stellar CLI v23
 * `build --optimize` writes directly to `<crate>.wasm` (the raw un-optimized
 * build is replaced in-place when --optimize is passed).
 */
export function optimizedWasmPath(repoRoot: string, contract: string): string {
  return join(repoRoot, "target/wasm32v1-none/release", `${contract}.wasm`);
}

/** Absolute path to the raw WASM (alias of optimized when built with --optimize). */
export function rawWasmPath(repoRoot: string, contract: string): string {
  return join(repoRoot, "target/wasm32v1-none/release", `${contract}.wasm`);
}

/**
 * Build every contract with `stellar contract build --optimize`. In CLI
 * v22+ `build --optimize` replaces the now-deprecated `contract optimize`
 * subcommand; it runs `cargo build --target wasm32v1-none --release` then
 * writes both `<crate>.wasm` and `<crate>.optimized.wasm` to the cargo
 * target dir.
 */
export function buildAllContracts(repoRoot: string): void {
  console.log("» stellar contract build --optimize (workspace)");
  stellar(["contract", "build", "--optimize"], { cwd: repoRoot, streaming: true });

  for (const contract of CONTRACTS) {
    const opt = optimizedWasmPath(repoRoot, contract);
    if (!existsSync(opt)) {
      throw new Error(
        `expected optimized WASM at ${opt} after build — is the contract listed in Cargo.toml workspace members with crate-type = [\"cdylib\"]?`,
      );
    }
  }
}
