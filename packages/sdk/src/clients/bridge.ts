/**
 * StellaxBridge — Axelar GMP bridge for cross-chain collateral.
 *
 * Actual ABI (confirmed by e2e):
 *   version() → u32
 *   get_config() → BridgeConfig
 *   is_trusted_source(chain_name: String, remote_address: String) → bool
 *   set_trusted_source(chain_name: String, remote_address: String) → void  [admin]
 *   remove_trusted_source(chain_name: String) → void                        [admin]
 *   register_token(token_id: BytesN<32>, local_token: Address) → void       [admin]
 *   get_local_token(token_id: BytesN<32>) → Option<Address>
 *   send_message(caller, dest_chain, dest_address, payload, gas_token, gas_amount) → void
 *   bridge_collateral_in(caller, user, token_id, amount) → void
 *
 * Notes:
 *  • chain_name and remote_address are Soroban String type → use scvString (NOT scvSymbol)
 *  • BytesN<32> token_id → encode with scvBytes
 *  • send_message / execute require a live Axelar relayer — not testable in unit e2e
 *  • get_local_token returns null for unregistered IDs
 */

import { xdr } from "@stellar/stellar-sdk";
import { ContractClient } from "../core/client.js";
import { enc, dec } from "../core/scval.js";
import type { InvokeOptions, InvokeResult } from "../core/executor.js";
import type { BridgeDeposit } from "../core/types.js";

/** Bridge configuration struct. */
export interface BridgeConfig {
  admin: string;
  gateway: string;
  gasService: string;
  its: string;
  vault: string;
  treasury: string;
  protocolFeeBps: number;
  /** Minimum validator attestations required to release a deposit. Default 1. */
  minValidators: number;
}

/** Encode a Soroban String argument (chain names, EVM addresses). */
function strVal(s: string): xdr.ScVal {
  return xdr.ScVal.scvString(Buffer.from(s, "utf8"));
}

/** Encode a BytesN<32> token ID. */
function tokenIdVal(b: Uint8Array): xdr.ScVal {
  return xdr.ScVal.scvBytes(Buffer.from(b));
}

function decodeBridgeConfig(v: xdr.ScVal | undefined): BridgeConfig {
  const o = (dec.raw(v) as Record<string, unknown>) ?? {};
  return {
    admin: String(o.admin),
    gateway: String(o.gateway),
    gasService: String(o.gas_service),
    its: String(o.its ?? ""),
    vault: String(o.vault),
    treasury: String(o.treasury),
    protocolFeeBps: Number(o.protocol_fee_bps),
    minValidators: 1,
  };
}

export class BridgeClient extends ContractClient {
  // ─── Reads ─────────────────────────────────────────────────────────────────

  version(): Promise<number> {
    return this.simulateReturn("version", [], dec.number);
  }

  /** Full bridge configuration including admin, Axelar gateway, vault, and fee. */
  getConfig(): Promise<BridgeConfig> {
    return this.simulateReturn("get_config", [], decodeBridgeConfig);
  }

  /**
   * Check whether a remote chain + address pair is a trusted Axelar source.
   * @param chainName     e.g. "Avalanche", "ethereum"
   * @param remoteAddress e.g. "0x0000000000000000000000000000000000000000"
   */
  isTrustedSource(chainName: string, remoteAddress: string): Promise<boolean> {
    return this.simulateReturn(
      "is_trusted_source",
      [strVal(chainName), strVal(remoteAddress)],
      dec.bool,
    );
  }

  /**
   * Resolve a 32-byte cross-chain token ID to its local Stellar token address.
   * Returns null if the token is not registered.
   */
  getLocalToken(tokenId: Uint8Array): Promise<string | null> {
    return this.simulateReturn("get_local_token", [tokenIdVal(tokenId)], (v) => {
      const native = dec.raw(v);
      if (native === null || native === undefined) return null;
      return String(native);
    });
  }

  // ─── Writes ────────────────────────────────────────────────────────────────

