// ── ScVal builder helpers ─────────────────────────────────────────────────────
//
// Mirrors packages/deployer/src/sdkinvoke.ts but extended for e2e needs:
// reads, custom signers (not just stellar-cli identities), and strongly-typed
// decoders for result ScVals.

import {
  Address,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

export function addrVal(s: string): xdr.ScVal {
  return new Address(s).toScVal();
}

export function u32Val(n: number): xdr.ScVal {
  return xdr.ScVal.scvU32(n);
}

export function u64Val(n: number | bigint): xdr.ScVal {
  return xdr.ScVal.scvU64(xdr.Uint64.fromString(BigInt(n).toString()));
}

export function i128Val(n: bigint | number | string): xdr.ScVal {
  return nativeToScVal(BigInt(n), { type: "i128" });
}

export function boolVal(b: boolean): xdr.ScVal {
  return xdr.ScVal.scvBool(b);
}

export function symbolVal(s: string): xdr.ScVal {
  return xdr.ScVal.scvSymbol(Buffer.from(s, "utf8"));
}

export function stringVal(s: string): xdr.ScVal {
  return xdr.ScVal.scvString(Buffer.from(s, "utf8"));
}

export function bytesVal(b: Buffer | Uint8Array): xdr.ScVal {
  return xdr.ScVal.scvBytes(Buffer.from(b));
}

export function vecVal(items: xdr.ScVal[]): xdr.ScVal {
  return xdr.ScVal.scvVec(items);
}

/** ScvMap with lex-sorted symbol keys (Soroban requires this). */
export function mapVal(entries: [string, xdr.ScVal][]): xdr.ScVal {
  const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return xdr.ScVal.scvMap(
    sorted.map(
      ([k, v]) =>
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol(Buffer.from(k, "utf8")),
          val: v,
        }),
    ),
  );
}

/** Decode a ScVal result back to a native JS value. */
export function fromScVal<T = unknown>(v: xdr.ScVal): T {
  return scValToNative(v) as T;
}
