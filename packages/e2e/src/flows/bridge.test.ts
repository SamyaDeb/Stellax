// ── Bridge e2e: admin lifecycle + trusted-source + token registry ─────────────
//
// Bridge was deployed and initialized with:
//   admin     = deployer
//   gateway   = CCSNWHMQ… (Axelar testnet gateway)
//   vault     = ctx.deployments.vault
//   treasury  = ctx.deployments.treasury
//   fee_bps   = 5
//
// Post-deploy wiring added:
//   set_trusted_source("Avalanche", "0x0000000000000000000000000000000000000000")
//
// NOTE: inbound GMP `execute` and outbound `send_message` require a live Axelar
// relayer and are not exercised here. This suite tests all admin state-mutation
// and read paths that do not depend on the Axelar network.
//
// Flow:
//  1. version()   → current deployed bridge version.
//  2. get_config() → admin=deployer, fee_bps=5.
//  3. is_trusted_source("Avalanche", EVM bridge) → true (wired at deploy time).
//  4. is_trusted_source("Avalanche", "0xDeadBeef") → false.
//  5. set_trusted_source("ethereum", "0xDeadBeef") → then is_trusted_source → true.
//  6. remove_trusted_source("ethereum") → is_trusted_source → false.
//  7. register_token(token_id_32, USDC_addr) → get_local_token → USDC_addr.
//  8. get_local_token(unknown_id) → null (None).

import { beforeAll, describe, expect, it } from "vitest";
import { xdr } from "@stellar/stellar-sdk";

import { getCtx } from "../lib/fixtures.js";
import { invoke, simulateRead } from "../lib/invoke.js";
import { addrVal, bytesVal, symbolVal } from "../lib/scval.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Encode a Soroban String as ScVal for contract call arguments. */
function strVal(s: string): xdr.ScVal {
  return xdr.ScVal.scvString(Buffer.from(s, "utf8"));
}

/** Encode a BytesN<32> as ScVal. */
function bytes32Val(b: Uint8Array): xdr.ScVal {
  return xdr.ScVal.scvBytes(Buffer.from(b));
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("bridge", () => {
  const ctx = getCtx();

  const TRUSTED_CHAIN = "Avalanche";
  const TRUSTED_ADDR = "0xa0b38B5F76C97e05DA9AcA0e2bd7788fBF0F207A";
  const ETH_CHAIN = "ethereum";
  const ETH_ADDR = "0xDeadBeef";

  // A deterministic 32-byte token_id for test token registration.
  const TOKEN_ID = new Uint8Array(32).fill(0xab);

  beforeAll(async () => {
    console.log("  ▸ bridge e2e setup (no extra funding needed)");
  });

  // ── Test 1: version ────────────────────────────────────────────────────────

  it("version() returns deployed bridge version", async () => {
    const v = await simulateRead<number>(
      ctx.net,
      ctx.deployer.publicKey(),
      ctx.deployments.bridge,
      "version",
      [],
    );
    console.log(`    bridge version: ${v}`);
    expect(v).toBeGreaterThanOrEqual(2);
  });

  // ── Test 2: get_config ─────────────────────────────────────────────────────

  it("get_config() returns correct admin and fee_bps", async () => {
    const config = await simulateRead<Record<string, unknown>>(
      ctx.net,
      ctx.deployer.publicKey(),
      ctx.deployments.bridge,
      "get_config",
      [],
    );
    console.log(`    admin: ${config.admin}`);
    console.log(`    protocol_fee_bps: ${config.protocol_fee_bps}`);
    expect(config.admin).toBe(ctx.deployments.deployer);
    expect(config.protocol_fee_bps).toBe(5);
    expect(config.vault).toBe(ctx.deployments.vault);
  });

  // ── Test 3: pre-wired trusted source is recognised ────────────────────────

  it("is_trusted_source returns true for pre-wired Avalanche source", async () => {
    const trusted = await simulateRead<boolean>(
      ctx.net,
      ctx.deployer.publicKey(),
      ctx.deployments.bridge,
      "is_trusted_source",
      [strVal(TRUSTED_CHAIN), strVal(TRUSTED_ADDR)],
    );
    console.log(`    is_trusted_source(${TRUSTED_CHAIN}, ${TRUSTED_ADDR}): ${trusted}`);
    expect(trusted).toBe(true);
  });

  // ── Test 4: unknown source is not trusted ────────────────────────────────

  it("is_trusted_source returns false for an unknown address", async () => {
    const trusted = await simulateRead<boolean>(
      ctx.net,
      ctx.deployer.publicKey(),
      ctx.deployments.bridge,
      "is_trusted_source",
      [strVal(TRUSTED_CHAIN), strVal("0xDeadBeef")],
    );
    expect(trusted).toBe(false);
  });

  // ── Test 5: set_trusted_source + verify ───────────────────────────────────

  it("set_trusted_source registers a new chain source", async () => {
    await invoke(ctx.net, ctx.deployer, ctx.deployments.bridge, "set_trusted_source", [
      strVal(ETH_CHAIN),
      strVal(ETH_ADDR),
    ]);

    const trusted = await simulateRead<boolean>(
      ctx.net,
      ctx.deployer.publicKey(),
      ctx.deployments.bridge,
      "is_trusted_source",
      [strVal(ETH_CHAIN), strVal(ETH_ADDR)],
    );
    console.log(`    is_trusted_source(${ETH_CHAIN}, ${ETH_ADDR}): ${trusted}`);
    expect(trusted).toBe(true);
  });

  // ── Test 6: remove_trusted_source ────────────────────────────────────────

  it("remove_trusted_source removes the chain source", async () => {
    await invoke(ctx.net, ctx.deployer, ctx.deployments.bridge, "remove_trusted_source", [
      strVal(ETH_CHAIN),
    ]);

    const trusted = await simulateRead<boolean>(
      ctx.net,
      ctx.deployer.publicKey(),
      ctx.deployments.bridge,
      "is_trusted_source",
      [strVal(ETH_CHAIN), strVal(ETH_ADDR)],
    );
    console.log(`    is_trusted_source after remove: ${trusted}`);
    expect(trusted).toBe(false);
  });

  // ── Test 7: register_token + get_local_token ──────────────────────────────

  it("register_token maps token_id to local USDC address", async () => {
    const existing = await simulateRead<string | null>(
      ctx.net,
      ctx.deployer.publicKey(),
      ctx.deployments.bridge,
      "get_local_token",
      [bytes32Val(TOKEN_ID)],
    );
    if (existing !== ctx.deployments.usdc) {
      await invoke(ctx.net, ctx.deployer, ctx.deployments.bridge, "register_token", [
        bytes32Val(TOKEN_ID),
        addrVal(ctx.deployments.usdc),
      ]);
    }

    const resolved = await simulateRead<string | null>(
      ctx.net,
      ctx.deployer.publicKey(),
      ctx.deployments.bridge,
      "get_local_token",
      [bytes32Val(TOKEN_ID)],
    );
    console.log(`    resolved local token: ${resolved}`);
    expect(resolved).toBe(ctx.deployments.usdc);
  });

  // ── Test 8: unregistered token_id returns null ────────────────────────────

  it("get_local_token returns null for an unregistered token_id", async () => {
    const unknownId = new Uint8Array(32).fill(0xff);
    const resolved = await simulateRead<string | null>(
      ctx.net,
      ctx.deployer.publicKey(),
      ctx.deployments.bridge,
      "get_local_token",
      [bytes32Val(unknownId)],
    );
    expect(resolved).toBeNull();
  });
});
