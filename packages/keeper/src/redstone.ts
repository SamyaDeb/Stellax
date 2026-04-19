/**
 * RedStone payload fetcher.
 *
 * The RedStone Stellar connector package is young and its API surface is
 * unstable. Rather than pin to a specific SDK, the keeper models the
 * payload source as an injectable interface. The default implementation
 * hits the public RedStone gateway REST API and returns the signed
 * package bytes that `stellax-oracle.write_prices()` expects.
 *
 * Swap `DefaultRedStoneFetcher` for `@redstone-finance/stellar-connector`
 * (or the Node SDK) when it stabilises — the keeper itself never needs
 * to change.
 */
import type { Logger } from "pino";
import { getLogger } from "./logger.js";

export interface RedStonePayload {
  /** Raw signed package bytes, ready to pass to the oracle contract. */
  bytes: Uint8Array;
  /** Feeds included in this package (symbol list). */
  feeds: string[];
  /** Package timestamp in milliseconds since epoch. */
  timestampMs: number;
}

export interface RedStoneFetcher {
  fetch(feeds: string[]): Promise<RedStonePayload>;
}

export interface RedStoneFetcherOptions {
  gatewayUrl: string;
  dataServiceId: string;
  uniqueSigners: number;
}

/**
 * Default gateway-based fetcher.
 *
 * The RedStone gateway returns per-feed packages keyed by data-feed symbol.
 * The Stellar oracle contract expects a single signed bundle that
 * concatenates them; until the official Stellar connector is public we
 * fetch the raw binary payload from the gateway's `/data-packages/payload`
 * endpoint which produces the exact bytes the on-chain verifier consumes.
 */
export class DefaultRedStoneFetcher implements RedStoneFetcher {
  private readonly log: Logger;
  constructor(private readonly opts: RedStoneFetcherOptions) {
    this.log = getLogger("redstone");
  }

  async fetch(feeds: string[]): Promise<RedStonePayload> {
    const url = new URL("/data-packages/payload", this.opts.gatewayUrl);
    url.searchParams.set("dataServiceId", this.opts.dataServiceId);
    url.searchParams.set("uniqueSignersCount", String(this.opts.uniqueSigners));
    url.searchParams.set("dataFeeds", feeds.join(","));
    url.searchParams.set("format", "raw");

    this.log.debug({ url: url.toString() }, "fetching redstone payload");
    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(
        `redstone gateway ${res.status}: ${await res.text().catch(() => "")}`,
      );
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length === 0) {
      throw new Error("redstone gateway returned empty payload");
    }
    return {
      bytes: buf,
      feeds: [...feeds],
      timestampMs: Date.now(),
    };
  }
}
