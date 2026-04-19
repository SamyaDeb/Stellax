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
export { VaultClient } from "./clients/vault.js";
export { PerpEngineClient } from "./clients/perp-engine.js";
export { FundingClient } from "./clients/funding.js";
export { RiskClient, type AccountHealth, type LiquidationOutcome } from "./clients/risk.js";
export { OptionsClient, type VolSurface } from "./clients/options.js";
export { StructuredClient, type EpochState } from "./clients/structured.js";
export { BridgeClient, type BridgeConfig } from "./clients/bridge.js";
export { GovernorClient, type GovernanceActionVariant, type GovernorProposal } from "./clients/governor.js";
export { TreasuryClient } from "./clients/treasury.js";
