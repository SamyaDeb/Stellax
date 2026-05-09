/**
 * StellaxStaking — Phase F.
 *
 * Epoch-based STLX staking with USDC rewards deposited by the treasury.
 *
 * ABI (from contracts/stellax-staking/src/lib.rs):
 *   initialize(admin, stlx_token, treasury, epoch_duration_secs) → void
 *   stake(user, amount)                 → void       [user auth]
 *   unstake(user, amount)               → void       [user auth, epoch-cooldown]
 *   deposit_epoch_rewards(caller, token, amount) → void [treasury auth]
 *   claim_rewards(user)                 → i128       [user auth]
 *   get_stake(user)                     → StakeEntry
 *   get_epoch_reward(epoch_id)          → EpochRewardPool
 *   current_epoch()                     → u32
 *   total_staked()                      → i128
 *   get_config()                        → StakingConfig
 *   upgrade(new_wasm_hash: BytesN<32>)  → void       [admin auth]
 *   version()                           → u32
 */

import { xdr } from "@stellar/stellar-sdk";
import { ContractClient } from "../core/client.js";
import { enc, dec } from "../core/scval.js";
import type { InvokeOptions, InvokeResult } from "../core/executor.js";

export interface StakingConfig {
  admin: string;
  stlxToken: string;
  treasury: string;
  epochDurationSecs: bigint;
}

export interface StakeEntry {
  staker: string;
  /** STLX token-native units. */
  amount: bigint;
  stakeEpoch: number;
  /** Next epoch to claim (after last successful claim, this equals last_closed + 1). */
  lastClaimEpoch: number;
}

export interface EpochRewardPool {
  epochId: number;
  /** Snapshot of `total_staked` at the moment `deposit_epoch_rewards` ran. */
  totalStaked: bigint;
  rewardToken: string;
  rewardAmount: bigint;
  claimedAmount: bigint;
}

function decodeStakingConfig(v: xdr.ScVal | undefined): StakingConfig {
  const o = (dec.raw(v) as Record<string, unknown>) ?? {};
  return {
    admin: String(o.admin),
    stlxToken: String(o.stlx_token),
    treasury: String(o.treasury),
    epochDurationSecs: BigInt(o.epoch_duration_secs as bigint | number),
  };
}

function decodeStakeEntry(v: xdr.ScVal | undefined): StakeEntry {
  const o = (dec.raw(v) as Record<string, unknown>) ?? {};
  return {
    staker: String(o.staker),
    amount: BigInt(o.amount as bigint | number),
    stakeEpoch: Number(o.stake_epoch),
    lastClaimEpoch: Number(o.last_claim_epoch),
  };
}

function decodeEpochPool(v: xdr.ScVal | undefined): EpochRewardPool {
  const o = (dec.raw(v) as Record<string, unknown>) ?? {};
  return {
    epochId: Number(o.epoch_id),
    totalStaked: BigInt(o.total_staked as bigint | number),
    rewardToken: String(o.reward_token),
    rewardAmount: BigInt(o.reward_amount as bigint | number),
    claimedAmount: BigInt(o.claimed_amount as bigint | number),
  };
}

export class StakingClient extends ContractClient {
  // ─── Reads ─────────────────────────────────────────────────────────────────

  getConfig(): Promise<StakingConfig> {
    return this.simulateReturn("get_config", [], decodeStakingConfig);
  }

  getStake(user: string): Promise<StakeEntry> {
    return this.simulateReturn(
      "get_stake",
      [enc.address(user)],
      decodeStakeEntry,
    );
  }

  getEpochReward(epochId: number): Promise<EpochRewardPool> {
    return this.simulateReturn(
      "get_epoch_reward",
      [enc.u32(epochId)],
      decodeEpochPool,
    );
  }

  currentEpoch(): Promise<number> {
    return this.simulateReturn("current_epoch", [], dec.number);
  }

  totalStaked(): Promise<bigint> {
    return this.simulateReturn("total_staked", [], dec.bigint);
  }

  version(): Promise<number> {
    return this.simulateReturn("version", [], dec.number);
  }

  // ─── Writes ────────────────────────────────────────────────────────────────

  /** Initialise the contract (admin-only, one-shot). */
  initialize(
    admin: string,
    stlxToken: string,
    treasury: string,
    epochDurationSecs: bigint,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "initialize",
      [
        enc.address(admin),
        enc.address(stlxToken),
        enc.address(treasury),
        enc.u64(epochDurationSecs),
      ],
      opts,
    );
  }

  /** Stake STLX. Pulls `amount` from the user's STLX balance. */
  stake(user: string, amount: bigint, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke(
      "stake",
      [enc.address(user), enc.i128(amount)],
      opts,
    );
  }

  /** Unstake STLX. Fails with UnstakeLocked until the user's stake epoch closes. */
  unstake(user: string, amount: bigint, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke(
      "unstake",
      [enc.address(user), enc.i128(amount)],
      opts,
    );
  }

  /**
   * Treasury-only: deposit `amount` of `rewardToken` into the current epoch's
   * reward pool. The treasury's balance of `rewardToken` is transferred into
   * this contract.
   */
  depositEpochRewards(
    caller: string,
    rewardToken: string,
    amount: bigint,
    opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.invoke(
      "deposit_epoch_rewards",
      [enc.address(caller), enc.address(rewardToken), enc.i128(amount)],
      opts,
    );
  }

  /** Claim rewards for every fully-closed epoch since last claim. */
  claimRewards(user: string, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("claim_rewards", [enc.address(user)], opts);
  }

  /** Admin-only WASM upgrade. */
  upgrade(newWasmHash: Uint8Array, opts: InvokeOptions): Promise<InvokeResult> {
    return this.invoke("upgrade", [enc.bytesN(newWasmHash)], opts);
  }
}
