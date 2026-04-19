// ── Contract deploy + invoke helpers ──────────────────────────────────────────
//
// `stellar contract deploy --wasm <path> --source <identity> --network <net>
//   [-- <constructor_args>]` uploads the WASM if unknown and instantiates a
// fresh contract instance. It prints the new C... contract address on stdout.
//
// Constructor args after `--` use stellar-cli's long-form syntax:
//   --arg-name <value>
// For Address args pass either a G... or C... string.
// For Vec<X> args pass a JSON array as one argument.
// For struct args pass JSON shaped like the Rust `contracttype` serialization.

import { stellar } from "./shell.js";
import { optimizedWasmPath } from "./build.js";

export interface DeployOpts {
  repoRoot: string;
  contract: string;
  network: string;
  source: string;
  /** Constructor args, each element is a pair ["--key", "value"]. */
  ctorArgs?: string[];
}

export interface DeployResult {
  contractId: string; // C...
  wasmHash: string;   // hex
}

/** Upload a WASM (if not uploaded) and return its hash. */
export function installWasm(
  repoRoot: string,
  contract: string,
  network: string,
  source: string,
): string {
  const wasm = optimizedWasmPath(repoRoot, contract);
  console.log(`» stellar contract upload ${contract}`);
  const { stdout } = stellar([
    "contract",
    "upload",
    "--wasm",
    wasm,
    "--source",
    source,
    "--network",
    network,
  ]);
  const hash = stdout.trim();
  if (!/^[0-9a-f]{64}$/i.test(hash)) {
    throw new Error(`unexpected wasm hash output for ${contract}: ${stdout}`);
  }
  return hash;
}

/** Deploy a previously-uploaded WASM and invoke its constructor. */
export function deployContract(opts: DeployOpts): DeployResult {
  // Upload first (idempotent — CLI returns the existing hash if already installed).
  const hash = installWasm(opts.repoRoot, opts.contract, opts.network, opts.source);

  const cli = [
    "contract",
    "deploy",
    "--wasm-hash",
    hash,
    "--source",
    opts.source,
    "--network",
    opts.network,
  ];
  if (opts.ctorArgs && opts.ctorArgs.length > 0) {
    cli.push("--", ...opts.ctorArgs);
  }

  console.log(`» stellar contract deploy ${opts.contract}`);
  const { stdout } = stellar(cli);
  const id = stdout.trim().split(/\s+/).pop() ?? "";
  if (!/^C[A-Z2-7]{55}$/.test(id)) {
    throw new Error(`unexpected contract id for ${opts.contract}: ${stdout}`);
  }
  return { contractId: id, wasmHash: hash };
}

/** Run `stellar contract invoke` against a deployed contract. */
export function invoke(
  network: string,
  source: string,
  contractId: string,
  fn: string,
  args: string[],
): string {
  const cli = [
    "contract",
    "invoke",
    "--id",
    contractId,
    "--source",
    source,
    "--network",
    network,
    "--",
    fn,
    ...args,
  ];
  console.log(`» stellar contract invoke ${contractId.slice(0, 12)}… ${fn}`);
  return stellar(cli).stdout;
}

/**
 * Deploy the Stellar Asset Contract (SAC) for a Classic asset. Returns the
 * SAC address. Used to wrap Circle's testnet USDC issuer as a Soroban token.
 */
export function deploySacAsset(
  network: string,
  source: string,
  assetCode: string,
  issuer: string,
): string {
  console.log(`» stellar contract asset deploy ${assetCode}:${issuer.slice(0, 8)}…`);
  // Idempotent: if the SAC already exists the CLI prints the existing id (and
  // may exit non-zero depending on version); we then resolve deterministically
  // via `contract id asset`.
  stellar([
    "contract",
    "asset",
    "deploy",
    "--asset",
    `${assetCode}:${issuer}`,
    "--source",
    source,
    "--network",
    network,
  ], { allowFailure: true });

  const { stdout } = stellar([
    "contract",
    "id",
    "asset",
    "--asset",
    `${assetCode}:${issuer}`,
    "--network",
    network,
  ]);
  const id = stdout.trim();
  if (!/^C[A-Z2-7]{55}$/.test(id)) {
    throw new Error(`failed to resolve SAC id for ${assetCode}:${issuer}: ${stdout}`);
  }
  return id;
}
