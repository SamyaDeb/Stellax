import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // Each on-chain tx can take 5-20s (simulate + submit + poll).
    // On testnet under load a single tx can take up to ~3 min; set generous headroom.
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // Run tests serially; on-chain state must be deterministic.
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    sequence: { concurrent: false },
    reporters: ["verbose"],
  },
});
