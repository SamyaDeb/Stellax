/**
 * Phase W — Stellar Classic claimable-balance helpers.
 *
 * Used for the "scheduled payout" pattern: keepers create claimable
 * balances on perp / option PnL settlement that the recipient can claim
 * at their convenience without paying base reserve up-front.
 *
 * Pure builders — the frontend signs & submits.
 */

import {
  Asset,
  Claimant,
  Operation,
  TransactionBuilder,
  type Account,
  type Networks,
} from "@stellar/stellar-sdk";

export interface CreateClaimableBalanceArgs {
  source: Account;
  networkPassphrase: Networks | string;
  baseFee?: string;
  asset: Asset;
  amount: string;
  /** Claimants. Use `Claimant.predicateUnconditional()` for "anyone, anytime". */
  claimants: Claimant[];
}

export function buildCreateClaimableBalance(args: CreateClaimableBalanceArgs) {
  return new TransactionBuilder(args.source, {
    fee: args.baseFee ?? "1000000",
    networkPassphrase: args.networkPassphrase as string,
  })
    .addOperation(
      Operation.createClaimableBalance({
        asset: args.asset,
        amount: args.amount,
        claimants: args.claimants,
      }),
    )
    .setTimeout(180)
    .build();
}

export interface ClaimClaimableBalanceArgs {
  source: Account;
  networkPassphrase: Networks | string;
  baseFee?: string;
  /** Balance ID returned by Horizon (`balanceId.startsWith("00000000")`). */
  balanceId: string;
}

export function buildClaimClaimableBalance(args: ClaimClaimableBalanceArgs) {
  return new TransactionBuilder(args.source, {
    fee: args.baseFee ?? "1000000",
    networkPassphrase: args.networkPassphrase as string,
  })
    .addOperation(Operation.claimClaimableBalance({ balanceId: args.balanceId }))
    .setTimeout(180)
    .build();
}
