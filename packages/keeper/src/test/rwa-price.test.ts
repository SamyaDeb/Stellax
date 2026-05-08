import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchCoinGecko,
  fetchCoinMarketCap,
  fetchOndoNav,
  fetchFranklinNav,
  staticFallback,
  COINGECKO_IDS,
  type RwaQuote,
} from "../sources/rwa-prices.js";
import { selectBestPrice, DefaultRwaNavFetcher } from "../rwa-nav.js";
import { RwaNavPusher } from "../workers/rwa-nav-pusher.js";
import { makeMockStellar, makeMockAlerter, silenceLogs } from "./helpers.js";

silenceLogs();

const NOW = 1_746_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function quote(
  symbol: string,
  priceUsd: number,
  source: string,
  ageMs = 0,
): RwaQuote {
  return { symbol, priceUsd, ts: NOW - ageMs, source };
}

describe("selectBestPrice", () => {
  it("picks the median of three quotes", () => {
    const result = selectBestPrice([
      quote("USDY", 1.119, "a"),
      quote("USDY", 1.12, "b"),
      quote("USDY", 1.121, "c"),
    ]);
    expect(result?.priceUsd).toBeCloseTo(1.12, 6);
    expect(result?.sources).toHaveLength(3);
  });

  it("rejects an outlier beyond maxDeviationBps", () => {
    // Three quotes around $1.12, one wild quote at $1.50.
    const result = selectBestPrice(
      [
        quote("USDY", 1.11, "a"),
        quote("USDY", 1.12, "b"),
        quote("USDY", 1.13, "c"),
        quote("USDY", 1.5, "outlier"),
      ],
      300_000,
      100, // 1% tolerance
    );
    expect(result).not.toBeNull();
    expect(result!.sources.find((s) => s.source === "outlier")).toBeUndefined();
    expect(result!.priceUsd).toBeCloseTo(1.12, 2);
  });

  it("returns null when every quote is stale", () => {
    const result = selectBestPrice(
      [
        quote("USDY", 1.12, "a", 10 * 60 * 1000),
        quote("USDY", 1.13, "b", 10 * 60 * 1000),
      ],
      300_000,
    );
    expect(result).toBeNull();
  });

  it("accepts a single fresh quote", () => {
    const result = selectBestPrice([quote("USDY", 1.12, "only")]);
    expect(result?.priceUsd).toBeCloseTo(1.12, 6);
    expect(result?.sources).toHaveLength(1);
  });

  it("returns null on empty input", () => {
    expect(selectBestPrice([])).toBeNull();
  });
});

describe("fetchCoinGecko", () => {
  it("maps responses to RwaQuotes", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          [COINGECKO_IDS.USDY]: { usd: 1.12, last_updated_at: NOW / 1000 },
          [COINGECKO_IDS.OUSG]: { usd: 101.5, last_updated_at: NOW / 1000 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
    const out = await fetchCoinGecko(
      { USDY: COINGECKO_IDS.USDY, OUSG: COINGECKO_IDS.OUSG },
      fetchImpl,
    );
    expect(out).toHaveLength(2);
    expect(out.find((q) => q.symbol === "USDY")?.priceUsd).toBe(1.12);
    expect(out.find((q) => q.symbol === "OUSG")?.priceUsd).toBe(101.5);
    expect(out.every((q) => q.source === "coingecko")).toBe(true);
  });

  it("returns [] on network error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const out = await fetchCoinGecko({ USDY: COINGECKO_IDS.USDY }, fetchImpl);
    expect(out).toEqual([]);
  });

  it("returns [] on non-2xx", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("rate limited", { status: 429 }),
    ) as unknown as typeof fetch;
    const out = await fetchCoinGecko({ USDY: COINGECKO_IDS.USDY }, fetchImpl);
    expect(out).toEqual([]);
  });
});

describe("fetchCoinMarketCap", () => {
  it("returns [] when api key blank", async () => {
    const out = await fetchCoinMarketCap({ USDY: "USDY" }, "");
    expect(out).toEqual([]);
  });

  it("parses CMC v2 quotes/latest response", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: {
            USDY: [
              {
                quote: {
                  USD: { price: 1.121, last_updated: new Date(NOW).toISOString() },
                },
              },
            ],
          },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const out = await fetchCoinMarketCap(
      { USDY: "USDY" },
      "test-key",
      fetchImpl,
    );
    expect(out).toHaveLength(1);
    expect(out[0].priceUsd).toBeCloseTo(1.121, 5);
    expect(out[0].source).toBe("coinmarketcap");
  });
});

describe("fetchOndoNav", () => {
  it("extracts nav field from issuer JSON", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ nav: 1.123, asOf: new Date(NOW).toISOString() }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const out = await fetchOndoNav(
      { USDY: "https://api.ondo.finance/v1/nav/usdy" },
      fetchImpl,
    );
    expect(out).toHaveLength(1);
    expect(out[0].priceUsd).toBeCloseTo(1.123, 5);
    expect(out[0].source).toBe("ondo-nav");
  });
});

describe("fetchFranklinNav", () => {
  it("returns null on parse failure", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("<html>no price here</html>", { status: 200 }),
    ) as unknown as typeof fetch;
    const out = await fetchFranklinNav("http://x", fetchImpl);
    expect(out).toBeNull();
  });
});

