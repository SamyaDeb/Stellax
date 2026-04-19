// ── Thin subprocess wrapper around the `stellar` CLI ──────────────────────────
//
// We shell out to the Stellar CLI for build, optimize, identity management,
// WASM install / contract deploy, and contract invoke. The CLI is the most
// stable abstraction: it handles XDR encoding of ScVals, footprint + resource
// simulation, signing, retries, and passphrase selection.

import { spawnSync, type SpawnSyncOptions } from "node:child_process";

export interface RunOptions extends SpawnSyncOptions {
  /** If true, do not throw on non-zero exit; return stderr instead. */
  allowFailure?: boolean;
  /** If true, stream stdio to parent. Otherwise capture. */
  streaming?: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a subprocess, capturing stdout/stderr. Throws on non-zero unless `allowFailure`. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): RunResult {
  const { allowFailure = false, streaming = false, ...spawnOpts } = opts;
  const stdio: SpawnSyncOptions["stdio"] = streaming ? "inherit" : "pipe";
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    ...spawnOpts,
    stdio,
  });

  if (res.error) {
    throw new Error(`failed to spawn ${cmd}: ${res.error.message}`);
  }

  const code = res.status ?? -1;
  const stdout = (res.stdout ?? "").toString().trim();
  const stderr = (res.stderr ?? "").toString().trim();

  if (code !== 0 && !allowFailure) {
    const stream = streaming ? "(see output above)" : `\nstdout: ${stdout}\nstderr: ${stderr}`;
    throw new Error(`${cmd} ${args.join(" ")} failed with exit ${code}${stream}`);
  }
  return { code, stdout, stderr };
}

/** `stellar ...` helper. */
export function stellar(args: string[], opts: RunOptions = {}): RunResult {
  return run("stellar", args, opts);
}

/** `cargo ...` helper. */
export function cargo(args: string[], opts: RunOptions = {}): RunResult {
  return run("cargo", args, opts);
}
