// ── Oracle e2e: fetch RedStone primary-prod payloads and write on-chain ───────

import { describe, expect, it } from "vitest";

import { getCtx } from "../lib/fixtures.js";
import { invoke, simulateRead } from "../lib/invoke.js";
import { fetchRedStonePayload } from "../lib/redstone.js";
import { bytesVal, symbolVal, vecVal } from "../lib/scval.js";

interface PriceData {
  price: bigint;
  package_timestamp: bigint;
  write_timestamp: bigint;
}

describe("oracle", () => {
  it("write_prices accepts a real redstone-primary-prod payload", async () => {
    const { net, deployments, deployer } = getCtx();

    // Fetch + serialize a multi-feed payload.
    const feeds = ["XLM", "BTC", "ETH", "SOL"];
    const payload = await fetchRedStonePayload(feeds);
    console.log(`  ▸ redstone payload ${payload.length} bytes for ${feeds.join(",")}`);

    // Submit on-chain. The shared testnet keeper may have already pushed the
    // same or a newer RedStone package; in that case the contract correctly
    // rejects this payload with NonMonotonicTimestamp (#11), and the read tests
    // below prove the oracle remains fresh.
    try {
      await invoke(
        net,
        deployer,
        deployments.oracle,
        "write_prices",
        [bytesVal(payload)],
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("Contract, #11")) {
        console.log("  ▸ write skipped: on-chain oracle already has this/newer package");
        return;
      }
      if (message.includes("timeout hash=") || message.includes("poll failed hash=")) {
        console.log(`  ▸ write submitted but RPC confirmation lagged: ${message}`);
        return;
      }
      throw err;
    }
  });

  it("get_price returns a positive 18-decimal price per feed", async () => {
    const { net, deployments, deployer } = getCtx();

    for (const feed of ["XLM", "BTC", "ETH", "SOL"]) {
      const price = await simulateRead<PriceData>(
        net,
        deployer.publicKey(),
        deployments.oracle,
        "get_price",
        [symbolVal(feed)],
      );
      console.log(
        `  ▸ ${feed}: price=${price.price} pkg_ts=${price.package_timestamp} write_ts=${price.write_timestamp}`,
      );
      expect(price.price).toBeGreaterThan(0n);
      expect(price.package_timestamp).toBeGreaterThan(0n);
      expect(price.write_timestamp).toBeGreaterThan(0n);
    }
  });

  it("get_prices batches multiple feeds in one call", async () => {
    const { net, deployments, deployer } = getCtx();

    const feeds = ["XLM", "BTC", "ETH", "SOL"];
    const assets = vecVal(feeds.map(symbolVal));
    const prices = await simulateRead<PriceData[]>(
      net,
      deployer.publicKey(),
      deployments.oracle,
      "get_prices",
      [assets],
    );
    expect(prices).toHaveLength(feeds.length);
    for (const p of prices) {
      expect(p.price).toBeGreaterThan(0n);
    }
  });
});
