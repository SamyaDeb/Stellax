/**
 * parseCloseEvents.ts
 *
 * Extracts the PnL breakdown for a `close_position` transaction by querying
 * the Soroban RPC `getEvents` endpoint instead of `getTransaction`.
 *
 * WHY getEvents instead of getTransaction:
 *   The executor's `getTransaction` call can fail with an XDR union parse
 *   error on Protocol 26+ nodes ("Bad union switch: N") because older SDK
 *   versions cannot deserialize every field of the full transaction meta.
 *   `getEvents` only returns typed event topics + data ScVals, which the
 *   current SDK version handles correctly, so it's immune to that failure.
 *
 * Events parsed:
 *   posclose  → exit_price (18-dp), net_pnl (18-dp, signed)      [perp engine]
 *   movebal   → close_fee  (18-dp, user → treasury leg)           [perp engine]
 *   liq       → oracle_price, remaining_margin, keeper_reward     [risk contract]
 *
 * Returns null on any error; callers treat null as "PnL unavailable".
 */

import { Address, xdr } from "@stellar/stellar-sdk";
import { getRpcServer } from "./rpc";
import { config } from "@/config";

export interface CloseEventResult {
  /** Exit mark price at close, 18-decimal fixed-point. */
  exitPrice: bigint;
  /**
   * Net realised PnL after close fee, 18-decimal fixed-point.
   * Positive = profit, negative = loss.
   */
  netPnl: bigint;
  /**
   * Close fee charged to user (moved user → treasury), 18-dp.
   * May be 0n if the movebal event cannot be correlated.
   */
  closeFee: bigint;
}

/**
 * Decode a Soroban `scvI128` ScVal to a JavaScript BigInt.
 * Handles both positive and negative values via two's-complement.
 */
function decodeI128(val: xdr.ScVal): bigint {
  const parts = val.i128();
  const hi = BigInt(parts.hi().toString());
  const lo = BigInt.asUintN(64, BigInt(parts.lo().toString()));
  if (hi >= 0n) {
    return (hi << 64n) | lo;
  }
  const absHi = ~hi;
  const absLo = lo === 0n ? 0n : (~lo + 1n) & 0xffff_ffff_ffff_ffffn;
  return -(((absHi + (lo === 0n ? 0n : 1n)) << 64n) | absLo);
}

