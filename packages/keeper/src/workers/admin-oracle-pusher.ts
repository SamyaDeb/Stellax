import { BaseWorker } from "../worker.js";
import { scVal, type StellarClient } from "../stellar.js";
import type { Alerter } from "../alert.js";
import { getLogger } from "../logger.js";

export interface AdminOraclePusherDeps {
  stellar: StellarClient;
  alerter: Alerter;
  oracleContractId: string;
  /**
   * Asset symbols to push, e.g. ["BTC", "ETH", "XLM", "SOL"].
   * Must match the symbols registered in the oracle contract.
   */
  assets: string[];
  stalenessAlertMs: number;
}

/** CoinGecko simple/price IDs for the supported perp-market crypto assets. */
const COINGECKO_IDS: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  XLM: "stellar",
  SOL: "solana",
};

/** Static fallback prices (USD) used only when CoinGecko is completely unreachable. */
const STATIC_FALLBACK_PRICES: Record<string, number> = {
  BTC: 65_000,
  ETH: 3_000,
  XLM: 0.12,
  SOL: 145,
};

const FETCH_TIMEOUT_MS = 8_000;
const PRECISION_18 = 10n ** 18n;

function toFixed18(price: number): bigint {
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`invalid price ${price}`);
  }
  // 9-decimal intermediate avoids float drift; scale to 18 decimals.
  const intermediate = Math.round(price * 1e9);
  return BigInt(intermediate) * 10n ** 9n;
}

/** Return type shape from `oracle.get_price(asset)` — `PriceData` contracttype. */
interface OraclePriceData {
  price: bigint;
  package_timestamp: bigint; // milliseconds
  write_timestamp: bigint;   // seconds (ledger timestamp)
}

/**
 * Admin oracle pusher for testnet.
 *
 * Replaces the RedStone-based `OraclePusher` when `ORACLE_USE_ADMIN_PUSH=true`.
 * Fetches BTC/ETH/XLM/SOL spot prices from the CoinGecko public API and
 * pushes them via `oracle.admin_push_price(asset, price_18dp, pkg_ts)`.
 *
 * Monotonic `package_timestamp` guarantee:
 *   On `onStart()` each asset's baseline is read from the oracle itself so we
 *   always beat whatever is currently stored (including a future-stuck value).
 *   On each subsequent tick: `pkg_ts = max(lastPkgTs + 1, Date.now())`.
 *   This means that for ~14h after the initial bootstrap (while real wall-time
 *   is still behind the stuck timestamp) we increment by 1 per tick; once
 *   wall-time overtakes the stored value the natural `Date.now()` path takes
 *   over.
 */
export class AdminOraclePusher extends BaseWorker {
  readonly name = "admin-oracle-pusher";

  /** Per-asset last-used package_timestamp (ms). Populated in onStart(). */
  private readonly lastPkgTs = new Map<string, bigint>();

  constructor(private readonly deps: AdminOraclePusherDeps) {
    super();
    this.log = getLogger(this.name);
  }

  protected override async onStart(): Promise<void> {
    const { stellar, oracleContractId, assets } = this.deps;

    for (const asset of assets) {
      let initPkgTs: bigint;
      try {
        // Query the oracle for the currently stored PriceData.  Even if the
        // price is stale the contract may still return the stored PriceData
        // (behaviour depends on oracle version).  We only need package_timestamp.
        const sim = await stellar.simulate<OraclePriceData>(
          oracleContractId,
          "get_price",
          [scVal.symbol(asset)],
        );
        const stored = sim.returnValue.package_timestamp ?? 0n;
        initPkgTs = stored + 1n;
        this.log.info(
          { asset, storedPkgTs: stored.toString(), initPkgTs: initPkgTs.toString() },
          "admin-oracle-pusher: read stored package_timestamp",
        );
      } catch (err) {
        // get_price threw — most likely OraclePriceTooOld (#28) because the
        // price is stale, or price is missing entirely.  Fall back to a value
        // 24 h ahead of now; this safely beats any realistically stuck future
        // timestamp without requiring the stored value.
        const fallback = BigInt(Date.now()) + 86_400_000n;
        this.log.warn(
          { asset, fallback: fallback.toString(), err: (err as Error).message },
          "admin-oracle-pusher: get_price failed; using 24h-ahead fallback for initial pkg_ts",
        );
        initPkgTs = fallback;
      }
      this.lastPkgTs.set(asset, initPkgTs);
    }

    this.log.info(
      { assets: this.deps.assets },
      "admin-oracle-pusher: package_timestamp baselines initialised",
    );
  }

