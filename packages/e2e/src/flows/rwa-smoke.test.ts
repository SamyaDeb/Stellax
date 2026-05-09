// ── Phase Ω6 / M smoke — RWA oracle + perp markets ───────────────────────────
//
// Read-only checks that the shared testnet has the RWA price feeds and perp
// markets needed by the demo. Write-side deposit/open-position coverage lives
// behind the heavier demo e2e path because it needs funded disposable users.

import { describe, expect, it } from "vitest";

import { getCtx } from "../lib/fixtures.js";
import { simulateRead } from "../lib/invoke.js";
import { symbolVal, u32Val } from "../lib/scval.js";

interface PriceData {
  price: bigint;
  package_timestamp: bigint;
  write_timestamp: bigint;
}

interface MarketData {
  base_asset: string;
  is_active: boolean;
  market_id: number;
  max_leverage: number;
}

const RWA_MARKETS = [
  { feed: "BENJI", marketId: 100 },
  { feed: "USDY", marketId: 101 },
  { feed: "OUSG", marketId: 102 },
] as const;

describe("rwa smoke (oracle + perp markets)", () => {
  const ctx = getCtx();
  const probe = ctx.deployer.publicKey();

  for (const { feed, marketId } of RWA_MARKETS) {
    it(`${feed} has a positive oracle price`, async () => {
      const price = await simulateRead<PriceData>(
        ctx.net,
        probe,
        ctx.deployments.oracle,
        "get_price",
        [symbolVal(feed)],
      );
      expect(price.price).toBeGreaterThan(0n);
      expect(price.package_timestamp).toBeGreaterThan(0n);
      expect(price.write_timestamp).toBeGreaterThan(0n);
    });

    it(`${feed} perp market ${marketId} is active`, async () => {
      const market = await simulateRead<MarketData>(
        ctx.net,
        probe,
        ctx.deployments.perp_engine,
        "get_market",
        [u32Val(marketId)],
      );
      expect(market.market_id).toBe(marketId);
      expect(market.base_asset).toBe(feed);
      expect(market.is_active).toBe(true);
      expect(market.max_leverage).toBeGreaterThan(0);
    });
  }
});
