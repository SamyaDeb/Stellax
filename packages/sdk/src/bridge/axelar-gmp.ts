/**
 * Axelar GMP helpers for StellaX bridge deposits.
 *
 * Reused by the bridge-keeper (server-side) and the frontend deposit-history
 * component (browser-side).  All functions are environment-agnostic — no
 * Node-only globals (Buffer, process, etc.).
 */

/** ── Types ────────────────────────────────────────────────────────────────── */

export interface GmpEvent {
  id: string;
  call: {
    transaction: {
      hash: string;
    };
    block_timestamp?: number; // Unix timestamp (seconds)
    returnValues?: {
      destinationContractAddress?: string;
      payload?: string;
    };
  };
  executed?: {
    transactionHash?: string;
    blockNumber?: number;
    status?: string;
  };
  status: string;
  time_spent?: Record<string, number>;
}

export interface GmpSearchResponse {
  data?: GmpEvent[];
  total?: number;
}

export interface DecodedBridgeDeposit {
  stellarRecipient: string;
  amount: bigint;
}

/** ── Constants ────────────────────────────────────────────────────────────── */

const AXELAR_GMP_API = "https://testnet.api.axelarscan.io";

/** ── Helpers ──────────────────────────────────────────────────────────────── */

/** Decode hex bytes to an ASCII string, stopping at the first null byte. */
function hexToString(hex: string): string {
  let str = "";
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.substring(i, i + 2), 16);
    if (byte === 0) break;
    str += String.fromCharCode(byte);
  }
  return str;
}

/**
 * Decodes the ABI-encoded payload from the EVM bridge's `depositToStellar`
 * call.
 *
 * Layout (100 bytes total):
 *   [0..4)   ACTION_DEPOSIT = 0x00000001
 *   [4..36)  field_1: stellarRecipient chars 0-31  (bytes32)
 *   [36..68) field_2: stellarRecipient chars 32-55 in upper 24 bytes,
 *            lower 8 bytes = 0x00
 *   [68..100) field_3: amount as uint128 in lower 16 bytes (big-endian),
 *             upper 16 bytes = 0x00
 *
 * decode_i128 (Rust) reads field_3 as: bytes [offset+16 .. offset+32]
 * = bytes [84..100] = lower 16 bytes of field_3.
 */
export function decodeDepositPayload(hex: string): DecodedBridgeDeposit | null {
  try {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    if (clean.length < 200) return null; // 100 bytes * 2 hex chars

    // action (4 bytes = 8 hex chars)
    const action = parseInt(clean.slice(0, 8), 16);
    if (action !== 1) return null; // ACTION_DEPOSIT

    // field_1: bytes [4..36] = hex [8..72] = stellarRecipient chars 0-31
    const field1 = hexToString(clean.slice(8, 72));

    // field_2: bytes [36..68] = hex [72..120]
    // Upper 24 bytes = stellarRecipient chars 32-55; lower 8 bytes = 0x00 pad
    const field2 = hexToString(clean.slice(72, 120));

    const stellarRecipient = field1 + field2; // 32 + 24 = 56 chars

    // field_3 amount: decode_i128 at FIELD3_OFFSET=68 reads bytes [68+16..68+32] = [84..100]
    // hex offset: 84*2=168 .. 100*2=200, length 32 hex chars = 16 bytes
    const amountHex = clean.slice(168, 200);
    const amount = BigInt("0x" + amountHex);

    return { stellarRecipient, amount };
  } catch {
    return null;
  }
}

/** ── API queries ──────────────────────────────────────────────────────────── */

export interface FetchBridgeDepositsOptions {
  /** Unix timestamp (seconds). Only return deposits executed after this time. */
  fromTime?: number;
  /** Max results per page (default 50). */
  size?: number;
}

/**
 * Query the Axelar GMP API for executed bridge deposits sent to the given
 * Stellar bridge contract.
 *
 * The returned events are *all* deposits to this bridge regardless of
 * recipient; callers should filter by `DecodedBridgeDeposit.stellarRecipient`.
 *
 * Includes a fallback: if the filtered query returns empty, the function
 * retries without the destinationContractAddress filter and filters client-
 * side.  This handles intermittent API indexing lag on testnet.
 */
export async function fetchBridgeDeposits(
  bridgeContract: string,
  opts: FetchBridgeDepositsOptions = {},
): Promise<GmpEvent[]> {
  const baseParams =
    `status=executed` +
    `&fromTime=${opts.fromTime ?? 0}` +
    `&size=${opts.size ?? 50}`;

  // Primary: filtered by destination contract
  const filteredUrl =
    `${AXELAR_GMP_API}/gmp/searchGMP?` +
    `destinationContractAddress=${encodeURIComponent(bridgeContract)}` +
    `&${baseParams}`;

  const res = await fetch(filteredUrl);
  if (!res.ok) {
    throw new Error(`Axelar GMP API returned ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as GmpSearchResponse;
  const events = json.data ?? [];

  if (events.length > 0) {
    return events;
  }

  // Fallback: unfiltered query, then client-side filter.
  // The Axelarscan testnet API occasionally drops the destinationContractAddress
  // index; querying the recent global pool and filtering manually is slower but
  // more reliable.
  const unfilteredUrl = `${AXELAR_GMP_API}/gmp/searchGMP?${baseParams}`;
  const fallbackRes = await fetch(unfilteredUrl);
  if (!fallbackRes.ok) return [];
  const fallbackJson = (await fallbackRes.json()) as GmpSearchResponse;
  const all = fallbackJson.data ?? [];
  return all.filter(
    (e) =>
      e.call?.returnValues?.destinationContractAddress === bridgeContract,
  );
}