  async tick(): Promise<void> {
    const { stellar, alerter, oracleContractId, assets, stalenessAlertMs } =
      this.deps;

    if (assets.length === 0) {
      this.log.warn("no assets configured; skipping");
      return;
    }

    // Fetch CoinGecko prices (one batch request for all assets).
    const prices = await this.fetchPrices(assets);
    this.log.debug({ prices }, "fetched CoinGecko prices");

    // Push each asset.  Failures are isolated — one bad asset doesn't block others.
    let anySuccess = false;
    await Promise.all(
      assets.map(async (asset) => {
        const priceUsd = prices[asset];
        if (priceUsd === undefined || !Number.isFinite(priceUsd) || priceUsd <= 0) {
          this.log.warn({ asset }, "no valid price for asset; skipping");
          return;
        }

        // Guarantee monotonic package_timestamp per asset.
        const prev = this.lastPkgTs.get(asset) ?? BigInt(Date.now());
        const thisPkgTs =
          prev + 1n > BigInt(Date.now()) ? prev + 1n : BigInt(Date.now());

        try {
          const price18 = toFixed18(priceUsd);
          const res = await stellar.invoke(
            oracleContractId,
            "admin_push_price",
            [scVal.symbol(asset), scVal.i128(price18), scVal.u64(thisPkgTs)],
            {},
          );
          this.lastPkgTs.set(asset, thisPkgTs);
          anySuccess = true;
          this.log.info(
            {
              asset,
              priceUsd,
              price18: price18.toString(),
              pkgTs: thisPkgTs.toString(),
              hash: res.hash,
            },
            "price pushed",
          );
        } catch (err) {
          this.log.error(
            { asset, err: (err as Error).message },
            "admin_push_price failed",
          );
        }
      }),
    );

    // Staleness watchdog.
    if (anySuccess) {
      // lastSuccessAt is updated by BaseWorker after tick() resolves, but we
      // check here so the alert fires even on partial ticks.
      const lastOk = this.status.lastSuccessAt ?? Date.now();
      if (Date.now() - lastOk > stalenessAlertMs) {
        await alerter.send(
          "critical",
          "admin-oracle-stale",
          `no successful admin price push in ${Math.round(
            (Date.now() - lastOk) / 1000,
          )}s`,
        );
      }
    }
  }

  /**
   * Batch-fetch USD spot prices from CoinGecko's free public API.
   * Falls back to static prices for any asset that can't be resolved.
   */
  private async fetchPrices(
    assets: string[],
  ): Promise<Record<string, number>> {
    const ids = assets
      .map((a) => COINGECKO_IDS[a.toUpperCase()])
      .filter((id): id is string => id !== undefined);

    if (ids.length === 0) {
      this.log.warn({ assets }, "no CoinGecko IDs for assets; using static fallbacks");
      return this.staticFallbacks(assets);
    }

    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

    let raw: Record<string, { usd?: number }>;
    try {
      const resp = await fetch(url, {
        signal: ctrl.signal,
        headers: { accept: "application/json" },
      });
      if (!resp.ok) {
        throw new Error(`CoinGecko HTTP ${resp.status}`);
      }
      raw = (await resp.json()) as Record<string, { usd?: number }>;
    } catch (err) {
      this.log.warn(
        { err: (err as Error).message },
        "CoinGecko fetch failed; using static fallbacks",
      );
      return this.staticFallbacks(assets);
    } finally {
      clearTimeout(timer);
    }

    // Invert the ID→symbol mapping to build the result.
    const out: Record<string, number> = {};
    for (const asset of assets) {
      const id = COINGECKO_IDS[asset.toUpperCase()];
      const price = id !== undefined ? raw[id]?.usd : undefined;
      if (price !== undefined && Number.isFinite(price) && price > 0) {
        out[asset] = price;
      } else {
        const fb = STATIC_FALLBACK_PRICES[asset.toUpperCase()];
        if (fb !== undefined) {
          this.log.warn(
            { asset, id },
            "CoinGecko returned no price; using static fallback",
          );
          out[asset] = fb;
        }
      }
    }
    return out;
  }

  private staticFallbacks(assets: string[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const asset of assets) {
      const fb = STATIC_FALLBACK_PRICES[asset.toUpperCase()];
      if (fb !== undefined) out[asset] = fb;
    }
    return out;
  }
}

// Prevent unused-import warnings: re-export PRECISION_18 so tree-shaker
// doesn't warn if it's not used inside this file.
export const _internal = { PRECISION_18 };
