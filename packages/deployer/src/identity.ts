// ── Stellar CLI identity + network bootstrap ──────────────────────────────────

import { stellar } from "./shell.js";
import type { Network, NetworkSection } from "./config.js";

/**
 * Ensure the deployer identity exists locally. On testnet, if missing, we:
 *   1. Generate a fresh ed25519 keypair via `stellar keys generate ... --fund`
 *      which also asks Friendbot to fund it.
 *   2. Return its public key (G...).
 *
 * On mainnet we refuse to generate; the identity must be configured and funded
 * out of band (hardware wallet / multisig).
 */
export function ensureIdentity(identity: string, network: Network): string {
  // Check if the identity is already known to the Stellar CLI.
  const listed = stellar(["keys", "ls"], { allowFailure: true });
  const known = listed.stdout.split(/\r?\n/).map((l) => l.trim()).includes(identity);

  if (!known) {
    if (network === "mainnet") {
      throw new Error(
        `identity '${identity}' not found in stellar keys; refuse to auto-generate on mainnet`,
      );
    }
    console.log(`» stellar keys generate ${identity} --network ${network} --fund`);
    stellar(
      ["keys", "generate", identity, "--network", network, "--fund"],
      { streaming: true },
    );
  }

  const addr = stellar(["keys", "address", identity]).stdout;
  if (!/^G[A-Z2-7]{55}$/.test(addr)) {
    throw new Error(`unexpected public key format for identity ${identity}: ${addr}`);
  }
  return addr;
}

/**
 * Ensure the Stellar CLI knows about the target network (so subsequent
 * `--network <name>` works). We prefer the built-in `testnet` alias but
 * add `mainnet` explicitly if needed.
 */
export function ensureNetwork(network: Network, cfg: NetworkSection): void {
  const listed = stellar(["network", "ls"], { allowFailure: true }).stdout;
  if (listed.split(/\r?\n/).map((l) => l.trim()).includes(network)) {
    return;
  }
  console.log(`» stellar network add ${network}`);
  stellar([
    "network",
    "add",
    network,
    "--rpc-url",
    cfg.rpc_url,
    "--network-passphrase",
    cfg.network_passphrase,
  ]);
}
