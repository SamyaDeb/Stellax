/**
 * Bridge Keeper — credits inbound Axelar deposits to the StellaX vault.
 *
 * Flow (EVM → Stellar):
 *   1. User calls depositToStellar() on the EVM bridge.
 *   2. Axelar relays the GMP call to the Stellar bridge contract,
 *      which emits a `dep_in` event but does NOT call bridge_collateral_in.
 *   3. This keeper polls the Axelar GMP API for executed deposits whose
 *      destination is the Stellar bridge contract.
 *   4. For each deposit found, the keeper calls bridge_collateral_in() using
 *      the admin key (which is set as ITS in the testnet BridgeConfig).
 *
 * Environment variables (required):
 *   STELLAX_ADMIN_SECRET   — Stellar secret key of the deployer/admin
 *
 * Environment variables (optional, have defaults):
 *   STELLAX_BRIDGE         — Stellar bridge contract ID
 *   STELLAR_RPC_URL        — Soroban RPC endpoint
 *   STELLAR_NETWORK_PASSPHRASE
 *   BRIDGE_KEEPER_INTERVAL_MS  — polling interval (default 15 000)
 */

import { BaseWorker } from "../worker.js";
import { SorobanClient, scVal } from "../stellar.js";
import { getLogger } from "../logger.js";
import { Networks } from "@stellar/stellar-sdk";
import {
  decodeDepositPayload,
  fetchBridgeDeposits,
  type GmpEvent,
} from "@stellax/sdk";

// ── Constants ────────────────────────────────────────────────────────────────

/** Deployed Stellar bridge contract (set by init-bridge.sh). */
const BRIDGE_CONTRACT =
  process.env.STELLAX_BRIDGE ??
  "CDTZX3CTVVHN67ONILVY7PHSQDGZHMKCP3EM4NHATYUYA5J5NYSDZMVL";

/**
 * Known EVM bridge deployments (Phase G multi-chain).
 *
 * The keeper queries the Axelar GMP API by `destinationContractAddress`
 * (the Stellar bridge), so inbound deposits from all these source chains are
 * picked up automatically. This list is exported for diagnostics, trusted-
 * source registration, and potential per-chain filtering.
 */
export const EVM_BRIDGES: ReadonlyArray<{ chain: string; address: string }> = [
  { chain: "Avalanche", address: "0xa0b38B5F76C97e05DA9AcA0e2bd7788fBF0F207A" },
  // Phase G mainnet deployments — addresses filled in after Foundry deploy.
  { chain: "arbitrum",  address: process.env.STELLAX_BRIDGE_ARBITRUM ?? "" },
  { chain: "base",      address: process.env.STELLAX_BRIDGE_BASE     ?? "" },
  { chain: "optimism",  address: process.env.STELLAX_BRIDGE_OPTIMISM ?? "" },
];

/** Axelar ITS token ID for aUSDC (32 zero bytes for testnet placeholder). */
const USDC_TOKEN_ID = new Uint8Array(32);

/** Number of seconds to look back when first polling. */
const INITIAL_LOOKBACK_SECONDS = 86_400; // 24 hours

// ── Worker ────────────────────────────────────────────────────────────────────

export interface BridgeKeeperDeps {
  stellar: SorobanClient;
  bridgeContractId: string;
  pollIntervalMs: number;
}

export class BridgeKeeper extends BaseWorker {
  readonly name = "bridge-keeper";

  /** Tracks GMP IDs we have already processed to avoid double-crediting. */
  private readonly processed = new Set<string>();

  /** Timestamp (ms) from which to look for new deposits. */
  private fromTimestamp: number;

  constructor(private readonly deps: BridgeKeeperDeps) {
    super();
    this.log = getLogger(this.name);
    this.fromTimestamp = Date.now() - INITIAL_LOOKBACK_SECONDS * 1000;
  }

  async tick(): Promise<void> {
    const events = await this.fetchPendingDeposits();
    if (events.length === 0) {
      this.log.debug("no pending deposits");
      return;
    }

    this.log.info({ count: events.length }, "found pending deposits");

    for (const event of events) {
      await this.processDeposit(event);
    }

    // Advance the scan window
    this.fromTimestamp = Date.now() - 60_000; // small overlap to catch stragglers
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Queries the Axelar GMP API for deposits that have been executed (relayed
   * to Stellar) but not yet processed by this keeper.
   */
  private async fetchPendingDeposits(): Promise<GmpEvent[]> {
    const fromSec = Math.floor(this.fromTimestamp / 1000);
    try {
      const events = await fetchBridgeDeposits(BRIDGE_CONTRACT, {
        fromTime: fromSec,
        size: 50,
      });
      return events.filter((e) => !this.processed.has(e.id));
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, "GMP API fetch failed");
      return [];
    }
  }

