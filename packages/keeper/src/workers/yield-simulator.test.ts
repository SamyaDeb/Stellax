import { describe, it, expect, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  YieldSimulator,
  type RwaHolderSource,
  type ApySource,
  type RwaHolder,
} from "./yield-simulator.js";
import { makeMockStellar } from "../test/helpers.js";

const SECONDS_PER_YEAR = 365n * 24n * 60n * 60n;

const ADDR_A = Keypair.random().publicKey();
const ADDR_B = Keypair.random().publicKey();
const ADDR_ALREADY = Keypair.random().publicKey();

function holderSource(feedId: string, holders: RwaHolder[]): RwaHolderSource {
  return {
    feedId,
    async getHolders() {
      return holders;
    },
  };
}

const apySource = (bps: number): ApySource => ({
  async getApyBps() {
    return bps;
  },
});

describe("YieldSimulator", () => {
  it("credits expected delta = balance * apy * elapsed - cumulativeYield", async () => {
    const invoke = vi.fn(async (_id: string, method: string) => ({
      hash: `h-${method}`,
      status: "SUCCESS" as const,
      returnValue: undefined,
      latestLedger: 1,
    }));
    const stellar = makeMockStellar({ invoke: invoke as never });
    const nowSec = Math.floor(Date.now() / 1000);
    const elapsed = 24n * 3_600n; // 1 day
    const balance = 1_000_000_000n; // 1000 BENJI at 6 decimals
    const apyBps = 500n; // 5.00%
    const expected = (balance * apyBps * elapsed) / (10_000n * SECONDS_PER_YEAR);

    const worker = new YieldSimulator({
      stellar,
      rwaContracts: { BENJI: "CBENJI" },
      holderSources: [
        holderSource("BENJI", [
          {
            address: ADDR_A,
            balanceNative: balance,
            cumulativeYield: 0n,
            sinceTs: nowSec - Number(elapsed),
          },
        ]),
      ],
      apySource: apySource(Number(apyBps)),
    });

    await worker.tick();

    // Two invokes per feed: set_apy_bps, then credit_yield.
    const methods = invoke.mock.calls.map((c) => (c as unknown as unknown[])[1]);
    expect(methods).toContain("set_apy_bps");
    expect(methods).toContain("credit_yield");
    expect(expected).toBeGreaterThan(0n);
  });

  it("skips holders whose delta rounds to zero or is negative", async () => {
    const invoke = vi.fn(async () => ({
      hash: "h",
      status: "SUCCESS" as const,
      returnValue: undefined,
      latestLedger: 1,
    }));
    const stellar = makeMockStellar({ invoke: invoke as never });
    const nowSec = Math.floor(Date.now() / 1000);
    const worker = new YieldSimulator({
      stellar,
      rwaContracts: { USDY: "CUSDY" },
      holderSources: [
        holderSource("USDY", [
          // Already-paid holder (cumulativeYield ≥ expected) → no drip.
          {
            address: ADDR_ALREADY,
            balanceNative: 1_000_000_000n,
            cumulativeYield: 999_999_999n,
            sinceTs: nowSec - 60,
          },
        ]),
      ],
      apySource: apySource(505),
    });
    await worker.tick();
    // Only `set_apy_bps` was called — no `credit_yield` because no positive deltas.
    const methods = invoke.mock.calls.map((c) => (c as unknown as unknown[])[1]);
    expect(methods).toContain("set_apy_bps");
    expect(methods).not.toContain("credit_yield");
  });

  it("respects batchSize when many holders need drip", async () => {
    const invoke = vi.fn(async () => ({
      hash: "h",
      status: "SUCCESS" as const,
      returnValue: undefined,
      latestLedger: 1,
    }));
    const stellar = makeMockStellar({ invoke: invoke as never });
    const nowSec = Math.floor(Date.now() / 1000);
    const holders: RwaHolder[] = Array.from({ length: 60 }).map(() => ({
      address: Keypair.random().publicKey(),
      balanceNative: 1_000_000_000n,
      cumulativeYield: 0n,
      sinceTs: nowSec - 86_400,
    }));
    const worker = new YieldSimulator({
      stellar,
      rwaContracts: { BENJI: "CBENJI" },
      holderSources: [holderSource("BENJI", holders)],
      apySource: apySource(500),
      batchSize: 25,
    });
    await worker.tick();
    const credits = invoke.mock.calls.filter(
      (c) => (c as unknown as unknown[])[1] === "credit_yield",
    );
    // 60 holders / 25 per batch = 3 batches.
    expect(credits.length).toBe(3);
  });

  it("skips a feed gracefully when its contract is not mapped", async () => {
    const invoke = vi.fn(async () => ({
      hash: "h",
      status: "SUCCESS" as const,
      returnValue: undefined,
      latestLedger: 1,
    }));
    const stellar = makeMockStellar({ invoke: invoke as never });
    const worker = new YieldSimulator({
      stellar,
      rwaContracts: {}, // empty
      holderSources: [
        holderSource("BENJI", [
          {
            address: ADDR_B,
            balanceNative: 1_000_000_000n,
            cumulativeYield: 0n,
            sinceTs: Math.floor(Date.now() / 1000) - 3600,
          },
        ]),
      ],
      apySource: apySource(500),
    });
    await worker.tick();
    expect(invoke).not.toHaveBeenCalled();
  });
});
