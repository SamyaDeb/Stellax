import { type StellarClient } from "./stellar.js";
import { getLogger } from "./logger.js";
import type { VaultScheduleSource } from "./workers/vault-roller.js";
import type { OpenOrder, OrderBookSource } from "./workers/clob-matcher.js";
import type { RwaHolder, RwaHolderSource } from "./workers/yield-simulator.js";

interface SourceOptions {
  fetchImpl?: typeof fetch;
}

function baseUrl(url: string): string {
  return url.replace(/\/$/, "");
}

async function fetchJson<T>(fetchImpl: typeof fetch, url: string): Promise<T | null> {
  const res = await fetchImpl(url);
  if (!res.ok) return null;
  return (await res.json()) as T;
}

function asBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string" && value.length > 0) return BigInt(value);
  return 0n;
}

function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.length > 0) return Number(value);
  return 0;
}

interface EpochLike {
  end_time?: number | bigint | string;
  endTime?: number | bigint | string;
}

/** Reads each structured vault's live epoch directly from the contract. */
export class ContractVaultScheduleSource implements VaultScheduleSource {
  private readonly log = getLogger("vault-schedule-src");

  constructor(private readonly stellar: StellarClient) {}

  async getCurrentEpochEnd(vaultId: string): Promise<number> {
    try {
      const sim = await this.stellar.simulate<EpochLike>(vaultId, "get_epoch", []);
      const end = asNumber(sim.returnValue.end_time ?? sim.returnValue.endTime);
      return end > 0 ? end : Number.MAX_SAFE_INTEGER;
    } catch (err) {
      this.log.warn({ vaultId, err: (err as Error).message }, "get_epoch failed");
      return Number.MAX_SAFE_INTEGER;
    }
  }
}

interface IndexerOrderRow {
  orderId?: string;
  order_id?: string;
  trader: string;
  marketId?: number;
  market_id?: number;
  isLong?: 0 | 1 | boolean;
  is_long?: 0 | 1 | boolean;
  price: string;
  size: string;
  filledSize?: string;
  filled_size?: string;
  placedAt?: number;
  placed_at?: number;
  updatedAt?: number;
  updated_at?: number;
  status?: string;
}

/** Pulls the current CLOB open book from the indexer's `/orders` endpoint. */
export class IndexerOrderBookSource implements OrderBookSource {
  private readonly log = getLogger("indexer-order-src");
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly indexerUrl: string, opts: SourceOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async getOpenOrders(): Promise<OpenOrder[]> {
    try {
      const rows = await fetchJson<IndexerOrderRow[]>(this.fetchImpl, `${baseUrl(this.indexerUrl)}/orders`);
      if (!rows) return [];
      return rows
        .filter((row) => row.status === undefined || row.status === "open")
        .map((row) => ({
          orderId: asBigInt(row.orderId ?? row.order_id),
          trader: row.trader,
          marketId: asNumber(row.marketId ?? row.market_id),
          isLong: Boolean(row.isLong ?? row.is_long),
          price: asBigInt(row.price),
          size: asBigInt(row.size),
          filledSize: asBigInt(row.filledSize ?? row.filled_size),
          expiresAt: asNumber(row.updatedAt ?? row.updated_at ?? row.placedAt ?? row.placed_at),
        }))
        .filter((row) => row.orderId > 0n && row.marketId > 0 && row.size > row.filledSize);
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, "indexer orders fetch failed");
      return [];
    }
  }
}

interface IndexerRwaHolderRow {
  address: string;
  balanceNative?: string;
  balance_native?: string;
  cumulativeYield?: string;
  cumulative_yield?: string;
  firstSeenTs?: number;
  first_seen_ts?: number;
}

/** Uses the indexer's holder snapshot instead of static `RWA_HOLDERS`. */
export class IndexerRwaHolderSource implements RwaHolderSource {
  private readonly log = getLogger("indexer-rwa-holder-src");
  private readonly fetchImpl: typeof fetch;
  public readonly feedId: string;

  constructor(
    private readonly indexerUrl: string,
    feedId: string,
    opts: SourceOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.feedId = feedId.toUpperCase();
  }

  async getHolders(): Promise<RwaHolder[]> {
    const url = `${baseUrl(this.indexerUrl)}/rwa-holders/${encodeURIComponent(this.feedId)}`;
    try {
      const rows = await fetchJson<IndexerRwaHolderRow[]>(this.fetchImpl, url);
      if (!rows) return [];
      return rows
        .map((row) => ({
          address: row.address,
          balanceNative: asBigInt(row.balanceNative ?? row.balance_native),
          cumulativeYield: asBigInt(row.cumulativeYield ?? row.cumulative_yield),
          sinceTs: asNumber(row.firstSeenTs ?? row.first_seen_ts),
        }))
        .filter((holder) => holder.balanceNative > 0n && holder.sinceTs > 0);
    } catch (err) {
      this.log.warn({ feedId: this.feedId, err: (err as Error).message }, "indexer RWA holder fetch failed");
      return [];
    }
  }
}
