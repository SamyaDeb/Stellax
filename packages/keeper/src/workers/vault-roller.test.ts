import { describe, it, expect, vi } from "vitest";
import { VaultRoller } from "../workers/vault-roller.js";
import { makeMockStellar } from "../test/helpers.js";

describe("VaultRoller", () => {
  it("rolls epoch when current time >= epochEnd", async () => {
    const invoke = vi.fn(async () => ({
      hash: "h",
      status: "SUCCESS" as const,
      returnValue: undefined,
      latestLedger: 1,
    }));
    const past = Math.floor(Date.now() / 1000) - 10;
    const worker = new VaultRoller({
      stellar: makeMockStellar({ invoke: invoke as never }),
      vaultIds: ["CV1"],
      schedule: { async getCurrentEpochEnd() { return past; } },
    });
    await worker.tick();
    expect(invoke).toHaveBeenCalledTimes(1);
    const args = invoke.mock.calls[0] as unknown as unknown[];
    expect(args[0]).toBe("CV1");
    expect(args[1]).toBe("roll_epoch");
  });

  it("skips when epoch has not ended", async () => {
    const invoke = vi.fn();
    const future = Math.floor(Date.now() / 1000) + 3600;
    const worker = new VaultRoller({
      stellar: makeMockStellar({ invoke: invoke as never }),
      vaultIds: ["CV1"],
      schedule: { async getCurrentEpochEnd() { return future; } },
    });
    await worker.tick();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("skips when no vaults are configured", async () => {
    const invoke = vi.fn();
    const schedule = { getCurrentEpochEnd: vi.fn() };
    const worker = new VaultRoller({
      stellar: makeMockStellar({ invoke: invoke as never }),
      vaultIds: [],
      schedule,
    });
    await worker.tick();
    expect(invoke).not.toHaveBeenCalled();
    expect(schedule.getCurrentEpochEnd).not.toHaveBeenCalled();
  });

  it("continues to next vault when one roll fails", async () => {
    const invoke = vi.fn(async (id: string) => {
      if (id === "CV1") throw new Error("boom");
      return {
        hash: "h",
        status: "SUCCESS" as const,
        returnValue: undefined,
        latestLedger: 1,
      };
    });
    const past = Math.floor(Date.now() / 1000) - 10;
    const worker = new VaultRoller({
      stellar: makeMockStellar({ invoke: invoke as never }),
      vaultIds: ["CV1", "CV2"],
      schedule: { async getCurrentEpochEnd() { return past; } },
    });
    await worker.tick();
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
