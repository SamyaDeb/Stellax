/**
 * Phase W — Stellar Classic path-payment helpers.
 *
 * These helpers complement the Soroban contract clients by exposing
 * Stellar-native primitives that StellaX users want for fast, low-cost
 * deposits & swaps using the Stellar DEX:
 *
 *   • `buildPathPaymentStrictReceive` — atomic XLM/USDC → vault deposit
 *     where the user supplies any source asset and the network finds a
 *     path that delivers the requested vault collateral exactly.
 *
 *   • `buildPathPaymentStrictSend` — best-effort swap of a fixed source
 *     amount into the requested destination asset (used by the
 *     "deposit anything" frontend flow).
 *
 * These are pure transaction builders — they do NOT submit. The frontend
 * (Freighter / passkey) signs and submits via Horizon.
 */

import {
  Asset,
  Memo,
  Operation,
  TransactionBuilder,
  type Account,
  type Networks,
} from "@stellar/stellar-sdk";

export interface PathPaymentReceiveArgs {
  /** Loaded source account (Horizon). */
  source: Account;
  /** Network passphrase, e.g. `Networks.TESTNET`. */
  networkPassphrase: Networks | string;
  /** Base fee in stroops (defaults to 1_000_000 = 0.1 XLM). */
  baseFee?: string;
  /** Asset the user is paying with. Use `Asset.native()` for XLM. */
  sendAsset: Asset;
  /** Maximum the user is willing to spend (string of decimal units). */
  sendMax: string;
  /** Recipient — typically the vault SAC contract or the user themselves. */
  destination: string;
  /** Destination asset to deliver (e.g. USDC issued by Circle). */
  destAsset: Asset;
  /** Exact destination amount the recipient must receive. */
  destAmount: string;
  /** Optional intermediate hops returned by Horizon's strict-receive path endpoint. */
  path?: Asset[];
  /** Optional memo (e.g. `userId:<G-addr>` for keeper attribution). */
  memo?: string;
}

export function buildPathPaymentStrictReceive(args: PathPaymentReceiveArgs) {
  const builder = new TransactionBuilder(args.source, {
    fee: args.baseFee ?? "1000000",
    networkPassphrase: args.networkPassphrase as string,
  })
    .addOperation(
      Operation.pathPaymentStrictReceive({
        sendAsset: args.sendAsset,
        sendMax: args.sendMax,
        destination: args.destination,
        destAsset: args.destAsset,
        destAmount: args.destAmount,
        path: args.path ?? [],
      }),
    )
    .setTimeout(180);
  if (args.memo) builder.addMemo(Memo.text(args.memo.slice(0, 28)));
  return builder.build();
}

export interface PathPaymentSendArgs {
  source: Account;
  networkPassphrase: Networks | string;
  baseFee?: string;
  sendAsset: Asset;
  sendAmount: string;
  destination: string;
  destAsset: Asset;
  /** Minimum acceptable destination amount (slippage guard). */
  destMin: string;
  path?: Asset[];
  memo?: string;
}

export function buildPathPaymentStrictSend(args: PathPaymentSendArgs) {
  const builder = new TransactionBuilder(args.source, {
    fee: args.baseFee ?? "1000000",
    networkPassphrase: args.networkPassphrase as string,
  })
    .addOperation(
      Operation.pathPaymentStrictSend({
        sendAsset: args.sendAsset,
        sendAmount: args.sendAmount,
        destination: args.destination,
        destAsset: args.destAsset,
        destMin: args.destMin,
        path: args.path ?? [],
      }),
    )
    .setTimeout(180);
  if (args.memo) builder.addMemo(Memo.text(args.memo.slice(0, 28)));
  return builder.build();
}
