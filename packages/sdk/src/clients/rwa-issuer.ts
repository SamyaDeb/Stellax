/**
 * StellaxRwaIssuer — Phase M mock RWA token client.
 *
 * One contract instance exists per supported RWA asset (BENJI, USDY, OUSG).
 * Amounts are token-native decimals (6 on current testnet deployments), not
 * StellaX's 18-decimal internal margin precision.
 */

import { xdr } from "@stellar/stellar-sdk";
import { ContractClient } from "../core/client.js";
import { enc, dec } from "../core/scval.js";
import type { InvokeOptions, InvokeResult } from "../core/executor.js";

export interface RwaIssuerConfig {
  admin: string;
  name: string;
  symbol: string;
  decimals: number;
  apyBps: number;
  authRequired: boolean;
  paused: boolean;
  totalSupply: bigint;
}

function decodeConfig(v: xdr.ScVal | undefined): RwaIssuerConfig {
  const o = (dec.raw(v) as Record<string, unknown>) ?? {};
  return {
    admin: String(o.admin),
    name: String(o.name),
    symbol: String(o.symbol),
    decimals: Number(o.decimals),
    apyBps: Number(o.apy_bps),
    authRequired: Boolean(o.auth_required),
    paused: Boolean(o.paused),
    totalSupply: BigInt(o.total_supply as bigint | number | string),
  };
}

export class RwaIssuerClient extends ContractClient {
  // ─── Reads ─────────────────────────────────────────────────────────────────

  getConfig(): Promise<RwaIssuerConfig> {
    return this.simulateReturn("get_config", [], decodeConfig);
  }

  name(): Promise<string> {
    return this.simulateReturn("name", [], dec.string);
  }

  symbol(): Promise<string> {
    return this.simulateReturn("symbol", [], dec.string);
  }

  decimals(): Promise<number> {
    return this.simulateReturn("decimals", [], dec.number);
  }

  balance(holder: string): Promise<bigint> {
    return this.simulateReturn("balance", [enc.address(holder)], dec.bigint);
  }

  allowance(from: string, spender: string): Promise<bigint> {
    return this.simulateReturn(
      "allowance",
      [enc.address(from), enc.address(spender)],
      dec.bigint,
    );
  }

  cumulativeYield(holder: string): Promise<bigint> {
    return this.simulateReturn(
      "cumulative_yield",
      [enc.address(holder)],
      dec.bigint,
    );
  }

  version(): Promise<number> {
    return this.simulateReturn("version", [], dec.number);
  }

  // ─── User writes ───────────────────────────────────────────────────────────

  approve(
    from: string,
    spender: string,
    amount: bigint,
    expirationLedger: number,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "approve",
      [
        enc.address(from),
        enc.address(spender),
        enc.i128(amount),
        enc.u32(expirationLedger),
      ],
      opts,
    );
  }

  transfer(
    from: string,
    to: string,
    amount: bigint,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "transfer",
      [enc.address(from), enc.address(to), enc.i128(amount)],
      opts,
    );
  }

  transferFrom(
    spender: string,
    from: string,
    to: string,
    amount: bigint,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "transfer_from",
      [enc.address(spender), enc.address(from), enc.address(to), enc.i128(amount)],
      opts,
    );
  }

  burn(from: string, amount: bigint, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("burn", [enc.address(from), enc.i128(amount)], opts);
  }

  burnFrom(
    spender: string,
    from: string,
    amount: bigint,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "burn_from",
      [enc.address(spender), enc.address(from), enc.i128(amount)],
      opts,
    );
  }

  // ─── Admin / keeper writes ────────────────────────────────────────────────

  mint(to: string, amount: bigint, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("mint", [enc.address(to), enc.i128(amount)], opts);
  }

  creditYield(
    holders: string[],
    deltas: bigint[],
    epochId: bigint,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "credit_yield",
      [
        enc.vec(holders.map((h) => enc.address(h))),
        enc.vec(deltas.map((d) => enc.i128(d))),
        enc.u64(epochId),
      ],
      opts,
    );
  }

  setApyBps(apyBps: number, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("set_apy_bps", [enc.u32(apyBps)], opts);
  }

  setAuthorized(holder: string, ok: boolean, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke(
      "set_authorized",
      [enc.address(holder), enc.bool(ok)],
      opts,
    );
  }

  setAuthRequired(required: boolean, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("set_auth_required", [enc.bool(required)], opts);
  }

  pause(opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("pause", [], opts);
  }

  unpause(opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("unpause", [], opts);
  }

  upgrade(newWasmHash: Uint8Array, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("upgrade", [enc.bytesN(newWasmHash)], opts);
  }
}