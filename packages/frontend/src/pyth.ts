/**
 * Pyth Network integration for RWA token NAV prices.
 *
 * Feed IDs: verify / update at https://pyth.network/price-feeds
 * (search "USDY", "OUSG", "BENJI" / "FOBXX")
 *
 * The SDK already provides fetchPythVaa() for raw VAA bytes (used in
 * openPositionWithUpdate). This module adds a companion fetch that returns
 * the parsed price numbers alongside the VAA, so the UI can display prices
 * without a second round-trip.
 */

export const HERMES_URL      = "https://hermes.pyth.network";
export const LAZER_URL       = "https://pyth-lazer.dourolabs.app";

/**
 * Pyth Lazer symbol strings for RWA assets.
 * Lazer uses human-readable symbol names instead of 32-byte hex IDs.
 * Requires a bearer access token — set VITE_PYTH_LAZER_TOKEN in .env.
 */
export const PYTH_LAZER_SYMBOLS: Record<string, string> = {
  USDY: "Crypto.USDY/USD",
  // Add OUSG / BENJI here if they appear in Pyth Lazer's symbol registry
};

export interface PythLazerData {
  price: number;
  price18: bigint;
  publishTime: number; // unix seconds
  // No VAA — Lazer uses EVM format; for on-chain VAA use Pyth Hermes instead
}

/**
 * Fetch the latest NAV price from Pyth Lazer for display purposes.
 * Lazer provides more assets than Hermes (e.g. USDY) but requires a bearer token
 * and does NOT return a Soroban-compatible VAA — it cannot be used for
 * openPositionWithUpdate. Pair with fetchPythRwaData() for VAA-backed trading.
 *
 * Returns null if: no symbol mapping, token missing, request fails, or parse error.
 */
export async function fetchPythLazerData(
  asset: string,
  token: string,
): Promise<PythLazerData | null> {
  const symbol = PYTH_LAZER_SYMBOLS[asset.toUpperCase()];
  if (!symbol || !token) return null;

  let res: Response;
  try {
    res = await fetch(`${LAZER_URL}/v1/latest_price`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "real_time",
        formats: ["evm"],
        properties: ["price"],
        symbols: [symbol],
        parsed: true,
        jsonBinaryEncoding: "hex",
      }),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  try {
    return parseLazerBody(await res.json() as unknown);
  } catch {
    return null;
  }
}

function parseLazerBody(body: unknown): PythLazerData | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;

  // Lazer returns results under "parsed" or "results" depending on API version
  const items: unknown[] = Array.isArray(b["parsed"])  ? (b["parsed"] as unknown[])
                         : Array.isArray(b["results"]) ? (b["results"] as unknown[])
                         : [];
  if (items.length === 0) return null;

  const item = items[0] as Record<string, unknown>;
  let priceNum: number | null = null;
  let publishTime = Math.floor(Date.now() / 1000);

  const pf = item["price"];
  if (typeof pf === "number") {
    priceNum = pf;
  } else if (typeof pf === "string") {
    priceNum = parseFloat(pf);
  } else if (pf && typeof pf === "object") {
    const p = pf as Record<string, unknown>;
    // Fixed-point mantissa + exponent format (Pyth standard)
    if (typeof p["price"] === "string" && typeof p["expo"] !== "undefined") {
      const expo = typeof p["expo"] === "number" ? p["expo"] : parseInt(String(p["expo"]), 10);
      priceNum = parseFloat(p["price"] as string) * Math.pow(10, expo);
    } else if (typeof p["price"] === "number") {
      priceNum = p["price"] as number;
    }
    // Timestamp: Lazer may use unix ms or unix s
    if (typeof p["publish_time"] === "number") publishTime = p["publish_time"] as number;
    else if (typeof p["timestamp"] === "number") {
      const ts = p["timestamp"] as number;
      publishTime = ts > 1e12 ? Math.floor(ts / 1000) : ts;
    }
  }

  if (priceNum === null || !isFinite(priceNum) || priceNum <= 0) return null;

  const price18 = BigInt(Math.round(priceNum * 1e18));
  return { price: priceNum, price18, publishTime };
}

/**
 * 32-byte Pyth price feed IDs (hex, no 0x prefix) for RWA NAV feeds.
 *
 * Verified 2026-05-12 via hermes.pyth.network/v2/price_feeds:
 *   USDY  — confirmed on Pyth (Ondo US Dollar Yield, ~$1.13)
 *   OUSG  — NOT on Pyth Hermes; falls back to keeper oracle (rwa-nav-pusher)
 *   BENJI — NOT on Pyth (the "BENJI" feed is BASENJI, a meme coin); same fallback
 *
 * A wrong or missing ID causes Hermes to return null, falling back to the
 * on-chain oracle then the indexer ticker automatically.
 */
export const PYTH_RWA_FEED_IDS: Record<string, string> = {
  // Verified 2026-05-12 via hermes.pyth.network/v2/price_feeds — live price ~$1.1321
  USDY: "e393449f6aff8a4b6d3e1165a7c9ebec103685f3b41e60db4277b5b6d10e7326",
  // OUSG — not listed on Pyth Hermes (falls back to keeper oracle)
  // BENJI — "BENJI" on Pyth is BASENJI (meme coin), not Franklin Templeton FOBXX; omitted
};

export interface PythRwaData {
  price: number;
  price18: bigint;
  publishTime: number; // unix seconds
  vaa: Uint8Array;     // signed binary VAA for openPositionWithUpdate
}

/**
 * Fetch the latest RWA NAV price from Pyth Hermes, returning both the
 * human-readable price and the signed VAA blob needed for on-chain submission.
 *
 * Returns null if:
 * - No feed ID is configured for this asset
 * - The Hermes request fails (network error, wrong feed ID, rate limit)
 * - The response is missing parsed or binary data
 */
export async function fetchPythRwaData(asset: string): Promise<PythRwaData | null> {
  const feedId = PYTH_RWA_FEED_IDS[asset.toUpperCase()];
  if (!feedId) return null;

  const params = new URLSearchParams();
  params.append("ids[]", feedId);
  params.append("encoding", "hex");
  params.append("parsed",   "true");

  let res: Response;
  try {
    res = await fetch(`${HERMES_URL}/v2/updates/price/latest?${params.toString()}`);
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const body = await res.json() as {
    binary?: { data?: string[] };
    parsed?: Array<{
      id: string;
      price: { price: string; expo: number; publish_time: number };
    }>;
  };

  const parsed = body.parsed?.[0];
  const hexVaa = body.binary?.data?.[0];
  if (!parsed || !hexVaa) return null;

  // Convert Pyth fixed-point price to 18-decimal bigint
  const expo = parsed.price.expo; // typically negative, e.g. -8
  const rawPrice = BigInt(parsed.price.price);
  const price18 =
    expo >= 0
      ? rawPrice * 10n ** BigInt(18 + expo)
      : rawPrice * 10n ** 18n / 10n ** BigInt(-expo);
  const price = Number(price18) / 1e18;

  // Decode hex VAA → Uint8Array
  const hex = hexVaa.replace(/^0x/, "");
  const vaa = new Uint8Array(hex.length / 2);
  for (let i = 0; i < vaa.length; i++) {
    vaa[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  return { price, price18, publishTime: parsed.price.publish_time, vaa };
}
