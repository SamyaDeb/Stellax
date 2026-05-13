/**
 * @stellax/sdk — TypeScript client library for the StellaX derivatives
 * protocol on Stellar/Soroban.
 *
 * The SDK is transport- and wallet-agnostic. Consumers inject an
 * `InvocationExecutor` — a minimal async interface that knows how to
 * simulate reads and build/sign/send write transactions. The frontend
 * implements this against Freighter + `@stellar/stellar-sdk`'s rpc module.
 *
 * Every contract listed in the StellaX implementation plan has its own
 * typed client exported from this package. All methods are strictly typed
 * against the Rust contract ABI extracted in Phase 12 prep.
 */

export * from "./core/types.js";
export * from "./core/scval.js";
export * from "./core/executor.js";
export * from "./core/client.js";

export { OracleClient } from "./clients/oracle.js";
export { fetchPythVaa } from "./clients/oracle.js";
export { VaultClient } from "./clients/vault.js";
export { PerpEngineClient } from "./clients/perp-engine.js";
export { FundingClient } from "./clients/funding.js";
export { RiskClient, type AccountHealth, type LiquidationOutcome, type PortfolioHealth, type PortfolioGreeks } from "./clients/risk.js";
export { StructuredClient, type EpochState } from "./clients/structured.js";
export { BridgeClient, type BridgeConfig } from "./clients/bridge.js";
export { GovernorClient, type GovernanceActionVariant, type GovernorProposal } from "./clients/governor.js";
export { TreasuryClient } from "./clients/treasury.js";
export {
  ClobClient,
  type LimitOrder,
  type OrderStatus,
  type ClobConfig,
} from "./clients/clob.js";
export {
  StakingClient,
  type StakingConfig,
  type StakeEntry,
  type EpochRewardPool,
} from "./clients/staking.js";
export {
  RwaIssuerClient,
  type RwaIssuerConfig,
} from "./clients/rwa-issuer.js";
export { SlpVaultClient } from "./clients/slp-vault.js";
export type { SlpConfig } from "./clients/slp-vault.js";

// Phase W — Stellar-native primitives (path payments, claimable balances, SEP-10).
export * as stellarNative from "./stellar/index.js";

// Bridge — Axelar GMP helpers (shared between keeper & frontend).
export {
  decodeDepositPayload,
  fetchBridgeDeposits,
} from "./bridge/axelar-gmp.js";
export type {
  GmpEvent,
  GmpSearchResponse,
  DecodedBridgeDeposit,
  FetchBridgeDepositsOptions,
} from "./bridge/axelar-gmp.js";
