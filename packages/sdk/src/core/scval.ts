/**
 * ScVal encoding/decoding helpers.
 *
 * Wraps `@stellar/stellar-sdk`'s XDR primitives with StellaX-specific
 * conversions: bigint i128/u64, decoding struct returns into typed objects,
 * symbol/address/bytes shortcuts. All encoders return `xdr.ScVal` so they
 * can be passed straight into `Contract.call`.
 */

import {
  Address,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type {
  Market,
  Position,
  PriceData,
  VaultBalance,
  OpenInterest,
  OptionContract,
  VaultEpoch,
  BridgeDeposit,
  Proposal,
  Vote,
  ProposalState,
  MarginMode,
} from "./types.js";

/** Encoders — input side (JS → XDR). */
export const enc = {
  u32(n: number): xdr.ScVal {
    return nativeToScVal(n, { type: "u32" });
  },
  i32(n: number): xdr.ScVal {
    return nativeToScVal(n, { type: "i32" });
  },
  u64(n: number | bigint): xdr.ScVal {
    return nativeToScVal(typeof n === "number" ? BigInt(n) : n, { type: "u64" });
  },
  i128(n: number | bigint): xdr.ScVal {
    return nativeToScVal(typeof n === "number" ? BigInt(n) : n, { type: "i128" });
  },
  symbol(s: string): xdr.ScVal {
    return nativeToScVal(s, { type: "symbol" });
  },
  string(s: string): xdr.ScVal {
    return nativeToScVal(s, { type: "string" });
  },
  bool(b: boolean): xdr.ScVal {
    return xdr.ScVal.scvBool(b);
  },
  bytes(b: Uint8Array): xdr.ScVal {
    return nativeToScVal(b, { type: "bytes" });
  },
  bytesN(b: Uint8Array): xdr.ScVal {
    // BytesN<32> etc. — encode as bytes; the runtime checks length.
    return xdr.ScVal.scvBytes(Buffer.from(b));
  },
  address(a: string): xdr.ScVal {
    return new Address(a).toScVal();
  },
  vec(items: xdr.ScVal[]): xdr.ScVal {
    return xdr.ScVal.scvVec(items);
  },
  option<T>(v: T | undefined, encoder: (x: T) => xdr.ScVal): xdr.ScVal {
    return v === undefined ? xdr.ScVal.scvVoid() : encoder(v);
  },
  /** Encode a Rust enum unit variant like `MarginMode::Cross`. */
  enumUnit(variant: string): xdr.ScVal {
    return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(variant)]);
  },
  marginMode(m: MarginMode): xdr.ScVal {
    return this.enumUnit(m);
  },
};

/** Decoders — output side (XDR → JS). */
export const dec = {
  raw(v: xdr.ScVal | undefined): unknown {
    if (!v) return undefined;
    return scValToNative(v);
  },
  bigint(v: xdr.ScVal | undefined): bigint {
    const n = scValToNative(v!);
    return typeof n === "bigint" ? n : BigInt(n as number | string);
  },
  number(v: xdr.ScVal | undefined): number {
    const n = scValToNative(v!);
    return typeof n === "number" ? n : Number(n);
  },
  bool(v: xdr.ScVal | undefined): boolean {
    return Boolean(scValToNative(v!));
  },
  string(v: xdr.ScVal | undefined): string {
    return String(scValToNative(v!));
  },
  bytes(v: xdr.ScVal | undefined): Uint8Array {
    const raw = scValToNative(v!);
    return raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBufferLike);
  },
  address(v: xdr.ScVal | undefined): string {
    // scValToNative already returns "G..." for accounts; "C..." for contracts.
    return String(scValToNative(v!));
  },
  vec<T>(v: xdr.ScVal | undefined, mapItem: (item: xdr.ScVal) => T): T[] {
    if (!v) return [];
    const vec = v.vec();
    if (!vec) return [];
    return vec.map(mapItem);
  },
  /** Rust enum unit variants arrive as `[symbol]` */
  enumUnit(v: xdr.ScVal | undefined): string {
    const n = scValToNative(v!) as unknown[];
    return Array.isArray(n) ? String(n[0]) : String(n);
  },
  marginMode(v: xdr.ScVal | undefined): MarginMode {
    const name = this.enumUnit(v);
    return name === "Isolated" ? "Isolated" : "Cross";
  },
  proposalState(v: xdr.ScVal | undefined): ProposalState {
    const name = this.enumUnit(v);
    const states: ProposalState[] = [
      "Pending", "Active", "Defeated", "Succeeded",
      "Queued", "Executed", "Canceled", "Expired",
    ];
    const found = states.find((s) => s === name);
    return found ?? "Pending";
  },
};

/**
 * Struct decoders.
 *
 * scValToNative returns a plain JS object with the Rust field names.
 * We re-key to camelCase and narrow the types.
 */

