/**
 * useClosedTradesOnChain
 *
 * Supplements the session store by scanning recent Soroban events for
 * closed-trade records.  Two event streams are consumed:
 *
 *   1. `posclose` events from perp_engine — matched against position IDs
 *      tracked in the session store (open positions + previously recorded
 *      closes).  Per-trade metadata (market, direction, size, entry price)
 *      is taken from the session store.
 *
 *   2. `liq` events from the risk contract — filtered directly by the
 *      connected wallet address (topics[1]), so they don't require prior
 *      session knowledge.  Full records are emitted when position metadata
 *      is in the session store; partial records (zero-filled metadata) are
 *      emitted otherwise.
 *
 * Returns a merged, deduplicated list sorted newest-first.
 * On-chain records take precedence over session-only entries for the same
 * positionId.  Falls back gracefully to the session store on any RPC error.
 */

import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useEffect } from "react";
import { Address, xdr } from "@stellar/stellar-sdk";
import type { ClosedTrade } from "@/stores/sessionStore";
import { useSessionStore } from "@/stores/sessionStore";
import { getRpcServer } from "@/stellar/rpc";
import { config, hasContract } from "@/config";

// ── internal position-metadata snapshot ──────────────────────────────────────

interface PositionMeta {
  marketId: number;
  isLong: boolean;
  leverage: number;
  entryPrice: bigint;
  size: bigint;
}

// ── helpers (duplicated from parseCloseEvents.ts to keep the hook self-contained) ──

function decodeI128(val: xdr.ScVal): bigint {
  const parts = val.i128();
  const hi = BigInt(parts.hi().toString());
  const lo = BigInt.asUintN(64, BigInt(parts.lo().toString()));
  if (hi >= 0n) return (hi << 64n) | lo;
  const absHi = ~hi;
  const absLo = lo === 0n ? 0n : (~lo + 1n) & 0xffff_ffff_ffff_ffffn;
  return -(((absHi + (lo === 0n ? 0n : 1n)) << 64n) | absLo);
}

function topicSym(v: xdr.ScVal): string | undefined {
  try {
    if (v.switch().value === xdr.ScValType.scvSymbol().value) {
      return v.sym().toString();
    }
  } catch {
    // ignore
  }
  return undefined;
}

// ── core scanner (runs inside useQuery) ──────────────────────────────────────

async function fetchOnChainClosedTrades(
  userAddress: string,
  knownPositions: Map<bigint, PositionMeta>,
): Promise<ClosedTrade[]> {
  const server = getRpcServer();
  const { sequence: latestLedger } = await server.getLatestLedger();
  // Scan the last ~200 ledgers (~16 min on testnet at ~5 s / ledger).
  const startLedger = Math.max(1, latestLedger - 200);

  const poscloseXdr = xdr.ScVal.scvSymbol("posclose").toXDR("base64");
  const movebalXdr  = xdr.ScVal.scvSymbol("movebal").toXDR("base64");
  const liqXdr      = xdr.ScVal.scvSymbol("liq").toXDR("base64");

  const resp = await server.getEvents({
    startLedger,
    endLedger: latestLedger,
    filters: [
      {
        type: "contract",
        contractIds: [config.contracts.perpEngine],
        topics: [[poscloseXdr]],
      },
      {
        type: "contract",
        contractIds: [config.contracts.perpEngine],
        topics: [[movebalXdr]],
      },
      {
        type: "contract",
        contractIds: [config.contracts.risk],
        topics: [[liqXdr]],
      },
    ],
    limit: 500,
  });

  // ── index the first movebal per txHash (= close fee debit) ───────────────
  const feeByTx = new Map<string, bigint>();
  for (const ev of resp.events) {
    const sym = topicSym(ev.topic[0] ?? xdr.ScVal.scvVoid());
    if (sym !== "movebal") continue;
    if (feeByTx.has(ev.txHash)) continue; // only first movebal is the fee
    try {
      feeByTx.set(ev.txHash, decodeI128(ev.value));
    } catch {
      // ignore malformed
    }
  }

  const results: ClosedTrade[] = [];
  const seen = new Set<bigint>();

  // ── posclose events ───────────────────────────────────────────────────────
  for (const ev of resp.events) {
    const topics = ev.topic;
    if (topics.length < 3) continue;
    if (topicSym(topics[0] ?? xdr.ScVal.scvVoid()) !== "posclose") continue;

    // topics[2] is u64 positionId
    let positionId: bigint;
    try {
      const pidScVal = topics[2]!;
      if (pidScVal.switch().value !== xdr.ScValType.scvU64().value) continue;
      positionId = BigInt(pidScVal.u64().toString());
    } catch {
      continue;
    }

    // Only emit for positions whose metadata we know.
    const meta = knownPositions.get(positionId);
    if (meta === undefined) continue;

    if (seen.has(positionId)) continue;
    seen.add(positionId);

    let exitPrice = 0n;
    let netPnl = 0n;
    try {
      const vec = ev.value.vec();
      if (vec && vec.length >= 2) {
        exitPrice = decodeI128(vec[0]!);
        netPnl    = decodeI128(vec[1]!);
      }
    } catch {
      // accept zero defaults
    }

    results.push({
      positionId,
      ...meta,
      exitPrice,
      netPnl,
      closeFee: feeByTx.get(ev.txHash) ?? 0n,
      txHash:   ev.txHash,
      closedAt: new Date(ev.ledgerClosedAt).getTime(),
      kind:     "user",
    });
  }

  // ── liq events — filtered by user address in topics[1] ───────────────────
  for (const ev of resp.events) {
    const topics = ev.topic;
    if (topics.length < 3) continue;
    if (topicSym(topics[0] ?? xdr.ScVal.scvVoid()) !== "liq") continue;

    // Verify topics[1] is the connected wallet.
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

    if (seen.has(positionId)) continue;
    seen.add(positionId);

    let oraclePrice     = 0n;
    let remainingMargin = 0n;
    let keeperReward    = 0n;
    try {
      const vec = ev.value.vec();
      if (vec && vec.length >= 3) {
        oraclePrice     = decodeI128(vec[0]!);
        remainingMargin = decodeI128(vec[1]!);
        keeperReward    = decodeI128(vec[2]!);
      }
    } catch {
      // accept zero defaults
    }

    const meta = knownPositions.get(positionId);
    results.push({
      positionId,
      marketId:   meta?.marketId   ?? 0,
      isLong:     meta?.isLong     ?? false,
      leverage:   meta?.leverage   ?? 0,
      entryPrice: meta?.entryPrice ?? 0n,
      size:       meta?.size       ?? 0n,
      exitPrice:  oraclePrice,
      // netPnl for a liq = what the user got back (remainingMargin).
      // Without the original margin in this event we can't compute a signed
      // P&L; the table renders liquidations with a distinct "LIQUIDATED" badge
      // so the semantic oddity of netPnl = remainingMargin is not shown.
      netPnl:          remainingMargin,
      // Liquidation penalty = keeperReward (50%) + insuranceDelta (50%)
      closeFee:        keeperReward * 2n,
      txHash:          ev.txHash,
      closedAt:        new Date(ev.ledgerClosedAt).getTime(),
      kind:            "liquidation",
      keeperReward,
      insuranceDelta:  keeperReward,
    });
  }

  return results;
}

