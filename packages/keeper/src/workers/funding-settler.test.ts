import { describe, it, expect, vi } from "vitest";
import {
  FundingSettler,
} from "../workers/funding-settler.js";
import type { PositionSource, PositionLike } from "../workers/liquidation-bot.js";
import { makeMockStellar } from "../test/helpers.js";

const makePositions = (xs: PositionLike[]): PositionSource => ({
  async getOpenPositions() {
    return xs;
  },
});

describe("FundingSettler", () => {
  it("calls settle_funding_for_position for each open position", async () => {
    const invoke = vi.fn(async () => ({
      hash: "h",
      status: "SUCCESS" as const,
      returnValue: undefined,
      latestLedger: 1,
    }));
    const stellar = makeMockStellar({ invoke: invoke as never });
    const worker = new FundingSettler({
      stellar,
      fundingContractId: "CFUNDING",
      positions: makePositions([
        { positionId: 1n, user: "GAAA", marketId: 1 },
        { positionId: 2n, user: "GBBB", marketId: 2 },
        { positionId: 3n, user: "GCCC", marketId: 3 },
      ]),
    });

    await worker.tick();

    expect(invoke).toHaveBeenCalledTimes(3);
    for (const call of invoke.mock.calls) {
      const [contractId, method] = call as unknown as [string, string, ...unknown[]];
      expect(contractId).toBe("CFUNDING");
      expect(method).toBe("settle_funding_for_position");
    }
  });

  it("does nothing when there are no open positions", async () => {
    const invoke = vi.fn();
    const worker = new FundingSettler({
      stellar: makeMockStellar({ invoke: invoke as never }),
      fundingContractId: "CFUNDING",
      positions: makePositions([]),
    });

    await worker.tick();

    expect(invoke).not.toHaveBeenCalled();
  });

  it("continues settling remaining positions when one fails", async () => {
    let call = 0;
    const invoke = vi.fn(async () => {
      call += 1;
      if (call === 2) throw new Error("position 2 failed");
      return {
        hash: "h",
        status: "SUCCESS" as const,
        returnValue: undefined,
        latestLedger: 1,
      };
    });
    const worker = new FundingSettler({
      stellar: makeMockStellar({ invoke: invoke as never }),
      fundingContractId: "CFUNDING",
      positions: makePositions([
        { positionId: 1n, user: "GAAA", marketId: 1 },
        { positionId: 2n, user: "GBBB", marketId: 2 },
        { positionId: 3n, user: "GCCC", marketId: 3 },
      ]),
    });

    // Should not throw — per-position errors are isolated.
    await expect(worker.tick()).resolves.toBeUndefined();
    // All three positions were attempted.
    expect(invoke).toHaveBeenCalledTimes(3);
  });
});
