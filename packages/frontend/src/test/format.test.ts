import { describe, it, expect } from "vitest";
import {
  fromFixed,
  toFixed,
  formatUsd,
  formatNumber,
  formatPct,
  shortAddress,
} from "../ui/format";

describe("format · fixed-point conversions", () => {
  it("fromFixed: round-trip of whole numbers", () => {
    expect(fromFixed(toFixed("1"))).toBe(1);
    expect(fromFixed(toFixed("1000"))).toBe(1000);
    expect(fromFixed(toFixed("0"))).toBe(0);
  });

  it("fromFixed: handles fractional precision", () => {
    expect(fromFixed(toFixed("1.5"))).toBeCloseTo(1.5, 6);
    expect(fromFixed(toFixed("0.0001"))).toBeCloseTo(0.0001, 6);
  });

  it("fromFixed: handles negative values", () => {
    expect(fromFixed(toFixed("-5.25"))).toBeCloseTo(-5.25, 6);
  });

  it("toFixed: rejects NaN, empty, whitespace", () => {
    expect(toFixed("")).toBe(0n);
    expect(toFixed("   ")).toBe(0n);
    expect(toFixed("abc")).toBe(0n);
  });

  it("toFixed: truncates extra decimals (does not round)", () => {
    // 1.234567890123456789012345 → keep 18 digits
    const v = toFixed("1.234567890123456789999");
    // 1.234567890123456789 × 1e18 = 1234567890123456789n
    expect(v).toBe(1234567890123456789n);
  });
});

describe("format · display helpers", () => {
  it("formatUsd: renders bigints with currency", () => {
    const s = formatUsd(toFixed("1234.56"));
    expect(s).toContain("1,234.56");
    expect(s).toContain("$");
  });

  it("formatUsd: accepts plain numbers", () => {
    expect(formatUsd(100)).toContain("100.00");
  });

  it("formatNumber: non-currency grouped formatting", () => {
    const s = formatNumber(toFixed("1000.125"), 2);
    expect(s).toContain("1,000.1");
  });

  it("formatPct: interprets fractions as percents", () => {
    expect(formatPct(0.05, 2)).toBe("5.00%");
    expect(formatPct(-0.012, 2)).toBe("-1.20%");
  });

  it("formatPct: interprets bigints as bps (10000 = 100%)", () => {
    expect(formatPct(5000n)).toBe("50.00%");
    expect(formatPct(10_000n)).toBe("100.00%");
  });

  it("shortAddress: abbreviates long addresses", () => {
    const addr = "GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    expect(shortAddress(addr)).toBe("GABC…7890");
  });

  it("shortAddress: returns short values unchanged", () => {
    expect(shortAddress("GABC")).toBe("GABC");
  });
});