  /** Credits one inbound deposit to the vault. */
  private async processDeposit(event: GmpEvent): Promise<void> {
    const payload = event.call.returnValues?.payload;
    if (!payload) {
      this.log.warn({ id: event.id }, "deposit event missing payload; skipping");
      this.processed.add(event.id);
      return;
    }

    const decoded = decodeDepositPayload(payload);
    if (!decoded) {
      this.log.warn({ id: event.id, payload }, "could not decode payload; skipping");
      this.processed.add(event.id);
      return;
    }

    const { stellarRecipient, amount } = decoded;

    if (!stellarRecipient.startsWith("G") || stellarRecipient.length !== 56) {
      this.log.warn(
        { id: event.id, stellarRecipient },
        "decoded recipient is not a valid Stellar address; skipping",
      );
      this.processed.add(event.id);
      return;
    }

    if (amount <= 0n) {
      this.log.warn({ id: event.id, amount: amount.toString() }, "zero amount; skipping");
      this.processed.add(event.id);
      return;
    }

    this.log.info(
      { id: event.id, recipient: stellarRecipient, amount: amount.toString() },
      "crediting vault",
    );

    try {
      const adminAddress = this.deps.stellar.publicKey();

      // EVM aUSDC has 6 decimals; Stellar USDC has 7.  The bridge contract
      // passes the raw amount to vault.credit() which treats it as the local
      // token's precision (7dp).  Without this ×10 the user receives 1/10th.
      const stellarAmount = amount * 10n;

      const result = await this.deps.stellar.invoke(
        this.deps.bridgeContractId,
        "bridge_collateral_in",
        [
          scVal.address(adminAddress),      // caller (= ITS on testnet)
          scVal.address(stellarRecipient),  // user
          scVal.bytes(USDC_TOKEN_ID),       // token_id (32 zero bytes for testnet)
          scVal.i128(stellarAmount),        // amount (7dp Stellar native)
        ],
      );

      this.log.info(
        { id: event.id, txHash: result.hash, recipient: stellarRecipient, amount: amount.toString() },
        "bridge_collateral_in succeeded",
      );
    } catch (err) {
      // Do not mark as processed — will retry next tick.
      this.log.error(
        { id: event.id, err: (err as Error).message },
        "bridge_collateral_in failed; will retry",
      );
      return;
    }

    // Mark processed only after successful on-chain call.
    this.processed.add(event.id);
  }
}

// ── Standalone entry point ────────────────────────────────────────────────────

if (import.meta.url === new URL(process.argv[1], "file://").href) {
  const { config: loadDotenv } = await import("dotenv");
  loadDotenv();

  const adminSecret = process.env.STELLAX_ADMIN_SECRET;
  if (!adminSecret) {
    console.error("Error: STELLAX_ADMIN_SECRET env var is required");
    process.exit(1);
  }

  const rpcUrl =
    process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
  const networkPassphrase =
    process.env.STELLAR_NETWORK_PASSPHRASE ?? Networks.TESTNET;
  const intervalMs = Number(
    process.env.BRIDGE_KEEPER_INTERVAL_MS ?? "15000",
  );

  const soroban = new SorobanClient({
    rpcUrl,
    horizonUrl: process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org",
    networkPassphrase,
    secretKey: adminSecret,
  });

  const keeper = new BridgeKeeper({
    stellar: soroban,
    bridgeContractId: BRIDGE_CONTRACT,
    pollIntervalMs: intervalMs,
  });

  console.log(`Bridge keeper starting (interval=${intervalMs}ms) ...`);
  console.log(`  Admin: ${soroban.publicKey()}`);
  console.log(`  Bridge: ${BRIDGE_CONTRACT}`);

  await keeper.start(intervalMs);

  // Keep the process alive
  process.on("SIGINT", async () => {
    console.log("\nShutting down bridge keeper...");
    await keeper.stop();
    process.exit(0);
  });
}
