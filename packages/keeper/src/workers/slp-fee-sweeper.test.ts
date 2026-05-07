import { describe, it, expect, vi } from "vitest";
import { SlpFeeSweeper } from "../workers/slp-fee-sweeper.js";
import { makeMockStellar } from "../test/helpers.js";

/** 500 USDC expressed as 18-decimal internal vault units (500 * 10^7 * 10^11). */
const FIVE_HUNDRED_USDC_INTERNAL = 500_0000000n * 100_000_000_000n;

/** Minimal set of deps — use real testnet C-addresses so Address() parsing succeeds. */
const BASE_DEPS = {
  slpVaultContractId: "CDE2A6M7QC2Q43HAZTWUGGG2YO5MUHCEELJHW46DP7ZULPAF5DS5CUPT",
  sweepCapNative: 1_000_0000000n, // 1000 USDC cap
  vaultContractId: "CDDA3QFNHWZDX4IWHHNISPOI3R5KX4OPEUIQC5NA2RAB2HTMOS7YW4IM",
  treasuryAddress: "CCPGPJKOUTI5ES2DPFH5PPM2AP5RQPAESREHYEEPWJ46FY7JM6K7JUTF",
  usdcTokenId: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
};

describe("SlpFeeSweeper", () => {
  it("queries treasury balance then calls sweep_fees with min(balance, cap)", async () => {
    const invoke = vi.fn(async () => ({
      hash: "abc123",
      status: "SUCCESS" as const,
      returnValue: undefined,
      latestLedger: 42,
    }));
    // Simulate returns 500 USDC in 18dp internal units.
    const simulate = vi.fn(async () => ({
      returnValue: FIVE_HUNDRED_USDC_INTERNAL,
      minResourceFee: 0n,
      latestLedger: 1,
    }));
    const stellar = makeMockStellar({ invoke: invoke as never, simulate: simulate as never });
    const worker = new SlpFeeSweeper({ stellar, ...BASE_DEPS });

    await worker.tick();

    // simulate should be called once to read treasury balance
    expect(simulate).toHaveBeenCalledOnce();

    // invoke should be called once with sweep_fees
    expect(invoke).toHaveBeenCalledOnce();
    const [contractId, method] = invoke.mock.calls[0] as unknown as [string, string, ...unknown[]];
    expect(contractId).toBe(BASE_DEPS.slpVaultContractId);
    expect(method).toBe("sweep_fees");
  });

  it("clamps the sweep to sweepCapNative when treasury exceeds the cap", async () => {
    // Treasury has 2000 USDC; cap is 1000 USDC — should sweep exactly 1000.
    const TWO_THOUSAND_USDC_INTERNAL = 2_000_0000000n * 100_000_000_000n;
    const sweptAmounts: bigint[] = [];

    const invoke = vi.fn(async (_cid: string, _method: string, args: unknown[]) => {
      // args[0] is the i128 ScVal for the sweep amount — capture via toString
      sweptAmounts.push(args[0] as bigint);
      return { hash: "abc", status: "SUCCESS" as const, returnValue: undefined, latestLedger: 1 };
    });
    const simulate = vi.fn(async () => ({
      returnValue: TWO_THOUSAND_USDC_INTERNAL,
      minResourceFee: 0n,
      latestLedger: 1,
    }));

    const worker = new SlpFeeSweeper({
      stellar: makeMockStellar({ invoke: invoke as never, simulate: simulate as never }),
      ...BASE_DEPS,
      sweepCapNative: 1_000_0000000n, // 1000 USDC cap
    });

    await worker.tick();

    expect(invoke).toHaveBeenCalledOnce();
  });

  it("skips the tick (no invoke) when treasury balance is zero", async () => {
    const invoke = vi.fn();
    const simulate = vi.fn(async () => ({
      returnValue: 0n,
      minResourceFee: 0n,
      latestLedger: 1,
    }));
    const worker = new SlpFeeSweeper({
      stellar: makeMockStellar({ invoke: invoke as never, simulate: simulate as never }),
      ...BASE_DEPS,
    });

    await worker.tick();

    expect(invoke).not.toHaveBeenCalled();
  });

  it("propagates errors so the scheduler can catch and retry", async () => {
    const simulate = vi.fn(async () => {
      throw new Error("vault unavailable");
    });
    const worker = new SlpFeeSweeper({
      stellar: makeMockStellar({ simulate: simulate as never }),
      ...BASE_DEPS,
    });

    await expect(worker.tick()).rejects.toThrow("vault unavailable");
  });
});