describe("staticFallback", () => {
  it("stamps prices with the current ts", () => {
    const out = staticFallback({ BENJI: 1.0, OUSG: 101.5 });
    expect(out).toHaveLength(2);
    expect(out.every((q) => q.ts === NOW)).toBe(true);
    expect(out.every((q) => q.source === "static")).toBe(true);
  });
});

describe("DefaultRwaNavFetcher", () => {
  it("uses static fallback when all sources fail", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const f = new DefaultRwaNavFetcher({
      cmcApiKey: "",
      ondoNavUrl: "http://ondo",
      benjiNavUrl: "http://franklin",
      fetchImpl,
    });
    const sample = await f.fetch("USDY");
    expect(sample.feedId).toBe("USDY");
    expect(sample.source).toBe("static");
    // USDY static fallback is 1.12 → 1.12 * 1e18
    expect(sample.price18).toBe(1_120_000_000n * 10n ** 9n);
  });

  it("aggregates across sources and tags label as median(...)", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("coingecko.com")) {
        return new Response(
          JSON.stringify({
            [COINGECKO_IDS.USDY]: { usd: 1.12, last_updated_at: NOW / 1000 },
          }),
          { status: 200 },
        );
      }
      if (url.includes("ondo")) {
        return new Response(
          JSON.stringify({ nav: 1.121, asOf: new Date(NOW).toISOString() }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const f = new DefaultRwaNavFetcher({
      cmcApiKey: "",
      ondoNavUrl: "http://ondo/usdy",
      fetchImpl,
    });
    const sample = await f.fetch("USDY");
    expect(sample.feedId).toBe("USDY");
    expect(sample.source.startsWith("median(")).toBe(true);
    // Median of (1.12, 1.121) = 1.1205
    const usd = Number(sample.price18) / 1e18;
    expect(usd).toBeCloseTo(1.1205, 4);
  });
});

describe("RwaNavPusher", () => {
  function makeFetcherReturning(price18: bigint, source = "median(test)") {
    return {
      async fetch(feedId: string) {
        return {
          feedId,
          price18,
          timestampMs: NOW,
          source,
        };
      },
    };
  }

  it("pushes on first tick (no prior on-chain state)", async () => {
    const invoke = vi.fn(async () => ({
      hash: "h1",
      status: "SUCCESS" as const,
      returnValue: undefined,
      latestLedger: 1,
    }));
    const pusher = new RwaNavPusher({
      stellar: makeMockStellar({ invoke: invoke as never }),
      fetcher: makeFetcherReturning(1_120_000_000n * 10n ** 9n),
      alerter: makeMockAlerter(),
      oracleContractId: "COR",
      feeds: ["USDY"],
      minDeviationBps: 10,
      forcePushMs: 60_000,
    });
    await pusher.tick();
    expect(invoke).toHaveBeenCalledTimes(1);
    const m = pusher.getMetrics().feeds[0];
    expect(m.totalSuccesses).toBe(1);
    expect(m.totalSkippedNoChange).toBe(0);
  });

  it("skips push when deviation < min and not yet forced", async () => {
    const invoke = vi.fn(async () => ({
      hash: "h1",
      status: "SUCCESS" as const,
      returnValue: undefined,
      latestLedger: 1,
    }));
    const fetcher = makeFetcherReturning(1_120_000_000n * 10n ** 9n);
    const pusher = new RwaNavPusher({
      stellar: makeMockStellar({ invoke: invoke as never }),
      fetcher,
      alerter: makeMockAlerter(),
      oracleContractId: "COR",
      feeds: ["USDY"],
      minDeviationBps: 100, // 1%
      forcePushMs: 60_000,
    });
    await pusher.tick(); // first push
    expect(invoke).toHaveBeenCalledTimes(1);

    // advance 10s — under forcePushMs, identical price → no push
    vi.setSystemTime(NOW + 10_000);
    await pusher.tick();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(pusher.getMetrics().feeds[0].totalSkippedNoChange).toBe(1);
  });

  it("force-pushes after forcePushMs even with no change", async () => {
    const invoke = vi.fn(async () => ({
      hash: "h1",
      status: "SUCCESS" as const,
      returnValue: undefined,
      latestLedger: 1,
    }));
    const pusher = new RwaNavPusher({
      stellar: makeMockStellar({ invoke: invoke as never }),
      fetcher: makeFetcherReturning(1_120_000_000n * 10n ** 9n),
      alerter: makeMockAlerter(),
      oracleContractId: "COR",
      feeds: ["USDY"],
      minDeviationBps: 1000, // huge tolerance
      forcePushMs: 60_000,
    });
    await pusher.tick();
    expect(invoke).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOW + 70_000); // past forcePushMs
    await pusher.tick();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("emits a critical alert after N consecutive failures", async () => {
    const alerter = makeMockAlerter();
    const failingFetcher = {
      async fetch() {
        throw new Error("source unavailable");
      },
    };
    const pusher = new RwaNavPusher({
      stellar: makeMockStellar(),
      fetcher: failingFetcher,
      alerter,
      oracleContractId: "COR",
      feeds: ["USDY"],
      minDeviationBps: 10,
      forcePushMs: 60_000,
      failureAlertThreshold: 3,
    });
    await pusher.tick();
    await pusher.tick();
    await pusher.tick(); // threshold reached on 3rd tick
    expect(alerter.calls).toHaveLength(1);
    expect(alerter.calls[0][0]).toBe("critical");
    expect(alerter.calls[0][1]).toBe("rwa-price-source-down");
  });
});