  /**
   * Register a remote chain source as trusted (admin only).
   * @param chainName     Chain identifier (Soroban String)
   * @param remoteAddress Remote contract/address on that chain
   */
  setTrustedSource(
    chainName: string,
    remoteAddress: string,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "set_trusted_source",
      [strVal(chainName), strVal(remoteAddress)],
      opts,
    );
  }

  /**
   * Remove a previously registered trusted source (admin only).
   * @param chainName  The chain to deregister
   */
  removeTrustedSource(chainName: string, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("remove_trusted_source", [strVal(chainName)], opts);
  }

  /**
   * Map a cross-chain token ID to a local Stellar token address (admin only).
   * @param tokenId    32-byte identifier from the source chain
   * @param localToken Stellar token contract address (e.g. USDC SAC)
   */
  registerToken(
    tokenId: Uint8Array,
    localToken: string,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "register_token",
      [tokenIdVal(tokenId), enc.address(localToken)],
      opts,
    );
  }

  /**
   * Send a cross-chain message via Axelar GMP (requires live relayer).
   */
  sendMessage(
    caller: string,
    destinationChain: string,
    destinationAddress: string,
    payload: Uint8Array,
    gasToken: string,
    gasAmount: bigint,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "send_message",
      [
        enc.address(caller),
        strVal(destinationChain),
        strVal(destinationAddress),
        enc.bytes(payload),
        enc.address(gasToken),
        enc.i128(gasAmount),
      ],
      opts,
    );
  }

  /**
   * Bridge collateral inbound — credits a user's vault from a verified cross-chain message.
   */
  bridgeCollateralIn(
    caller: string,
    user: string,
    tokenId: Uint8Array,
    amount: bigint,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "bridge_collateral_in",
      [
        enc.address(caller),
        enc.address(user),
        tokenIdVal(tokenId),
        enc.i128(amount),
      ],
      opts,
    );
  }

  upgrade(newWasmHash: Uint8Array, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("upgrade", [enc.bytesN(newWasmHash)], opts);
  }

  // ─── Convenience / UI helpers ──────────────────────────────────────────────

  /**
   * Registered bridge validators. No on-chain enumeration; returns empty until
   * an indexer is available.
   */
  listValidators(): Promise<string[]> {
    return Promise.resolve([]);
  }

  /**
   * Look up a bridge deposit by Axelar GMP transaction ID (numeric deposit IDs
   * are not used; pass the GMP id as a BigInt representation of the hash).
   *
   * Queries the Axelar GMP scan API for the event. Returns undefined if not
   * found or if the API is unreachable.
   */
  async getDeposit(id: bigint): Promise<BridgeDeposit | undefined> {
    // Convert the numeric id back to a 32-byte hex tx hash if the caller
    // stored it that way; otherwise treat id as an opaque key and skip.
    const txHash = `0x${id.toString(16).padStart(64, "0")}`;
    try {
      const url = `https://testnet.api.gmp.axelarscan.io/gmp/searchGMP?txHash=${encodeURIComponent(txHash)}`;
      const res = await fetch(url);
      if (!res.ok) return undefined;
      const json = (await res.json()) as {
        data?: {
          id?: string;
          call?: {
            transaction?: { hash?: string; from?: string };
            blockNumber?: number;
            returnValues?: { payload?: string };
          };
          status?: string;
          callTx?: { blockTimestamp?: number };
        }[];
      };
      const event = json.data?.[0];
      if (!event) return undefined;

      const payload = event.call?.returnValues?.payload ?? "";
      // Parse amount from the ABI-encoded payload (bytes 64..80 = lower 16 bytes of field3)
      let amount = 0n;
      let destAddress = new Uint8Array(20);
      if (payload.length >= 192) {
        const clean = payload.startsWith("0x") ? payload.slice(2) : payload;
        const amountHex = clean.slice(64 * 2, 64 * 2 + 32);
        try { amount = BigInt("0x" + amountHex); } catch { amount = 0n; }
      }

      return {
        depositId: id,
        user: event.call?.transaction?.from ?? "",
        amount,
        destChain: "stellar",
        destAddress,
        released: event.status === "executed",
        timestamp: BigInt(event.callTx?.blockTimestamp ?? 0),
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Returns the number of Axelar validator attestations for a deposit.
   * Queries the GMP API and counts validator confirmations in the event.
   */
  async getAttestationCount(id: bigint): Promise<number> {
    const txHash = `0x${id.toString(16).padStart(64, "0")}`;
    try {
      const url = `https://testnet.api.gmp.axelarscan.io/gmp/searchGMP?txHash=${encodeURIComponent(txHash)}`;
      const res = await fetch(url);
      if (!res.ok) return 0;
      const json = (await res.json()) as {
        data?: { confirm?: { votes?: unknown[] }; status?: string }[];
      };
      const event = json.data?.[0];
      if (!event) return 0;
      if (event.status === "executed") return 999; // treat as fully attested
      return event.confirm?.votes?.length ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Lock funds and bridge out via Axelar GMP. Maps to `send_message`.
   * @param params.destChain     Destination chain identifier (e.g. "ethereum")
   * @param params.destAddress   Destination address as 20-byte EVM address array
   */
  lock(params: {
    user: string;
    amount: bigint;
    destChain: string;
    destAddress: Uint8Array;
    /**
     * Token contract address used as gas_token for Axelar GMP (e.g. USDC SAC).
     * Must be a valid Soroban contract address, not a user G-address.
     */
    gasToken: string;
    opts: InvokeOptions;
  }): Promise<InvokeResult> {
    // Encode the destination EVM address as a hex string for the relayer payload.
    const destHex =
      "0x" +
      Array.from(params.destAddress)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    const payload = new TextEncoder().encode(
      JSON.stringify({ user: params.user, amount: params.amount.toString() }),
    );
    return this.sendMessage(
      params.user,
      params.destChain,
      destHex,
      payload,
      // gas_token: token contract address (gas_amount=0 — Axelar relayer pays)
      params.gasToken,
      0n,
      params.opts,
    );
  }

  /**
   * Release a validated inbound deposit on Stellar.
   * No on-chain release endpoint in the current bridge ABI; this is a stub.
   */
  release(
    _source: string,
    _depositId: bigint,
    _opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return Promise.resolve({
      status: "FAILED" as const,
      hash: "",
      returnValue: undefined,
      latestLedger: 0,
    });
  }
}
