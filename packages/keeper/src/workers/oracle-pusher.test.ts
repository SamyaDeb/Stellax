import { describe, it, expect, vi } from "vitest";
import { OraclePusher } from "../workers/oracle-pusher.js";
import type { RedStoneFetcher } from "../redstone.js";
import { makeMockStellar, makeMockAlerter } from "../test/helpers.js";

describe("OraclePusher", () => {
  it("fetches payload and invokes write_prices", async () => {
    const invoke = vi.fn(async () => ({
      hash: "h1",
      status: "SUCCESS" as const,
      returnValue: undefined,
      latestLedger: 1,
    }));
    const stellar = makeMockStellar({ invoke: invoke as never });
    const fetcher: RedStoneFetcher = {
      fetch: vi.fn(async (feeds) => ({
        bytes: new Uint8Array([1, 2, 3]),
        feeds,
        timestampMs: Date.now(),
      })),
    };
    const alerter = makeMockAlerter();
    const worker = new OraclePusher({
      stellar,
      fetcher,
      alerter,
      oracleContractId: "CORACLE",
      feeds: ["BTC", "ETH"],
      stalenessAlertMs: 60_000,
    });

    await worker.tick();

    expect(fetcher.fetch).toHaveBeenCalledWith(["BTC", "ETH"]);
    expect(invoke).toHaveBeenCalledTimes(1);
    const args = invoke.mock.calls[0] as unknown as unknown[];
    expect(args[1]).toBe("write_prices");
    expect(alerter.calls.length).toBe(0);
  });

  it("skips cleanly when no feeds configured", async () => {
    const fetcher: RedStoneFetcher = {
      fetch: vi.fn(async () => {
        throw new Error("should not be called");
      }),
    };
    const worker = new OraclePusher({
      stellar: makeMockStellar(),
      fetcher,
      alerter: makeMockAlerter(),
      oracleContractId: "CORACLE",
      feeds: [],
      stalenessAlertMs: 60_000,
    });
    await worker.tick();
    expect(fetcher.fetch).not.toHaveBeenCalled();
  });

  it("propagates fetcher errors so the scheduler records failure", async () => {
    const fetcher: RedStoneFetcher = {
      fetch: async () => {
        throw new Error("gateway 502");
      },
    };
    const worker = new OraclePusher({
      stellar: makeMockStellar(),
      fetcher,
      alerter: makeMockAlerter(),
      oracleContractId: "CORACLE",
      feeds: ["BTC"],
      stalenessAlertMs: 60_000,
    });
    await expect(worker.tick()).rejects.toThrow("gateway 502");
  });
});
