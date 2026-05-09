// ── Shared fixtures for the e2e suite ─────────────────────────────────────────

import { Keypair } from "@stellar/stellar-sdk";

import { loadDeployerKeypair, newFundedKeypair } from "./accounts.js";
import { loadDeployments, type Deployments } from "./deployments.js";
import type { NetworkCtx } from "./invoke.js";

export interface TestCtx {
  net: NetworkCtx;
  deployments: Deployments;
  deployer: Keypair;
}

let ctx: TestCtx | null = null;

/** Load deployments + deployer keypair once per test run. */
export function getCtx(): TestCtx {
  if (ctx) return ctx;
  const d = loadDeployments();
  ctx = {
    net: { rpcUrl: d.rpc_url, passphrase: d.network_passphrase },
    deployments: d,
    deployer: loadDeployerKeypair(),
  };
  return ctx;
}

/** Spawn + fund N fresh user keypairs via friendbot. */
export async function spawnUsers(n: number, label = "user"): Promise<Keypair[]> {
  const users: Keypair[] = [];
  for (let i = 0; i < n; i++) {
    users.push(await newFundedKeypair(`${label}${i + 1}`));
  }
  return users;
}