type AnyRec = Record<string, unknown>;

function objOf(v: xdr.ScVal | undefined): AnyRec {
  return (scValToNative(v!) as AnyRec) ?? {};
}

export const structs = {
  priceData(v: xdr.ScVal | undefined): PriceData {
    const o = objOf(v);
    return {
      price: BigInt(o.price as bigint | number),
      packageTimestamp: BigInt(o.package_timestamp as bigint | number),
      writeTimestamp: BigInt(o.write_timestamp as bigint | number),
    };
  },
  market(v: xdr.ScVal | undefined): Market {
    const o = objOf(v);
    return {
      marketId: Number(o.market_id),
      baseAsset: String(o.base_asset),
      quoteAsset: String(o.quote_asset),
      maxLeverage: Number(o.max_leverage),
      makerFeeBps: Number(o.maker_fee_bps),
      takerFeeBps: Number(o.taker_fee_bps),
      maxOiLong: BigInt(o.max_oi_long as bigint | number),
      maxOiShort: BigInt(o.max_oi_short as bigint | number),
      isActive: Boolean(o.is_active),
    };
  },
  position(v: xdr.ScVal | undefined): Position {
    const o = objOf(v);
    return {
      owner: String(o.owner),
      marketId: Number(o.market_id),
      size: BigInt(o.size as bigint | number),
      entryPrice: BigInt(o.entry_price as bigint | number),
      margin: BigInt(o.margin as bigint | number),
      leverage: Number(o.leverage),
      isLong: Boolean(o.is_long),
      lastFundingIdx: BigInt(o.last_funding_idx as bigint | number),
      openTimestamp: BigInt(o.open_timestamp as bigint | number),
    };
  },
  openInterest(v: xdr.ScVal | undefined): OpenInterest {
    const o = objOf(v);
    return {
      long: BigInt(o.long as bigint | number),
      short: BigInt(o.short as bigint | number),
    };
  },
  vaultBalance(v: xdr.ScVal | undefined): VaultBalance {
    const o = objOf(v);
    return {
      free: BigInt(o.free as bigint | number),
      locked: BigInt(o.locked as bigint | number),
    };
  },
  option(v: xdr.ScVal | undefined): OptionContract {
    const o = objOf(v);
    return {
      optionId: BigInt(o.option_id as bigint | number),
      strike: BigInt(o.strike as bigint | number),
      expiry: BigInt(o.expiry as bigint | number),
      isCall: Boolean(o.is_call),
      size: BigInt(o.size as bigint | number),
      premium: BigInt(o.premium as bigint | number),
      writer: String(o.writer),
      holder: String(o.holder),
      isExercised: Boolean(o.is_exercised),
    };
  },
  vaultEpoch(v: xdr.ScVal | undefined): VaultEpoch {
    const o = objOf(v);
    return {
      epochId: Number(o.epoch_id),
      startTime: BigInt(o.start_time as bigint | number),
      endTime: BigInt(o.end_time as bigint | number),
      totalDeposits: BigInt(o.total_deposits as bigint | number),
      totalPremium: BigInt(o.total_premium as bigint | number),
      settled: Boolean(o.settled),
    };
  },
  bridgeDeposit(v: xdr.ScVal | undefined): BridgeDeposit {
    const o = objOf(v);
    const destAddr = o.dest_address;
    return {
      depositId: BigInt(o.deposit_id as bigint | number),
      user: String(o.user),
      amount: BigInt(o.amount as bigint | number),
      destChain: String(o.dest_chain),
      destAddress:
        destAddr instanceof Uint8Array
          ? destAddr
          : new Uint8Array(destAddr as ArrayBufferLike),
      released: Boolean(o.released),
      timestamp: BigInt(o.timestamp as bigint | number),
    };
  },
  proposal(v: xdr.ScVal | undefined): Proposal {
    const o = objOf(v);
    const hash = o.new_wasm_hash;
    return {
      id: BigInt(o.id as bigint | number),
      proposer: String(o.proposer),
      target: String(o.target),
      newWasmHash:
        hash instanceof Uint8Array ? hash : new Uint8Array(hash as ArrayBufferLike),
      description: String(o.description),
      startTime: BigInt(o.start_time as bigint | number),
      endTime: BigInt(o.end_time as bigint | number),
      eta: BigInt(o.eta as bigint | number),
      forVotes: BigInt(o.for_votes as bigint | number),
      againstVotes: BigInt(o.against_votes as bigint | number),
      executed: Boolean(o.executed),
      canceled: Boolean(o.canceled),
    };
  },
  vote(v: xdr.ScVal | undefined): Vote {
    const o = objOf(v);
    return {
      support: Boolean(o.support),
      weight: BigInt(o.weight as bigint | number),
    };
  },
};