/** Read the string symbol from an ScVal topic; returns undefined if not a symbol. */
function topicSymbol(v: xdr.ScVal): string | undefined {
  try {
    if (v.switch().value === xdr.ScValType.scvSymbol().value) {
      return v.sym().toString();
    }
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * Fetch close-position PnL data via `getEvents`.
 *
 * @param positionId  On-chain position ID (u64 on-chain, bigint in JS).
 * @param latestLedger  The `latestLedger` returned in `InvokeResult`.
 *                      The tx landed at or before this ledger; we search
 *                      the 10 ledgers preceding it to be safe.
 */
export async function parseCloseEvents(
  positionId: bigint,
  latestLedger: number,
): Promise<CloseEventResult | null> {
  try {
    const server = getRpcServer();
    const perpEngine = config.contracts.perpEngine;

    // Encode topic symbols as base64 XDR for the filter.
    const poscloseSymbol = xdr.ScVal.scvSymbol("posclose").toXDR("base64");
    const movebalSymbol = xdr.ScVal.scvSymbol("movebal").toXDR("base64");

    // Search 10 ledgers back from latestLedger — the tx landed at or before it.
    const startLedger = Math.max(1, latestLedger - 10);

    const resp = await server.getEvents({
      startLedger,
      endLedger: latestLedger,
      filters: [
        // posclose events from the perp engine
        {
          type: "contract",
          contractIds: [perpEngine],
          topics: [[poscloseSymbol]],
        },
        // movebal events from the perp engine (close fee + payout)
        {
          type: "contract",
          contractIds: [perpEngine],
          topics: [[movebalSymbol]],
        },
      ],
      limit: 200,
    });

    let exitPrice: bigint | undefined;
    let netPnl: bigint | undefined;
    let closeFee: bigint | undefined;
    let closeTxHash: string | undefined;

    // ── Pass 1: find the posclose event for our positionId ──────────────────
    for (const ev of resp.events) {
      const topics = ev.topic;
      if (topics.length === 0) continue;
      if (topicSymbol(topics[0]!) !== "posclose") continue;

      // topics[2] is u64 positionId — verify it matches
      if (topics.length >= 3) {
        try {
          const pidScVal = topics[2]!;
          if (pidScVal.switch().value !== xdr.ScValType.scvU64().value) continue;
          const onChainPid = BigInt(pidScVal.u64().toString());
          if (onChainPid !== positionId) continue;
        } catch {
          continue; // can't verify positionId — skip
        }
      }

      // Parse data: vec[ i128:exit_price, i128:net_pnl ]
      try {
        const vec = ev.value.vec();
        if (vec && vec.length >= 2) {
          exitPrice = decodeI128(vec[0]!);
          netPnl = decodeI128(vec[1]!);
          closeTxHash = ev.txHash; // remember tx hash to correlate movebal
        }
      } catch {
        // malformed — skip
      }
      break; // found our posclose event
    }

    if (exitPrice === undefined || netPnl === undefined) {
      return null;
    }

    // ── Pass 2: find the first movebal event from the same transaction ───────
    // The perp engine emits fee-transfer (user → treasury) before payout
    // (treasury → user), so the first movebal in the same tx is the close fee.
    for (const ev of resp.events) {
      const topics = ev.topic;
      if (topics.length === 0) continue;
      if (topicSymbol(topics[0]!) !== "movebal") continue;
      // Correlate by txHash so we don't pick up fees from other closes in the
      // same ledger range.
      if (closeTxHash !== undefined && ev.txHash !== closeTxHash) continue;

      try {
        closeFee = decodeI128(ev.value);
      } catch {
        // ignore malformed
      }
      break;
    }

    return {
      exitPrice,
      netPnl,
      closeFee: closeFee ?? 0n,
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Liquidation event parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * On-chain `liq` event data decoded from the risk contract.
 *
 * Contract emits:
 *   topics: [sym:"liq", addr:user, u64:positionId]
 *   data:   (i128:oracle_price_18dp, i128:remaining_margin_18dp, i128:keeper_reward_18dp)
 */
export interface LiqEventResult {
  positionId: bigint;
  /** Oracle price used for liquidation, 18-decimal fixed-point. */
  oraclePrice: bigint;
  /**
   * Collateral returned to the user after penalty deduction, 18-dp.
   * May be 0 if equity was fully wiped out.
   */
  remainingMargin: bigint;
  /**
   * Keeper reward portion of the liquidation penalty, 18-dp.
   * The insurance fund receives an equal amount (50/50 split at default config).
   */
  keeperReward: bigint;
  /** Stellar transaction hash of the liquidation tx. */
  txHash: string;
}

/**
 * Scan the last ~30 ledgers (~2.5 min on testnet) for `liq` events from the
 * risk contract that match the given user address.
 *
 * Designed to be polled every 5 s in the UI so the session store can detect
 * keeper-initiated liquidations and surface them in the History blotter.
 *
 * @param userAddress  Stellar G-address of the connected wallet.
 * @returns            Array of matching liq events (typically empty).
 */
export async function parseLiqEventsForUser(
  userAddress: string,
): Promise<LiqEventResult[]> {
  try {
    const server = getRpcServer();
    const riskContract = config.contracts.risk;

    const { sequence: latestLedger } = await server.getLatestLedger();
    const startLedger = Math.max(1, latestLedger - 30);

    const liqSymbol = xdr.ScVal.scvSymbol("liq").toXDR("base64");
    const resp = await server.getEvents({
      startLedger,
      endLedger: latestLedger,
      filters: [
        {
          type: "contract",
          contractIds: [riskContract],
          topics: [[liqSymbol]],
        },
      ],
      limit: 100,
    });

    const results: LiqEventResult[] = [];

    for (const ev of resp.events) {
      const topics = ev.topic;
      if (topics.length < 3) continue;
      if (topicSymbol(topics[0]!) !== "liq") continue;

      // topics[1] is ScvAddress — verify it matches the connected wallet
      try {
        const addrScVal = topics[1]!;
        if (addrScVal.switch().value !== xdr.ScValType.scvAddress().value) continue;
        const evAddr = Address.fromScAddress(addrScVal.address()).toString();
        if (evAddr !== userAddress) continue;
      } catch {
        continue;
      }

      // topics[2] is u64 positionId
      let positionId: bigint;
      try {
        const pidScVal = topics[2]!;
        if (pidScVal.switch().value !== xdr.ScValType.scvU64().value) continue;
        positionId = BigInt(pidScVal.u64().toString());
      } catch {
        continue;
      }

      // data: tuple (oracle_price, remaining_margin, keeper_reward) → ScVec of 3 i128
      let oraclePrice = 0n;
      let remainingMargin = 0n;
      let keeperReward = 0n;
      try {
        const vec = ev.value.vec();
        if (vec && vec.length >= 3) {
          oraclePrice = decodeI128(vec[0]!);
          remainingMargin = decodeI128(vec[1]!);
          keeperReward = decodeI128(vec[2]!);
        }
      } catch {
        // accept with zero defaults
      }

      results.push({
        positionId,
        oraclePrice,
        remainingMargin,
        keeperReward,
        txHash: ev.txHash,
      });
    }

    return results;
  } catch {
    return [];
  }
}
