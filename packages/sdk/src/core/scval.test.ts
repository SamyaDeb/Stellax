import { describe, it, expect } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
import { enc, dec, structs } from "./scval.js";

describe("enc", () => {
  it("encodes u32", () => {
    const v = enc.u32(42);
    expect(v.switch().name).toBe("scvU32");
    expect(v.u32()).toBe(42);
  });

  it("encodes i128 from bigint and number", () => {
    const a = enc.i128(12345n);
    const b = enc.i128(12345);
    expect(a.switch().name).toBe("scvI128");
    expect(b.switch().name).toBe("scvI128");
  });

  it("encodes u64 from bigint", () => {
    const v = enc.u64(9_000_000_000n);
    expect(v.switch().name).toBe("scvU64");
  });

  it("encodes symbol, string, bool, bytes", () => {
    expect(enc.symbol("BTC").switch().name).toBe("scvSymbol");
    expect(enc.string("hi").switch().name).toBe("scvString");
    expect(enc.bool(true).switch().name).toBe("scvBool");
    expect(enc.bytes(new Uint8Array([1, 2, 3])).switch().name).toBe("scvBytes");
  });

  it("encodes vec of scvals", () => {
    const v = enc.vec([enc.u32(1), enc.u32(2)]);
    expect(v.switch().name).toBe("scvVec");
    expect(v.vec()?.length).toBe(2);
  });

  it("encodes Rust enum unit variant as [symbol]", () => {
    const v = enc.marginMode("Cross");
    expect(v.switch().name).toBe("scvVec");
    expect(v.vec()?.[0]?.sym().toString()).toBe("Cross");
  });
});

describe("dec", () => {
  it("decodes bigint", () => {
    const v = enc.i128(100n);
    expect(dec.bigint(v)).toBe(100n);
  });

  it("decodes bool", () => {
    expect(dec.bool(enc.bool(true))).toBe(true);
    expect(dec.bool(enc.bool(false))).toBe(false);
  });

  it("decodes vec with mapper", () => {
    const v = enc.vec([enc.u32(1), enc.u32(2), enc.u32(3)]);
    const out = dec.vec(v, (item) => dec.number(item));
    expect(out).toEqual([1, 2, 3]);
  });

  it("round-trips MarginMode", () => {
    expect(dec.marginMode(enc.marginMode("Cross"))).toBe("Cross");
    expect(dec.marginMode(enc.marginMode("Isolated"))).toBe("Isolated");
  });
});

describe("structs.priceData", () => {
  it("decodes a map into a typed PriceData", () => {
    const map = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("price"),
        val: enc.i128(123_456n),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("package_timestamp"),
        val: enc.u64(1000n),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("write_timestamp"),
        val: enc.u64(1001n),
      }),
    ]);
    const out = structs.priceData(map);
    expect(out.price).toBe(123_456n);
    expect(out.packageTimestamp).toBe(1000n);
    expect(out.writeTimestamp).toBe(1001n);
  });
});