// ── hook ─────────────────────────────────────────────────────────────────────

/**
 * Returns closed trades merged from the localStorage session store and recent
 * on-chain Soroban events.  On-chain records take precedence; the list is
 * sorted newest-first.
 *
 * @param address  Connected Stellar wallet address, or null when disconnected.
 */
export function useClosedTradesOnChain(address: string | null): ClosedTrade[] {
  const sessionPositions    = useSessionStore((s) => s.positions);
  const sessionClosedTrades = useSessionStore((s) => s.closedTrades);

  // Build position-metadata map: open positions + previously closed trades.
  const knownPositions = useMemo((): Map<bigint, PositionMeta> => {
    const map = new Map<bigint, PositionMeta>();
    for (const p of sessionPositions) {
      map.set(p.positionId, {
        marketId:   p.marketId,
        isLong:     p.isLong,
        leverage:   p.leverage,
        entryPrice: p.entryPrice,
        size:       p.size,
      });
    }
    for (const t of sessionClosedTrades) {
      if (!map.has(t.positionId)) {
        map.set(t.positionId, {
          marketId:   t.marketId,
          isLong:     t.isLong,
          leverage:   t.leverage,
          entryPrice: t.entryPrice,
          size:       t.size,
        });
      }
    }
    return map;
  }, [sessionPositions, sessionClosedTrades]);

  // Keep a stable ref so the queryFn always uses the latest map without
  // causing query-key churn on every position update.
  const knownRef = useRef(knownPositions);
  useEffect(() => { knownRef.current = knownPositions; }, [knownPositions]);

  const enabled =
    address !== null &&
    hasContract(config.contracts.perpEngine) &&
    hasContract(config.contracts.risk);

  const query = useQuery({
    queryKey: ["closedTradesOnChain", address],
    queryFn:  () => fetchOnChainClosedTrades(address!, knownRef.current),
    enabled,
    refetchInterval: 30_000,
    staleTime:       15_000,
    retry: 1,
  });

  const onChainTrades = query.data ?? [];

  // Merge: session store is the baseline; on-chain records overwrite for the
  // same positionId (on-chain values are authoritative).  Sort newest-first.
  return useMemo((): ClosedTrade[] => {
    const merged = new Map<bigint, ClosedTrade>();
    for (const t of sessionClosedTrades) merged.set(t.positionId, t);
    for (const t of onChainTrades)       merged.set(t.positionId, t);
    return Array.from(merged.values()).sort((a, b) => b.closedAt - a.closedAt);
  }, [sessionClosedTrades, onChainTrades]);
}
