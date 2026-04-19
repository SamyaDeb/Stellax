/**
 * StellaxGovernor — multisig proposal → approve → execute with timelock.
 *
 * Actual ABI (confirmed by e2e):
 *   propose(proposer, action, target_contract, calldata) → u64
 *   approve(signer, proposal_id) → void
 *   execute(proposal_id) → void
 *   emergency_pause(guardian) → void
 *   is_paused() → bool
 *   get_proposal(proposal_id) → GovernorProposal
 *   get_approval_count(proposal_id) → u32
 *   version() → u32
 *
 * Deployment:
 *   multisig=[deployer], threshold=1, timelock_ledgers=0, guardian=deployer
 *
 * Notes:
 *  • GovernanceAction is a Rust enum unit variant, encoded as scvVec([scvSymbol("VariantName")])
 *  • Variants: PauseProtocol, UnpauseProtocol, UpgradeContract, TransferAdmin, UpdateMarketParams
 *  • timelock_ledgers=0 → proposals are executable immediately after threshold approvals
 *  • proposal_id is u64 — encode with scvU64, NOT u32Val
 *  • get_proposal returns a struct with id as bigint
 */

import { xdr } from "@stellar/stellar-sdk";
import { ContractClient } from "../core/client.js";
import { enc, dec } from "../core/scval.js";
import type { InvokeOptions, InvokeResult } from "../core/executor.js";

/** All supported governance action variants. */
export type GovernanceActionVariant =
  | "PauseProtocol"
  | "UnpauseProtocol"
  | "UpgradeContract"
  | "TransferAdmin"
  | "UpdateMarketParams";

/** Raw proposal data as returned by the contract. */
export interface GovernorProposal {
  id: bigint;
  proposer: string;
  action: unknown;
  targetContract: string;
  calldata: Uint8Array;
  approvalCount: number;
  status: unknown;
  createdAt: bigint;
}

/** Encode a GovernanceAction enum variant for Soroban. */
function encodeAction(variant: string): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(Buffer.from(variant, "utf8"))]);
}

/** Encode a proposal_id as u64 ScVal (the governor uses u64 IDs). */
function encProposalId(id: bigint): xdr.ScVal {
  return xdr.ScVal.scvU64(xdr.Uint64.fromString(id.toString()));
}

function decodeProposal(v: xdr.ScVal | undefined): GovernorProposal {
  const o = (dec.raw(v) as Record<string, unknown>) ?? {};
  const cd = o.calldata;
  return {
    id: BigInt(o.id as bigint | number),
    proposer: String(o.proposer),
    action: o.action,
    targetContract: String(o.target_contract),
    calldata: cd instanceof Uint8Array ? cd : new Uint8Array(cd as ArrayBufferLike),
    approvalCount: Number(o.approval_count ?? 0),
    status: o.status,
    createdAt: BigInt((o.created_at ?? 0) as bigint | number),
  };
}

export class GovernorClient extends ContractClient {
  // ─── Reads ─────────────────────────────────────────────────────────────────

  /** Returns true when the protocol is globally paused. */
  isPaused(): Promise<boolean> {
    return this.simulateReturn("is_paused", [], dec.bool);
  }

  /**
   * Fetch a proposal by ID.
   */
  getProposal(proposalId: bigint): Promise<GovernorProposal> {
    return this.simulateReturn(
      "get_proposal",
      [encProposalId(proposalId)],
      decodeProposal,
    );
  }

  /** How many multisig members have approved a proposal. */
  getApprovalCount(proposalId: bigint): Promise<number> {
    return this.simulateReturn(
      "get_approval_count",
      [encProposalId(proposalId)],
      dec.number,
    );
  }

  version(): Promise<number> {
    return this.simulateReturn("version", [], dec.number);
  }

  // ─── Writes ────────────────────────────────────────────────────────────────

  /**
   * Submit a governance proposal.
   *
   * @param proposer        Address that signs the proposal
   * @param action          GovernanceAction variant (e.g. "PauseProtocol")
   * @param targetContract  The contract that will be acted upon
   * @param calldata        Arbitrary bytes passed to the action (use Buffer.alloc(0) for no data)
   * @returns               InvokeResult — returnValue decodes to u64 proposal_id
   */
  propose(
    proposer: string,
    action: GovernanceActionVariant | string,
    targetContract: string,
    calldata: Uint8Array,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "propose",
      [
        enc.address(proposer),
        encodeAction(action),
        enc.address(targetContract),
        enc.bytes(calldata),
      ],
      opts,
    );
  }

  /**
   * Approve a pending proposal (multisig member only).
   */
  approve(signer: string, proposalId: bigint, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke(
      "approve",
      [enc.address(signer), encProposalId(proposalId)],
      opts,
    );
  }

  /**
   * Execute a proposal that has reached the approval threshold and passed the timelock.
   */
  execute(proposalId: bigint, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("execute", [encProposalId(proposalId)], opts);
  }

  /**
   * Guardian emergency pause — immediately halts the protocol without a proposal.
   * @param guardian  Must be the configured guardian address
   */
  emergencyPause(guardian: string, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("emergency_pause", [enc.address(guardian)], opts);
  }

  upgrade(newWasmHash: Uint8Array, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("upgrade", [enc.bytesN(newWasmHash)], opts);
  }
}
