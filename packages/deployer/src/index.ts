// ── CLI entrypoint: `tsx src/index.ts <network> [--build-only]` ───────────────

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import TOML from "@iarna/toml";

import type { EnvironmentFile, Network, NetworkSection, MarketDef } from "./config.js";
import { buildAllContracts } from "./build.js";
import { ensureIdentity, ensureNetwork } from "./identity.js";
import { runDeploy, writeDeploymentFiles } from "./deploy.js";

function findRepoRoot(): string {
  // This file lives at packages/deployer/src/index.ts; repo root is 3 levels up.
  const here = fileURLToPath(new URL(".", import.meta.url));
  return resolve(here, "..", "..", "..");
}

function loadEnvFile(repoRoot: string): EnvironmentFile {
  const toml = readFileSync(join(repoRoot, "environments.toml"), "utf8");
  return TOML.parse(toml) as EnvironmentFile;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const network = (args[0] ?? "testnet") as Network;
  const buildOnly = args.includes("--build-only");
  const skipBuild = args.includes("--skip-build");

  if (network !== "testnet" && network !== "mainnet") {
    console.error(`unknown network: ${network} (use 'testnet' or 'mainnet')`);
    process.exit(1);
  }

  const repoRoot = findRepoRoot();
  console.log(`repo root: ${repoRoot}`);
  console.log(`network:   ${network}`);

  const envFile = loadEnvFile(repoRoot);
  const netCfg = envFile[network] as NetworkSection | undefined;
  if (!netCfg) {
    throw new Error(`environments.toml missing [${network}] section`);
  }
  const markets = (envFile.markets ?? []) as MarketDef[];

  if (!skipBuild) {
    console.log("\n═══ Build + optimize all contracts ═══════════════════════════");
    buildAllContracts(repoRoot);
  } else {
    console.log("(skipping build — --skip-build set)");
  }

  if (buildOnly) {
    console.log("build-only requested; exiting.");
    return;
  }

  console.log("\n═══ Identity + network ═══════════════════════════════════════");
  ensureNetwork(network, netCfg);
  const deployerAddr = ensureIdentity(netCfg.deployer_identity, network);
  console.log(`deployer: ${deployerAddr}`);

  const dep = await runDeploy({
    repoRoot,
    network,
    netCfg,
    markets,
    deployer: deployerAddr,
    identity: netCfg.deployer_identity,
  });

  console.log("\n═══ Writing deployment artifacts ═════════════════════════════");
  const { json, env } = writeDeploymentFiles(repoRoot, dep);
  console.log(`  → ${json}`);
  console.log(`  → ${env}`);

  console.log("\n✓ Deployment complete.");
}

main().catch((e) => { console.error(e); process.exit(1); });
