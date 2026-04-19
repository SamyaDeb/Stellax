/**
 * Shared StellaX domain types.
 *
 * All numeric money values are 18-decimal fixed-point (`PRECISION = 10^18`)
 * and represented as `bigint` across the SDK. Values labelled "bps" are
 * basis points (divisor = 10_000).
 */

export const PRECISION = 10n ** 18n;
export const BPS_DENOMINATOR = 10_000n;

/** Oracle price reading, 18-dec. */
export interface PriceData {
  price: bigint;
  packageTimestamp: bigint;
  writeTimestamp: bigint;
}

/** Perp market definition. */
export interface Market {
  marketId: number;
  baseAsset: string;
  quoteAsset: string;
  maxLeverage: number;
  makerFeeBps: number;
  takerFeeBps: number;
  maxOiLong: bigint;
  maxOiShort: bigint;
  isActive: boolean;
}

/** Perp position. */
export interface Position {
  owner: string;
  marketId: number;
  size: bigint;
  entryPrice: bigint;
  margin: bigint;
  leverage: number;
  isLong: boolean;
  lastFundingIdx: bigint;
  openTimestamp: bigint;
}

/** Aggregate open interest on a market. */
export interface OpenInterest {
  long: bigint;
  short: bigint;
}

/** Vault user balance breakdown. */
export interface VaultBalance {
  free: bigint;
  locked: bigint;
}

/** Margin mode per user. */
export type MarginMode = "Cross" | "Isolated";

/** Option contract. */
export interface OptionContract {
  optionId: bigint;
  strike: bigint;
  expiry: bigint;
  isCall: boolean;
  size: bigint;
  premium: bigint;
  writer: string;
  holder: string;
  isExercised: boolean;
}

/** Structured vault epoch. */
export interface VaultEpoch {
  epochId: number;
  startTime: bigint;
  endTime: bigint;
  totalDeposits: bigint;
  totalPremium: bigint;
  settled: boolean;
}

/** Bridge deposit record. */
export interface BridgeDeposit {
  depositId: bigint;
  user: string;
  amount: bigint;
  destChain: string;
  destAddress: Uint8Array;
  released: boolean;
  timestamp: bigint;
}

/** Governance proposal. */
export interface Proposal {
  id: bigint;
  proposer: string;
  target: string;
  newWasmHash: Uint8Array;
  description: string;
  startTime: bigint;
  endTime: bigint;
  eta: bigint;
  forVotes: bigint;
  againstVotes: bigint;
  executed: boolean;
  canceled: boolean;
}

export type ProposalState =
  | "Pending"
  | "Active"
  | "Defeated"
  | "Succeeded"
  | "Queued"
  | "Executed"
  | "Canceled"
  | "Expired";

export interface Vote {
  support: boolean;
  weight: bigint;
}
