/**
 * RedStone payload fetcher.
 *
 * Uses the official RedStone SDK to request signed packages and serialises
 * them with @redstone-finance/protocol into the canonical binary payload that
 * `stellax-oracle.write_prices()` expects. Do not use the gateway
 * `/data-packages/payload` endpoint here: it currently returns a health page
 * for the public gateway and is not a Soroban-verifier-compatible payload.
 */
import { RedstonePayload as SerializedRedstonePayload } from "@redstone-finance/protocol";
import type { SignedDataPackage } from "@redstone-finance/protocol";
import { requestDataPackages } from "@redstone-finance/sdk";
import type { Logger } from "pino";
import { getLogger } from "./logger.js";

/** All five RedStone primary-prod signer addresses configured on testnet. */
export const PRIMARY_PROD_SIGNERS_EVM = [
  "0x51Ce04Be4b3E32572C4Ec9135221d0691Ba7d202",
  "0x8BB8F32Df04c8b654987DAaeD53D6B6091e3B774",
  "0x9c5AE89C4Af6aA32cE58588DBaF90d18a855B6de",
  "0xDD682daEC5A90dD295d14DA4b0bec9281017b5bE",
  "0xdEB22f54738d54976C4c0fe5ce6d408E40d88499",
];

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
  waitForAllGatewaysTimeMs?: number;
  maxTimestampDeviationMs?: number;
  authorizedSigners?: string[];
}

/**
 * Default SDK-based fetcher. The oracle verifier expects at least
 * `uniqueSigners` signed packages for each requested feed. We flatten all
 * per-feed packages into a single serialized payload.
 */
export class DefaultRedStoneFetcher implements RedStoneFetcher {
  private readonly log: Logger;
  constructor(private readonly opts: RedStoneFetcherOptions) {
    this.log = getLogger("redstone");
  }

  async fetch(feeds: string[]): Promise<RedStonePayload> {
    if (feeds.length === 0) {
      throw new Error("redstone fetch requested with no feeds");
    }
    const uniqueFeeds = [...new Set(feeds.map((f) => f.trim()).filter(Boolean))];
    this.log.debug(
      {
        feeds: uniqueFeeds,
        dataServiceId: this.opts.dataServiceId,
        uniqueSigners: this.opts.uniqueSigners,
      },
      "fetching redstone signed packages",
    );

    const FETCH_TIMEOUT_MS = 15_000;
    const fetchPromise = requestDataPackages({
      dataServiceId: this.opts.dataServiceId,
      dataPackagesIds: uniqueFeeds,
      uniqueSignersCount: this.opts.uniqueSigners,
      authorizedSigners: this.opts.authorizedSigners ?? PRIMARY_PROD_SIGNERS_EVM,
      waitForAllGatewaysTimeMs: this.opts.waitForAllGatewaysTimeMs ?? 2_000,
      maxTimestampDeviationMS: this.opts.maxTimestampDeviationMs ?? 10 * 60 * 1_000,
      ignoreMissingFeed: false,
    });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`redstone fetch timed out after ${FETCH_TIMEOUT_MS}ms`)), FETCH_TIMEOUT_MS),
    );
    const packagesByFeed = await Promise.race([fetchPromise, timeoutPromise]);

    const signedPackages: SignedDataPackage[] = [];
    for (const feed of uniqueFeeds) {
      const pkgs = packagesByFeed[feed] ?? [];
      if (pkgs.length < this.opts.uniqueSigners) {
        throw new Error(
          `redstone feed ${feed}: got ${pkgs.length} signed packages, need ${this.opts.uniqueSigners}`,
        );
      }
      signedPackages.push(...pkgs);
    }

    const serialized = new SerializedRedstonePayload(signedPackages, "");
    const bytes = Buffer.from(serialized.toBytesHexWithout0xPrefix(), "hex");
    if (bytes.length === 0) throw new Error("redstone serialized payload is empty");

    return {
      bytes,
      feeds: uniqueFeeds,
      timestampMs: Date.now(),
    };
  }
}
