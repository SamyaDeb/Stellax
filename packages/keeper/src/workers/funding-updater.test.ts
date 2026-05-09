import { describe, it, expect, vi } from "vitest";
import { FundingUpdater } from "../workers/funding-updater.js";
import { makeMockStellar } from "../test/helpers.js";

describe("FundingUpdater", () => {
  it("invokes update_funding for each configured market", async () => {
    const invoke = vi.fn(async () => ({
      hash: "h",
      status: "SUCCESS" as const,
      returnValue: undefined,
      latestLedger: 1,
    }));
    const stellar = makeMockStellar({ invoke: invoke as never });
    const worker = new FundingUpdater({
      stellar,
      fundingContractId: "CFUND",
      marketIds: [1, 2, 3],
    });
    await worker.tick();
    expect(invoke).toHaveBeenCalledTimes(3);
    for (const call of invoke.mock.calls) {
      const args = call as unknown as unknown[];
      expect(args[1]).toBe("update_funding");
    }
  });

  it("continues past per-market failures", async () => {
    let call = 0;
    const invoke = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error("market 1 failed");
      return {
        hash: "h",
        status: "SUCCESS" as const,
        returnValue: undefined,
        latestLedger: 1,
      };
    });
    const worker = new FundingUpdater({
      stellar: makeMockStellar({ invoke: invoke as never }),
      fundingContractId: "CFUND",
      marketIds: [1, 2],
    });
    // Should not throw — partial success is OK.
    await worker.tick();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("throws when all markets fail", async () => {
    const worker = new FundingUpdater({
      stellar: makeMockStellar({
        invoke: (async () => {
          throw new Error("rpc down");
        }) as never,
      }),
      fundingContractId: "CFUND",
      marketIds: [1, 2],
    });
    await expect(worker.tick()).rejects.toThrow(/all 2 funding updates failed/);
  });
});
