// ── Governor e2e: propose → approve → execute + emergency_pause ───────────────
//
// Governor on testnet:
//   multisig = [deployer], threshold = 1, timelock_ledgers = 0, guardian = deployer
//
// timelock_ledgers=0 means proposals are executable immediately after approval.
// threshold=1 means one approval (the deployer) is sufficient.
//
// Flow:
//  1. Ensure protocol is unpaused at start (clean state for test run).
//  2. propose(deployer, PauseProtocol, governor, empty_bytes) → proposal_id.
//  3. get_approval_count(proposal_id) = 0.
//  4. approve(deployer, proposal_id).
//  5. get_approval_count(proposal_id) = 1.
//  6. execute(proposal_id) → PauseProtocol dispatched.
//  7. is_paused() = true.
//  8. propose(deployer, UnpauseProtocol, governor, empty_bytes) → id2.
//  9. approve(deployer, id2) → execute(id2) → is_paused() = false.
// 10. emergency_pause(deployer) → is_paused() = true (no proposal needed).

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getCtx } from "../lib/fixtures.js";
import { invoke, simulateRead } from "../lib/invoke.js";
import { addrVal, bytesVal } from "../lib/scval.js";
import { xdr } from "@stellar/stellar-sdk";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Encode a unit GovernanceAction enum variant for Soroban. */
function actionVal(name: string): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(Buffer.from(name, "utf8"))]);
}

