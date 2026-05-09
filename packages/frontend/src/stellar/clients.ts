/**
 * Singleton accessor for all typed SDK clients.
 *
 * Clients hold no mutable state — they're thin bindings over
 * `{ executor, contractId, method }`. Lazily instantiated.
 *
 * The cache is keyed by network passphrase: if the user switches networks in
 * Freighter the clients are recreated with the new executor so all subsequent
 * transactions carry the correct passphrase.
 */

import {
  OracleClient,
  VaultClient,
  PerpEngineClient,
  FundingClient,
  RiskClient,
  StructuredClient,
  BridgeClient,
  GovernorClient,
  TreasuryClient,
  ClobClient,
  StakingClient,
  RwaIssuerClient,
} from "@stellax/sdk";
import { config } from "@/config";
import { getExecutor } from "./executor";

interface Clients {
  oracle: OracleClient;
  vault: VaultClient;
  perpEngine: PerpEngineClient;
  funding: FundingClient;
  risk: RiskClient;
  structured: StructuredClient;
  bridge: BridgeClient;
  governor: GovernorClient;
  treasury: TreasuryClient;
  /** Phase B. May be a stub client (empty contract id) until deployed. */
  clob: ClobClient;
  /** Phase F. May be a stub client (empty contract id) until deployed. */
  staking: StakingClient;
  /** Phase M. Per-asset RWA issuer client factory. */
  rwaIssuer: (contractId: string) => RwaIssuerClient;
}

let _cache: Clients | null = null;
let _cachePassphrase: string | null = null;

export function getClients(passphrase: string = config.network.passphrase): Clients {
  if (_cache !== null && passphrase === _cachePassphrase) return _cache;
  const exec = getExecutor(passphrase);
  _cache = {
    oracle: new OracleClient(config.contracts.oracle, exec),
    vault: new VaultClient(config.contracts.vault, exec),
    perpEngine: new PerpEngineClient(config.contracts.perpEngine, exec),
    funding: new FundingClient(config.contracts.funding, exec),
    risk: new RiskClient(config.contracts.risk, exec),
    structured: new StructuredClient(config.contracts.structured, exec),
    bridge: new BridgeClient(config.contracts.bridge, exec),
    governor: new GovernorClient(config.contracts.governor, exec),
    treasury: new TreasuryClient(config.contracts.treasury, exec),
    clob: new ClobClient(config.contracts.clob, exec),
    staking: new StakingClient(config.contracts.staking, exec),
    rwaIssuer: (contractId: string) => new RwaIssuerClient(contractId, exec),
  };
  _cachePassphrase = passphrase;
  return _cache;
}
