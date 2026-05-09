// ── Types and configuration shared by deployer modules ──────────────────────

export type Network = "testnet" | "mainnet";

export interface MarketDef {
  id: number;
  symbol: string;
  base: string;
  quote: string;
  max_leverage: number;
  maker_fee_bps: number;
  taker_fee_bps: number;
}

export interface EnvironmentFile {
  [k: string]: unknown;
  testnet?: NetworkSection;
  mainnet?: NetworkSection;
  markets?: MarketDef[];
}

export interface NetworkSection {
  network: string;
  rpc_url: string;
  network_passphrase: string;
  horizon_url?: string;
  friendbot_url?: string;
  deployer_identity: string;
  axelar_gateway?: string;
  axelar_gas_service?: string;
  redstone_signer_threshold?: number;
  redstone_max_staleness_ms?: number;
}

/**
 * Final set of contract addresses after a deploy. Each field is populated as
 * the corresponding contract is instantiated. `null` until then.
 */
export interface Deployment {
  network: Network;
  network_passphrase: string;
  rpc_url: string;
  deployer: string;
  deployer_identity: string;
  deployed_at: string;
  usdc_token: string | null;
  wasm_hashes: Record<string, string>;
  contracts: {
    governor: string | null;
    oracle: string | null;
    vault: string | null;
    funding: string | null;
    risk: string | null;
    perp_engine: string | null;
    structured: string | null;
    treasury: string | null;
    bridge: string | null;
  };
}

export function emptyDeployment(network: Network, passphrase: string, rpc: string, identity: string): Deployment {
  return {
    network,
    network_passphrase: passphrase,
    rpc_url: rpc,
    deployer: "",
    deployer_identity: identity,
    deployed_at: new Date().toISOString(),
    usdc_token: null,
    wasm_hashes: {},
    contracts: {
      governor: null,
      oracle: null,
      vault: null,
      funding: null,
      risk: null,
      perp_engine: null,
      structured: null,
      treasury: null,
      bridge: null,
    },
  };
}

/** Full ordered list of deployable contracts (lib-only `stellax-math` excluded). */
export const CONTRACTS = [
  "stellax_governor",
  "stellax_oracle",
  "stellax_vault",
  "stellax_funding",
  "stellax_risk",
  "stellax_perp_engine",
  "stellax_structured",
  "stellax_treasury",
  "stellax_bridge",
] as const;

export type ContractName = (typeof CONTRACTS)[number];

/**
 * Circle's issuer account on Stellar testnet. The corresponding Stellar Asset
 * Contract address is derived with `stellar contract asset deploy --asset`.
 * Ref: https://developers.circle.com/stablecoins/usdc-on-test-networks
 */
export const CIRCLE_TESTNET_USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

/**
 * RedStone primary-prod signer addresses (20-byte EVM, lowercase hex).
 * Verified 2026-04-18 against
 * https://oracle-gateway-1.a.redstone.finance/data-packages/latest/redstone-primary-prod
 *
 * All 5 addresses sign every feed; on-chain we require a 3-of-5 consensus
 * (`signer_count_threshold = 3`) to tolerate one bad/lagging node and still
 * refuse forged payloads.
 */
export const REDSTONE_PRIMARY_SIGNERS_EVM = [
  "0x51Ce04Be4b3E32572C4Ec9135221d0691Ba7d202",
  "0x8BB8F32Df04c8b654987DAaeD53D6B6091e3B774",
  "0x9c5AE89C4Af6aA32cE58588DBaF90d18a855B6de",
  "0xDD682daEC5A90dD295d14DA4b0bec9281017b5bE",
  "0xdEB22f54738d54976C4c0fe5ce6d408E40d88499",
];

/** Required signer consensus threshold (3-of-5 matches RedStone guidance). */
export const REDSTONE_SIGNER_THRESHOLD = 3;
