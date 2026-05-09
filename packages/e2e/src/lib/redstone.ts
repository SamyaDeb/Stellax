// ── RedStone payload fetcher + serializer ─────────────────────────────────────
//
// Uses the official @redstone-finance/sdk to fetch signed data packages from
// the redstone-primary-prod gateway, and @redstone-finance/protocol to
// serialize them into the canonical on-chain binary payload that our oracle's
// RedStone Rust verifier expects.

import { requestDataPackages } from "@redstone-finance/sdk";
import { RedstonePayload } from "@redstone-finance/protocol";

/** All 5 primary-prod signer addresses. Oracle requires 3-of-5 consensus. */
export const PRIMARY_PROD_SIGNERS_EVM = [
  "0x51Ce04Be4b3E32572C4Ec9135221d0691Ba7d202",
  "0x8BB8F32Df04c8b654987DAaeD53D6B6091e3B774",
  "0x9c5AE89C4Af6aA32cE58588DBaF90d18a855B6de",
  "0xDD682daEC5A90dD295d14DA4b0bec9281017b5bE",
  "0xdEB22f54738d54976C4c0fe5ce6d408E40d88499",
];

/**
 * Fetch signed packages for the given feeds from redstone-primary-prod
 * and return the canonical on-chain payload bytes. Requests at least 3
 * distinct signers per feed so the on-chain 3-of-5 threshold passes.
 */
export async function fetchRedStonePayload(
  feedIds: string[],
  uniqueSignersCount = 3,
): Promise<Buffer> {
  const dataPackages = await requestDataPackages({
    dataServiceId: "redstone-primary-prod",
    dataPackagesIds: feedIds,
    uniqueSignersCount,
    authorizedSigners: PRIMARY_PROD_SIGNERS_EVM,
    waitForAllGatewaysTimeMs: 2_000,
    maxTimestampDeviationMS: 10 * 60 * 1000,
    ignoreMissingFeed: false,
  });

  // Flatten: keep all N signed packages per feed.
  const allSigned: import("@redstone-finance/protocol").SignedDataPackage[] = [];
  for (const feedId of feedIds) {
    const pkgs = dataPackages[feedId] ?? [];
    if (pkgs.length < uniqueSignersCount) {
      throw new Error(
        `feed ${feedId}: got ${pkgs.length} signed packages, need ${uniqueSignersCount}`,
      );
    }
    for (const p of pkgs) allSigned.push(p);
  }

  const payload = new RedstonePayload(allSigned, "");
  const hex = payload.toBytesHexWithout0xPrefix();
  return Buffer.from(hex, "hex");
}
