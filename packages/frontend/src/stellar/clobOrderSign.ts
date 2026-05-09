/**
 * Off-chain Ed25519 signature helpers for CLOB limit orders.
 *
 * The CLOB contract stores a `signature` field in each `LimitOrder` for the
 * keeper relayer to verify off-chain (the contract itself only checks that
 * `trader` authorised the invocation, not the signature bytes).
 *
 * Canonical hash layout (mirrors `order_canonical_hash` in Rust):
 *   order_id(8) | market_id(4) | size(16) | price(16) |
 *   is_long(1)  | leverage(4)  | expiry(8) | nonce(8)
 *   Total = 65 bytes → SHA-256 → 32 bytes
 *
 * The `order_id` is 0n at placement time (the contract assigns it on-chain).
 *
 * Signing flow:
 *   1. Build canonical 65-byte buffer with all order fields.
 *   2. SHA-256 hash → 32 bytes (Web Crypto API).
 *   3. Hex-encode and pass to Freighter `signMessage`.
 *   4. Parse the returned signature bytes.
 *   5. Fall back to the 64-byte zero reserved signature if signing fails
 *      (the CLOB contract accepts zeros as a reserved/keeper-only mode).
 */

import { signMessage } from "@stellar/freighter-api";

export interface OrderParams {
  /** On-chain order ID — use 0n at placement (server will assign). */
  orderId: bigint;
  marketId: number;
  /** Position size, 18-decimal base units (i128). */
  size: bigint;
  /** Limit price, 18-decimal USD (i128). */
  price: bigint;
  isLong: boolean;
  leverage: number;
  /** Ledger Unix timestamp at which the order expires. */
  expiry: bigint;
  /** Monotonically increasing trader nonce. */
  nonce: bigint;
}

/**
 * Builds the canonical 65-byte payload and returns its SHA-256 hash,
 * mirroring the Rust `order_canonical_hash` function in `stellax-clob`.
 */
export async function buildOrderCanonicalHash(p: OrderParams): Promise<Uint8Array> {
  const buf = new Uint8Array(65);
  const view = new DataView(buf.buffer);
  let off = 0;

  // order_id — 8 bytes BE u64
  view.setBigUint64(off, p.orderId, false);
  off += 8;

  // market_id — 4 bytes BE u32
  view.setUint32(off, p.marketId, false);
  off += 4;

  // size — 16 bytes BE i128 (high word then low word)
  const sizeHi = BigInt.asUintN(64, p.size >> 64n);
  const sizeLo = BigInt.asUintN(64, p.size);
  view.setBigUint64(off, sizeHi, false); off += 8;
  view.setBigUint64(off, sizeLo, false); off += 8;

  // price — 16 bytes BE i128
  const priceHi = BigInt.asUintN(64, p.price >> 64n);
  const priceLo = BigInt.asUintN(64, p.price);
  view.setBigUint64(off, priceHi, false); off += 8;
  view.setBigUint64(off, priceLo, false); off += 8;

  // is_long — 1 byte
  buf[off++] = p.isLong ? 1 : 0;

  // leverage — 4 bytes BE u32
  view.setUint32(off, p.leverage, false);
  off += 4;

  // expiry — 8 bytes BE u64
  view.setBigUint64(off, p.expiry, false);
  off += 8;

  // nonce — 8 bytes BE u64
  view.setBigUint64(off, p.nonce, false);
  // off += 8 — 65 bytes total, done.

  const hashBuf = await crypto.subtle.digest("SHA-256", buf);
  return new Uint8Array(hashBuf);
}

/**
 * Signs the given 32-byte order hash via Freighter's `signMessage` and
 * returns the raw 64-byte Ed25519 signature.
 *
 * If signing fails for any reason (wallet not connected, user rejects,
 * Freighter version doesn't support `signMessage`) the function returns the
 * 64-byte zero reserved signature instead of throwing, so callers can submit
 * the order and the keeper can decide how to handle the missing signature.
 */
export async function signOrderHash(
  hash: Uint8Array,
  address: string,
  networkPassphrase: string,
): Promise<Uint8Array> {
  try {
    // Freighter signMessage takes a string; pass the hash as lowercase hex.
    const hexHash = Array.from(hash)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const result = await signMessage(hexHash, {
      address,
      networkPassphrase,
    });

    if (result.error) {
      // User rejected or wallet error.
      return new Uint8Array(64);
    }

    const signed = result.signedMessage;
    if (!signed) return new Uint8Array(64);

    // Freighter v4 returns a base64 string; v3 returns a Buffer.
    if (typeof signed === "string") {
      const bytes = Uint8Array.from(atob(signed), (c) => c.charCodeAt(0));
      if (bytes.length === 64) return bytes;
    } else {
      // Buffer (Freighter v3)
      const bytes = new Uint8Array(signed);
      if (bytes.length === 64) return bytes;
    }
  } catch {
    // signMessage unsupported or threw — fall through to zero signature.
  }

  return new Uint8Array(64); // reserved zero signature accepted by contract
}
