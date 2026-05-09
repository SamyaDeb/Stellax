// ── Deployment artifact loader ────────────────────────────────────────────────
//
// Reads deployments/testnet.json at the repo root. Handles the nested layout
// emitted by packages/deployer (top-level usdc_token + contracts.{...}).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Deployments {
  network: "testnet" | "mainnet";
  network_passphrase: string;
  rpc_url: string;
  deployer: string;
  usdc: string;
  governor: string;
  oracle: string;
  vault: string;
  funding: string;
  risk: string;
  perp_engine: string;
  options: string;
  structured: string;
  treasury: string;
  bridge: string;
  mock_rwa?: MockRwaDeployments;
}

export interface MockRwaAssetDeployment {
  contract_id: string;
  symbol: string;
  decimals: number;
  apy_bps: number;
  auth_required: boolean;
  haircut_bps?: number;
  max_deposit_cap_native?: number;
  issuer?: string;
}

export interface MockRwaDeployments {
  benji?: MockRwaAssetDeployment;
  usdy?: MockRwaAssetDeployment;
  ousg?: MockRwaAssetDeployment;
  oracle_feeds?: string[];
}

interface RawDeployments {
  network?: string;
  network_passphrase?: string;
  rpc_url?: string;
  deployer?: string;
  usdc_token?: string;
  contracts?: Record<string, string>;
  mock_rwa?: MockRwaDeployments;
}

const CONTRACT_KEYS = [
  "governor",
  "oracle",
  "vault",
  "funding",
  "risk",
  "perp_engine",
  "options",
  "structured",
  "treasury",
  "bridge",
] as const;

function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../../..");
}

let cached: Deployments | null = null;

export function loadDeployments(): Deployments {
  if (cached) return cached;
  const path = resolve(repoRoot(), "deployments/testnet.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as RawDeployments;

  const require = <T>(v: T | undefined, name: string): T => {
    if (v === undefined || v === null || v === "") {
      throw new Error(`deployments/testnet.json missing \"${name}\"`);
    }
    return v;
  };

  const contracts = require(raw.contracts, "contracts");
  const resolved: Deployments = {
    network: require(raw.network, "network") as "testnet" | "mainnet",
    network_passphrase: require(raw.network_passphrase, "network_passphrase"),
    rpc_url: require(raw.rpc_url, "rpc_url"),
    deployer: require(raw.deployer, "deployer"),
    usdc: require(raw.usdc_token, "usdc_token"),
    governor: "",
    oracle: "",
    vault: "",
    funding: "",
    risk: "",
    perp_engine: "",
    options: "",
    structured: "",
    treasury: "",
    bridge: "",
    mock_rwa: raw.mock_rwa,
  };
  for (const key of CONTRACT_KEYS) {
    resolved[key] = require(contracts[key], `contracts.${key}`);
  }

  cached = resolved;
  return resolved;
}

export const DEPLOYER_IDENTITY = "stellax-deployer";