/** Empty bytes (for calldata of PauseProtocol / UnpauseProtocol). */
const EMPTY_BYTES = bytesVal(Buffer.alloc(0));

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("governor", () => {
  const ctx = getCtx();

  /** Helpers that talk to the deployed governor. */
  async function isPaused(): Promise<boolean> {
    return simulateRead<boolean>(
      ctx.net,
      ctx.deployer.publicKey(),
      ctx.deployments.governor,
      "is_paused",
      [],
    );
  }

  async function propose(action: string): Promise<bigint> {
    const id = await invoke<bigint>(
      ctx.net,
      ctx.deployer,
      ctx.deployments.governor,
      "propose",
      [
        addrVal(ctx.deployer.publicKey()),
        actionVal(action),
        addrVal(ctx.deployments.governor),
        EMPTY_BYTES,
      ],
    );
    return id!;
  }

  async function approveAndExecute(proposalId: bigint): Promise<void> {
    await invoke(ctx.net, ctx.deployer, ctx.deployments.governor, "approve", [
      addrVal(ctx.deployer.publicKey()),
      xdr.ScVal.scvU64(xdr.Uint64.fromString(proposalId.toString())),
    ]);
    await invoke(ctx.net, ctx.deployer, ctx.deployments.governor, "execute", [
      xdr.ScVal.scvU64(xdr.Uint64.fromString(proposalId.toString())),
    ]);
  }

  // ── Setup ──────────────────────────────────────────────────────────────────

  beforeAll(async () => {
    // Ensure the protocol starts unpaused for a clean test run.
    // A previous run may have left it paused via emergency_pause.
    const paused = await isPaused();
    if (paused) {
      console.log("  ▸ protocol already paused — unpausing via governance …");
      const id = await propose("UnpauseProtocol");
      await approveAndExecute(id);
      console.log(`    unpaused (proposal ${id} executed)`);
    } else {
      console.log("  ▸ protocol is unpaused — ready");
    }
  }, 180_000);

  afterAll(async () => {
    if (await isPaused()) {
      console.log("  ▸ protocol paused after governor tests — unpausing …");
      const id = await propose("UnpauseProtocol");
      await approveAndExecute(id);
      console.log(`    protocol unpaused (proposal ${id} executed)`);
    }
  }, 300_000);

  // ── Test 1: propose + approve + execute PauseProtocol ─────────────────────

  it("propose → approve → execute PauseProtocol sets is_paused=true", async () => {
    // Confirm starting state is unpaused.
    expect(await isPaused()).toBe(false);

    // Submit proposal.
    const id = await propose("PauseProtocol");
    console.log(`    proposal_id: ${id}`);
    expect(id).toBeGreaterThan(0n);

    // No approvals yet.
    const countBefore = await simulateRead<number>(
      ctx.net,
      ctx.deployer.publicKey(),
      ctx.deployments.governor,
      "get_approval_count",
      [xdr.ScVal.scvU64(xdr.Uint64.fromString(id.toString()))],
    );
    expect(countBefore).toBe(0);

    // Approve (deployer is the only multisig member; threshold=1).
    await invoke(ctx.net, ctx.deployer, ctx.deployments.governor, "approve", [
      addrVal(ctx.deployer.publicKey()),
      xdr.ScVal.scvU64(xdr.Uint64.fromString(id.toString())),
    ]);

    const countAfter = await simulateRead<number>(
      ctx.net,
      ctx.deployer.publicKey(),
      ctx.deployments.governor,
      "get_approval_count",
      [xdr.ScVal.scvU64(xdr.Uint64.fromString(id.toString()))],
    );
    console.log(`    approvals after approve: ${countAfter}`);
    expect(countAfter).toBe(1);

    // Execute (timelock_ledgers=0, threshold met).
    await invoke(ctx.net, ctx.deployer, ctx.deployments.governor, "execute", [
      xdr.ScVal.scvU64(xdr.Uint64.fromString(id.toString())),
    ]);

    const paused = await isPaused();
    console.log(`    is_paused after execute: ${paused}`);
    expect(paused).toBe(true);
  });

  // ── Test 2: UnpauseProtocol via governance ────────────────────────────────

  it("propose → approve → execute UnpauseProtocol sets is_paused=false", async () => {
    // Protocol should currently be paused (from test 1).
    expect(await isPaused()).toBe(true);

    const id = await propose("UnpauseProtocol");
    console.log(`    proposal_id: ${id}`);
    await approveAndExecute(id);

    const paused = await isPaused();
    console.log(`    is_paused after unpause execute: ${paused}`);
    expect(paused).toBe(false);
  });

  // ── Test 3: get_proposal returns proposal metadata ────────────────────────

  it("get_proposal returns Pending proposal with correct fields", async () => {
    // Create a proposal but do NOT execute it — just inspect the stored state.
    const id = await propose("PauseProtocol");
    console.log(`    proposal_id: ${id}`);

    const proposal = await simulateRead<Record<string, unknown>>(
      ctx.net,
      ctx.deployer.publicKey(),
      ctx.deployments.governor,
      "get_proposal",
      [xdr.ScVal.scvU64(xdr.Uint64.fromString(id.toString()))],
    );
    const safeStr = (v: unknown) =>
      JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
    console.log(`    proposal: ${safeStr(proposal)}`);

    expect(proposal).toBeTruthy();
    // id field matches
    expect((proposal as any).id).toBe(id);
    // status must be Pending (scValToNative decodes unit enum as { "Pending": void } or similar)
    const status = (proposal as any).status;
    console.log(`    status raw: ${safeStr(status)}`);
    // scValToNative decodes unit enum variants as arrays: ["Pending"]
    // or as an object/string depending on sdk version — accept all forms
    const isPendingStatus =
      status === "Pending" ||
      (Array.isArray(status) && status[0] === "Pending") ||
      (typeof status === "object" && status !== null && "Pending" in status);
    expect(isPendingStatus).toBe(true);

    // Clean up: approve + execute so we don't leave orphan proposals.
    await approveAndExecute(id);
    // Now paused again from this proposal — unpause for isolation.
    const id2 = await propose("UnpauseProtocol");
    await approveAndExecute(id2);
  });

  // ── Test 4: emergency_pause (guardian, no proposal needed) ────────────────

  it("emergency_pause sets is_paused=true immediately", async () => {
    expect(await isPaused()).toBe(false);

    // Guardian = deployer (single-sig, no timelock).
    await invoke(ctx.net, ctx.deployer, ctx.deployments.governor, "emergency_pause", [
      addrVal(ctx.deployer.publicKey()),
    ]);

    const paused = await isPaused();
    console.log(`    is_paused after emergency_pause: ${paused}`);
    expect(paused).toBe(true);

    // Leave protocol unpaused so subsequent test suites work.
    const id = await propose("UnpauseProtocol");
    await approveAndExecute(id);
    expect(await isPaused()).toBe(false);
    console.log("    protocol unpaused — clean exit");
  });
});
