import { describe, it, expect, vi } from "vitest";
import {
  LiquidationBot,
  type PositionLike,
  type PositionSource,
} from "../workers/liquidation-bot.js";
import { makeMockStellar, makeMockAlerter } from "../test/helpers.js";

describe("LiquidationBot", () => {
  // Valid 56-char G-addresses for testing (Stellar Address constructor validates).
  const A = "GCRW6BBUCQB4AT4YZLGPI4WGB2GAPCQYWZPYPVKUNM2DI36K6YV3HOJD";
  const B = "GBAIDZICNOVW2C5EJYAIN3GT4I6FT7IIF335Y67E66IYSNF7ZVJYVL63";
  const C = "GA7GVFIKSAXIJ33OHDBVTB2RICVQQRRIQNJLENTNA3PIV7M6GRB5ERQ6";

  const makePositions = (xs: PositionLike[]): PositionSource => ({
    async getOpenPositions() {
      return xs;
    },
  });

  it("liquidates only unhealthy positions, ordered by margin ratio", async () => {
    const positions = makePositions([
      { positionId: 1n, user: A, marketId: 1 },
      { positionId: 2n, user: B, marketId: 1 },
      { positionId: 3n, user: C, marketId: 1 },
    ]);
    const health: Record<string, { marginRatioBps: number; liquidatable: boolean }> = {
      [A]: { marginRatioBps: 400, liquidatable: false }, // healthy
      [B]: { marginRatioBps: 50, liquidatable: true }, // most underwater
      [C]: { marginRatioBps: 120, liquidatable: true },
    };
    let simCall = 0;
    const users = [A, B, C];
    const simulate = vi.fn(async () => {
      const u = users[simCall++];
      return {
        returnValue: health[u],
        minResourceFee: 0n,
        latestLedger: 1,
      };
    });

    const invokeCalls: Array<{ method: string; args: unknown[] }> = [];
    const invoke = vi.fn(async (_c: string, method: string, args: unknown[]) => {
      invokeCalls.push({ method, args });
      return {
        hash: "h",
        status: "SUCCESS" as const,
        returnValue: undefined,
        latestLedger: 1,
      };
    });
    const stellar = makeMockStellar({
      simulate: simulate as never,
      invoke: invoke as never,
    });

    const worker = new LiquidationBot({
      stellar,
      riskContractId: "CRISK",
      positions,
      alerter: makeMockAlerter(),
      warningThresholdBps: 200,
    });
    await worker.tick();

    // Only B and C are liquidatable; expect two liquidate invocations.
    const liqs = invokeCalls.filter((c) => c.method === "liquidate");
    expect(liqs.length).toBe(2);
  });

  it("does nothing when no positions are open", async () => {
    const invoke = vi.fn();
    const worker = new LiquidationBot({
      stellar: makeMockStellar({ invoke: invoke as never }),
      riskContractId: "CRISK",
      positions: makePositions([]),
      alerter: makeMockAlerter(),
      warningThresholdBps: 200,
    });
    await worker.tick();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("alerts when liquidatable positions exist but all attempts fail", async () => {
    const positions = makePositions([
      { positionId: 1n, user: A, marketId: 1 },
    ]);
    const stellar = makeMockStellar({
      simulate: (async () => ({
        returnValue: { marginRatioBps: 10, liquidatable: true },
        minResourceFee: 0n,
        latestLedger: 1,
      })) as never,
      invoke: (async () => {
        throw new Error("race lost");
      }) as never,
    });
    const alerter = makeMockAlerter();
    const worker = new LiquidationBot({
      stellar,
      riskContractId: "CRISK",
      positions,
      alerter,
      warningThresholdBps: 200,
    });
    await worker.tick();
    expect(alerter.calls.length).toBe(1);
    expect(alerter.calls[0][0]).toBe("warn");
  });
});
