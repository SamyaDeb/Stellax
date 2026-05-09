/**
 * Phase W — Passkey / SEP-10 web-auth helpers.
 *
 * StellaX supports two authentication paths:
 *   • **Freighter / hardware wallet** — direct Soroban tx signing.
 *   • **Passkey (WebAuthn → Stellar Smart-Wallet)** — keyless onboarding
 *     where the user's passkey signs a Soroban auth payload that the
 *     contract verifies via `__check_auth`.
 *
 * This module exposes minimal SEP-10 challenge helpers used by the
 * frontend's keeper-relayed sign-in flow. Full passkey wallet
 * integration is delivered through the user-side library
 * (`packages/frontend/src/wallet/passkey.ts`) which composes these
 * helpers; here we only expose the wire-format primitives.
 */

import {
  TransactionBuilder,
  type FeeBumpTransaction,
  type Networks,
  type Transaction,
} from "@stellar/stellar-sdk";

/**
 * Decode a SEP-10 challenge transaction returned by an anchor and
 * verify its envelope structure (network passphrase, source account
 * is the anchor, sequence is 0).
 *
 * Returns the parsed transaction so the caller can sign it with the
 * client account key. Throws on malformed envelopes.
 */
export function decodeSep10Challenge(
  challengeXdr: string,
  networkPassphrase: Networks | string,
  expectedAnchorAccount: string,
): Transaction | FeeBumpTransaction {
  const tx = TransactionBuilder.fromXDR(
    challengeXdr,
    networkPassphrase as string,
  );
  if ("innerTransaction" in tx) {
    throw new Error("SEP-10 challenge must be a regular transaction");
  }
  if (tx.source !== expectedAnchorAccount) {
    throw new Error(
      `SEP-10 challenge source ${tx.source} ≠ expected ${expectedAnchorAccount}`,
    );
  }
  if (tx.sequence !== "0") {
    throw new Error(`SEP-10 challenge must have sequence 0, got ${tx.sequence}`);
  }
  return tx;
}

/** Produce the JSON body the frontend POSTs to `/auth/token`. */
export function buildSep10TokenRequest(signedChallengeXdr: string): {
  transaction: string;
} {
  return { transaction: signedChallengeXdr };
}
