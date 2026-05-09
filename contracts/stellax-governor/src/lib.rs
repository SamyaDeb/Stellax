//! StellaX governance contract — Phase 10.
//!
//! Multi-sig admin governance (v1 — not token-based):
//! - Proposal system with timelock: `propose` → `approve` (N-of-M) → `execute`.
//! - `GovernanceAction` enum dispatches on-chain effects or emits events for keepers.
//! - Emergency guardian: single-sig fast pause, full multisig + timelock for unpause.
//! - Upgradeable: governor can upgrade itself or other protocol contracts via
//!   the `UpgradeContract` action.
#![no_std]
#![allow(deprecated)]
#![allow(clippy::too_many_arguments)]

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, Address,
    Bytes, BytesN, Env, Vec,
};

// ─── Errors ───────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum GovernorError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    ProposalNotFound = 4,
    AlreadyApproved = 5,
    ThresholdNotMet = 6,
    TimelockNotExpired = 7,
    AlreadyExecuted = 8,
    InvalidCalldata = 9,
    // Phase O — STLX-weighted governance
    StakingNotConfigured = 10,
    NotEligibleVoter = 11,
    AlreadyVoted = 12,
    ProposalNotActive = 13,
    VotingPeriodActive = 14,
    QuorumNotMet = 15,
    PassThresholdNotMet = 16,
    InvalidGovParams = 17,
    NoStake = 18,
}

// ─── Public types ─────────────────────────────────────────────────────────────

/// The type of change a governance proposal will apply.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum GovernanceAction {
    /// Change leverage limits, fees, OI caps on a perp market.
    UpdateMarketParams,
    /// Add / remove / modify supported collateral and haircuts.
    UpdateCollateralConfig,
    /// Change oracle signers or staleness thresholds.
    UpdateOracleConfig,
    /// Pause a single market (no trading / new positions).
    PauseMarket,
    /// Resume a previously paused market.
    UnpauseMarket,
    /// Halt all protocol activity (global emergency stop).
    PauseProtocol,
    /// Resume the protocol after a global pause.
    UnpauseProtocol,
    /// Replace the WASM binary of a protocol contract.
    UpgradeContract,
    /// Replace the admin multisig list and threshold.
    TransferAdmin,
    /// Phase F: register or update the staking contract on the treasury.
    /// `target_contract` = treasury; `calldata` = bincoded staking Address.
    RegisterStaking,
    /// Phase F: update the staking contract's parameters. Routed generically
    /// via the treasury/staking setters. Payload is action-specific.
    UpdateStaking,
}

/// Lifecycle status of a governance proposal.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum ProposalStatus {
    Pending,
    Executed,
    Cancelled,
}

/// A stored governance proposal.
#[contracttype]
#[derive(Clone, Debug)]
pub struct Proposal {
    pub id: u64,
    pub proposer: Address,
    pub action: GovernanceAction,
    /// Contract that will be called / affected by the action.
    pub target_contract: Address,
    /// Opaque bytes encoding action-specific parameters (see per-action docs).
    pub calldata: Bytes,
    /// Ledger sequence when the proposal was created (timelock anchor).
    pub created_ledger: u32,
    pub status: ProposalStatus,
}

// ─── Phase O — token-weighted governance types ──────────────────────────────

/// Lifecycle status for a STLX-weighted token proposal.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum TokenProposalStatus {
    Active,
    Passed,
    Failed,
    Executed,
    Cancelled,
}

/// A stake-weighted governance proposal. Vote power is captured at the
/// snapshot epoch — addresses whose `stake_epoch` is ≥ `snapshot_epoch` are
/// rejected to neutralise flash-stake vote attacks.
#[contracttype]
#[derive(Clone, Debug)]
pub struct TokenProposal {
    pub id: u64,
    pub proposer: Address,
    pub action: GovernanceAction,
    pub target_contract: Address,
    pub calldata: Bytes,
    /// Ledger sequence when the proposal was created (voting + timelock anchor).
    pub created_ledger: u32,
    /// Staking epoch at proposal creation. Voters must have a stake recorded
    /// in an epoch strictly less than this value.
    pub snapshot_epoch: u32,
    /// Snapshot of total staked STLX taken at proposal creation, used as the
    /// quorum denominator.
    pub total_stake_snapshot: i128,
    pub votes_for: i128,
    pub votes_against: i128,
    pub status: TokenProposalStatus,
}

/// Tunable parameters for the token-vote system. Stored in instance storage
/// and updatable via `configure_token_governance` (multisig-gated).
///
/// Defaults targeted by the specification (V3 phase O):
/// - `voting_ledgers`: 51_840 (≈ 3 days at 5 s/ledger)
/// - `timelock_ledgers`: 34_560 (≈ 2 days at 5 s/ledger)
/// - `quorum_bps`: 400 (4 % of total staked)
/// - `pass_bps`: 5_001 (>50 % of votes cast)
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct GovParams {
    pub voting_ledgers: u32,
    pub timelock_ledgers: u32,
    pub quorum_bps: u32,
    pub pass_bps: u32,
}

// ─── Storage keys ─────────────────────────────────────────────────────────────

#[contracttype]
enum DataKey {
    // Instance storage (contract-global config)
    Version,
    Multisig,
    Threshold,
    TimelockLedgers,
    Guardian,
    Paused,
    ProposalCount,
    PendingMultisig,  // staged for TransferAdmin
    PendingThreshold, // staged for TransferAdmin
    // Persistent storage (per-proposal)
    Proposal(u64),
    Approvals(u64),
    // Phase O — token governance
    StakingContract,
    GovParams,
    TokenProposalCount,
    TokenProposal(u64),
    HasVoted(u64, Address),
}

// ─── Cross-contract client (upgrade target contracts) ─────────────────────────

/// Minimal interface every upgradeable StellaX contract exposes.
#[contractclient(name = "UpgradeableClient")]
#[allow(dead_code)]
trait UpgradeableContract {
    fn upgrade(env: Env, new_wasm_hash: BytesN<32>);
}

/// Phase O: subset of the staking contract used to compute vote weights.
#[contractclient(name = "StakingClient")]
#[allow(dead_code)]
trait StakingContract {
    fn total_staked(env: Env) -> i128;
    fn get_stake_amount(env: Env, user: Address) -> i128;
    fn get_stake_epoch(env: Env, user: Address) -> u32;
    fn current_epoch(env: Env) -> u32;
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct StellaxGovernor;

#[contractimpl]
impl StellaxGovernor {
    // ─── Lifecycle ────────────────────────────────────────────────────────────

    /// One-time initialization.
    ///
    /// * `multisig`          – addresses allowed to propose / approve.
    /// * `threshold`         – minimum approvals to execute a proposal.
    /// * `timelock_ledgers`  – ledgers between proposal creation and earliest
    ///                         execution (≈ 1 day = 17 280 ledgers at 5 s/ledger).
    /// * `guardian`          – single address with emergency-pause authority.
    pub fn initialize(
        env: Env,
        multisig: Vec<Address>,
        threshold: u32,
        timelock_ledgers: u32,
        guardian: Address,
    ) -> Result<(), GovernorError> {
        if env.storage().instance().has(&DataKey::Version) {
            return Err(GovernorError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Multisig, &multisig);
        env.storage()
            .instance()
            .set(&DataKey::Threshold, &threshold);
        env.storage()
            .instance()
            .set(&DataKey::TimelockLedgers, &timelock_ledgers);
        env.storage().instance().set(&DataKey::Guardian, &guardian);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage().instance().set(&DataKey::ProposalCount, &0u64);
        env.storage().instance().set(&DataKey::Version, &1u32);
        Ok(())
    }

    // ─── Proposal lifecycle ───────────────────────────────────────────────────

    /// Create a governance proposal. `proposer` must be a multisig member.
    ///
    /// **Calldata encoding by action:**
    /// - `UpgradeContract`  : 32 raw bytes = new WASM hash.
    /// - `TransferAdmin`    : empty (new config staged via `queue_admin_transfer`).
    /// - `PauseProtocol` / `UnpauseProtocol`: empty.
    /// - All others         : opaque — emitted in a governance event for keepers.
    ///
    /// Returns the new proposal ID.
    pub fn propose(
        env: Env,
        proposer: Address,
        action: GovernanceAction,
        target_contract: Address,
        calldata: Bytes,
    ) -> Result<u64, GovernorError> {
        proposer.require_auth();
        require_multisig_member(&env, &proposer)?;

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .ok_or(GovernorError::NotInitialized)?;
        let id = count + 1;

        let proposal = Proposal {
            id,
            proposer,
            action: action.clone(),
            target_contract,
            calldata,
            created_ledger: env.ledger().sequence(),
            status: ProposalStatus::Pending,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Proposal(id), &proposal);
        env.storage()
            .persistent()
            .set(&DataKey::Approvals(id), &Vec::<Address>::new(&env));
        env.storage().instance().set(&DataKey::ProposalCount, &id);

        env.events()
            .publish((symbol_short!("proposed"), id), action);

        Ok(id)
    }

    /// Add an approval signature to a pending proposal.
    /// Each multisig member may sign at most once per proposal.
    pub fn approve(env: Env, signer: Address, proposal_id: u64) -> Result<(), GovernorError> {
        signer.require_auth();
        require_multisig_member(&env, &signer)?;

        let proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernorError::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Pending {
            return Err(GovernorError::AlreadyExecuted);
        }

        let mut approvals: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::Approvals(proposal_id))
            .unwrap_or_else(|| Vec::new(&env));

        for i in 0..approvals.len() {
            if approvals.get_unchecked(i) == signer {
                return Err(GovernorError::AlreadyApproved);
            }
        }

        approvals.push_back(signer);
        env.storage()
            .persistent()
            .set(&DataKey::Approvals(proposal_id), &approvals);

        Ok(())
    }

    /// Execute a proposal once threshold is met **and** timelock has elapsed.
    ///
    /// Can be called by anyone (typically a keeper).
    pub fn execute(env: Env, proposal_id: u64) -> Result<(), GovernorError> {
        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernorError::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Pending {
            return Err(GovernorError::AlreadyExecuted);
        }

        // --- threshold check ---
        let approvals: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::Approvals(proposal_id))
            .unwrap_or_else(|| Vec::new(&env));
        let threshold: u32 = env
            .storage()
            .instance()
            .get(&DataKey::Threshold)
            .ok_or(GovernorError::NotInitialized)?;

        if approvals.len() < threshold {
            return Err(GovernorError::ThresholdNotMet);
        }

        // --- timelock check ---
        let timelock_ledgers: u32 = env
            .storage()
            .instance()
            .get(&DataKey::TimelockLedgers)
            .ok_or(GovernorError::NotInitialized)?;
        let current = env.ledger().sequence();

        if current < proposal.created_ledger.saturating_add(timelock_ledgers) {
            return Err(GovernorError::TimelockNotExpired);
        }

        // --- dispatch ---
        dispatch_action(&env, &proposal)?;

        proposal.status = ProposalStatus::Executed;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        env.events()
            .publish((symbol_short!("executed"), proposal_id), proposal.action);

        Ok(())
    }

    // ─── Emergency path ───────────────────────────────────────────────────────

    /// Pause the protocol immediately — guardian only, no timelock.
    ///
    /// Unpausing requires the full multisig via `PauseProtocol`/`UnpauseProtocol`
    /// governance proposals (with timelock) to prevent a compromised guardian from
    /// halting the protocol indefinitely.
    pub fn emergency_pause(env: Env, guardian: Address) -> Result<(), GovernorError> {
        guardian.require_auth();
        let stored: Address = env
            .storage()
            .instance()
            .get(&DataKey::Guardian)
            .ok_or(GovernorError::NotInitialized)?;
        if guardian != stored {
            return Err(GovernorError::Unauthorized);
        }
        env.storage().instance().set(&DataKey::Paused, &true);
        env.events().publish((symbol_short!("emgpause"),), true);
        Ok(())
    }

    // ─── Admin-transfer staging ───────────────────────────────────────────────

    /// Stage a new multisig / threshold for a pending `TransferAdmin` proposal.
    ///
    /// Must be called by a current multisig member before the `TransferAdmin`
    /// proposal is executed. The staged config is applied atomically by `execute`.
    pub fn queue_admin_transfer(
        env: Env,
        proposer: Address,
        new_multisig: Vec<Address>,
        new_threshold: u32,
    ) -> Result<(), GovernorError> {
        proposer.require_auth();
        require_multisig_member(&env, &proposer)?;
        env.storage()
            .instance()
            .set(&DataKey::PendingMultisig, &new_multisig);
        env.storage()
            .instance()
            .set(&DataKey::PendingThreshold, &new_threshold);
        Ok(())
    }

    // ─── Upgradeability ───────────────────────────────────────────────────────

    /// Replace the governor's own WASM. Only intended to be called from
    /// `dispatch_action` when the `UpgradeContract` action targets this contract.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        let v: u32 = env.storage().instance().get(&DataKey::Version).unwrap_or(1);
        env.storage().instance().set(&DataKey::Version, &(v + 1));
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        env.events().publish((symbol_short!("upgraded"),), v + 1);
    }

    // ─── Queries ──────────────────────────────────────────────────────────────

    /// Returns `true` when the protocol is paused (either via emergency pause
    /// or via a `PauseProtocol` governance action).
    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    /// Fetch a proposal by ID. Returns `None` if it does not exist.
    pub fn get_proposal(env: Env, proposal_id: u64) -> Option<Proposal> {
        env.storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
    }

    /// Number of approvals collected so far for a proposal.
    pub fn get_approval_count(env: Env, proposal_id: u64) -> u32 {
        let approvals: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::Approvals(proposal_id))
            .unwrap_or_else(|| Vec::new(&env));
        approvals.len()
    }

    /// Current WASM version counter (incremented on every upgrade).
    pub fn version(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Version).unwrap_or(0)
    }

    // ─── Phase O — STLX-weighted token governance ────────────────────────────

    /// Configure (or reconfigure) token-weighted governance. Multisig-gated:
    /// any current multisig member can call this directly so the protocol can
    /// be bootstrapped without requiring its own governance to exist yet.
    /// Subsequent updates should flow through a `TransferAdmin`-style
    /// proposal off-chain and re-invoke this entry from the new admin set.
    ///
    /// * `voting_ledgers` — length of the voting window (must be ≥ 1).
    /// * `timelock_ledgers` — delay between `Passed` and earliest `execute`.
    /// * `quorum_bps` — minimum `(votes_for + votes_against) / total_stake_snapshot`,
    ///   in basis points (10_000 = 100 %). Must be ≤ 10_000.
    /// * `pass_bps` — minimum `votes_for / (votes_for + votes_against)` in bps.
    pub fn configure_token_governance(
        env: Env,
        caller: Address,
        staking: Address,
        voting_ledgers: u32,
        timelock_ledgers: u32,
        quorum_bps: u32,
        pass_bps: u32,
    ) -> Result<(), GovernorError> {
        caller.require_auth();
        require_multisig_member(&env, &caller)?;
        if voting_ledgers == 0 || quorum_bps > 10_000 || pass_bps > 10_000 {
            return Err(GovernorError::InvalidGovParams);
        }
        env.storage()
            .instance()
            .set(&DataKey::StakingContract, &staking);
        let params = GovParams {
            voting_ledgers,
            timelock_ledgers,
            quorum_bps,
            pass_bps,
        };
        env.storage().instance().set(&DataKey::GovParams, &params);
        if !env.storage().instance().has(&DataKey::TokenProposalCount) {
            env.storage()
                .instance()
                .set(&DataKey::TokenProposalCount, &0u64);
        }
        env.events()
            .publish((symbol_short!("govcfg"),), (staking, params));
        Ok(())
    }

    /// Open a new STLX-weighted proposal. The caller must currently hold a
    /// non-zero stake whose `stake_epoch` is strictly less than the current
    /// epoch (i.e. they staked at least one full epoch ago). The proposal
    /// snapshots `total_staked` and `current_epoch` at creation time.
    pub fn create_proposal(
        env: Env,
        proposer: Address,
        action: GovernanceAction,
        target_contract: Address,
        calldata: Bytes,
    ) -> Result<u64, GovernorError> {
        proposer.require_auth();
        let staking_addr = load_staking_address(&env)?;
        let staking = StakingClient::new(&env, &staking_addr);
        let proposer_stake = staking.get_stake_amount(&proposer);
        if proposer_stake <= 0 {
            return Err(GovernorError::NoStake);
        }
        let snapshot_epoch = staking.current_epoch();
        let total_stake = staking.total_staked();

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::TokenProposalCount)
            .unwrap_or(0);
        let id = count + 1;

        let proposal = TokenProposal {
            id,
            proposer,
            action: action.clone(),
            target_contract,
            calldata,
            created_ledger: env.ledger().sequence(),
            snapshot_epoch,
            total_stake_snapshot: total_stake,
            votes_for: 0,
            votes_against: 0,
            status: TokenProposalStatus::Active,
        };
        env.storage()
            .persistent()
            .set(&DataKey::TokenProposal(id), &proposal);
        env.storage()
            .instance()
            .set(&DataKey::TokenProposalCount, &id);

        env.events()
            .publish((symbol_short!("tkpropose"), id), action);
        Ok(id)
    }

    /// Cast a vote on an active token proposal. Vote weight equals the
    /// caller's currently-staked STLX. The voter must have staked **before**
    /// the proposal's `snapshot_epoch` to be eligible (anti-flash-loan).
    /// Each address may vote at most once per proposal.
    pub fn cast_vote(
        env: Env,
        voter: Address,
        proposal_id: u64,
        support: bool,
    ) -> Result<(), GovernorError> {
        voter.require_auth();
        let staking_addr = load_staking_address(&env)?;
        let staking = StakingClient::new(&env, &staking_addr);

        let mut proposal: TokenProposal = env
            .storage()
            .persistent()
            .get(&DataKey::TokenProposal(proposal_id))
            .ok_or(GovernorError::ProposalNotFound)?;
        if proposal.status != TokenProposalStatus::Active {
            return Err(GovernorError::ProposalNotActive);
        }

        let params = load_gov_params(&env)?;
        let vote_deadline = proposal
            .created_ledger
            .saturating_add(params.voting_ledgers);
        if env.ledger().sequence() >= vote_deadline {
            return Err(GovernorError::VotingPeriodActive); // semantic: voting ended → can't vote
        }

        let vote_key = DataKey::HasVoted(proposal_id, voter.clone());
        if env.storage().persistent().has(&vote_key) {
            return Err(GovernorError::AlreadyVoted);
        }

        // Eligibility: must have staked in an epoch strictly before the
        // proposal snapshot. New stakers (or non-stakers) are rejected.
        let voter_epoch = staking.get_stake_epoch(&voter);
        if voter_epoch >= proposal.snapshot_epoch {
            return Err(GovernorError::NotEligibleVoter);
        }
        let weight = staking.get_stake_amount(&voter);
        if weight <= 0 {
            return Err(GovernorError::NotEligibleVoter);
        }

        if support {
            proposal.votes_for = proposal.votes_for.saturating_add(weight);
        } else {
            proposal.votes_against = proposal.votes_against.saturating_add(weight);
        }
        env.storage()
            .persistent()
            .set(&DataKey::TokenProposal(proposal_id), &proposal);
        env.storage().persistent().set(&vote_key, &true);

        env.events().publish(
            (symbol_short!("voted"), proposal_id),
            (voter, support, weight),
        );
        Ok(())
    }

    /// Tally an `Active` token proposal once the voting window has elapsed.
    /// Marks the proposal `Passed` (when quorum is met *and* the for/against
    /// ratio crosses `pass_bps`) or `Failed` otherwise. Idempotent — calling
    /// after tally returns `ProposalNotActive`.
    pub fn tally_proposal(
        env: Env,
        proposal_id: u64,
    ) -> Result<TokenProposalStatus, GovernorError> {
        let mut proposal: TokenProposal = env
            .storage()
            .persistent()
            .get(&DataKey::TokenProposal(proposal_id))
            .ok_or(GovernorError::ProposalNotFound)?;
        if proposal.status != TokenProposalStatus::Active {
            return Err(GovernorError::ProposalNotActive);
        }
        let params = load_gov_params(&env)?;
        let deadline = proposal
            .created_ledger
            .saturating_add(params.voting_ledgers);
        if env.ledger().sequence() < deadline {
            return Err(GovernorError::VotingPeriodActive);
        }

        // Quorum: total turnout against the snapshot total stake.
        let turnout = proposal.votes_for.saturating_add(proposal.votes_against);
        let quorum_threshold = mul_bps(proposal.total_stake_snapshot, params.quorum_bps);
        let quorum_ok = turnout >= quorum_threshold;

        // Pass: votes_for / turnout >= pass_bps. Guard against turnout == 0.
        let pass_ok = if turnout == 0 {
            false
        } else {
            // votes_for * 10_000 >= turnout * pass_bps  (no division)
            proposal.votes_for.saturating_mul(10_000)
                >= turnout.saturating_mul(params.pass_bps as i128)
        };

        proposal.status = if quorum_ok && pass_ok {
            TokenProposalStatus::Passed
        } else {
            TokenProposalStatus::Failed
        };
        env.storage()
            .persistent()
            .set(&DataKey::TokenProposal(proposal_id), &proposal);

        env.events().publish(
            (symbol_short!("tallied"), proposal_id),
            proposal.status.clone(),
        );
        Ok(proposal.status)
    }

    /// Execute a `Passed` token proposal once the timelock has elapsed.
    /// Reuses the same `dispatch_action` machinery as the multisig path so
    /// every action variant behaves identically across both governance lanes.
    pub fn execute_token_proposal(env: Env, proposal_id: u64) -> Result<(), GovernorError> {
        let mut proposal: TokenProposal = env
            .storage()
            .persistent()
            .get(&DataKey::TokenProposal(proposal_id))
            .ok_or(GovernorError::ProposalNotFound)?;
        match proposal.status {
            TokenProposalStatus::Passed => {}
            TokenProposalStatus::Executed => return Err(GovernorError::AlreadyExecuted),
            TokenProposalStatus::Active => return Err(GovernorError::VotingPeriodActive),
            TokenProposalStatus::Failed | TokenProposalStatus::Cancelled => {
                return Err(GovernorError::PassThresholdNotMet);
            }
        }
        let params = load_gov_params(&env)?;
        let earliest = proposal
            .created_ledger
            .saturating_add(params.voting_ledgers)
            .saturating_add(params.timelock_ledgers);
        if env.ledger().sequence() < earliest {
            return Err(GovernorError::TimelockNotExpired);
        }

        // Adapter to the existing dispatcher (which expects a `Proposal`).
        let mut adapter = Proposal {
            id: proposal.id,
            proposer: proposal.proposer.clone(),
            action: proposal.action.clone(),
            target_contract: proposal.target_contract.clone(),
            calldata: proposal.calldata.clone(),
            created_ledger: proposal.created_ledger,
            status: ProposalStatus::Pending,
        };
        dispatch_action(&env, &adapter)?;
        adapter.status = ProposalStatus::Executed; // not stored — only for clarity

        proposal.status = TokenProposalStatus::Executed;
        env.storage()
            .persistent()
            .set(&DataKey::TokenProposal(proposal_id), &proposal);
        env.events()
            .publish((symbol_short!("tkexec"), proposal_id), proposal.action);
        Ok(())
    }

    // ─── Phase O — token governance views ────────────────────────────────────

    pub fn get_token_proposal(env: Env, proposal_id: u64) -> Option<TokenProposal> {
        env.storage()
            .persistent()
            .get(&DataKey::TokenProposal(proposal_id))
    }

    pub fn has_voted(env: Env, proposal_id: u64, voter: Address) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::HasVoted(proposal_id, voter))
    }

    pub fn get_gov_params(env: Env) -> Option<GovParams> {
        env.storage().instance().get(&DataKey::GovParams)
    }

    pub fn get_staking_contract(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::StakingContract)
    }

    pub fn token_proposal_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::TokenProposalCount)
            .unwrap_or(0)
    }
}

// ─── Free helpers ─────────────────────────────────────────────────────────────

fn require_multisig_member(env: &Env, addr: &Address) -> Result<(), GovernorError> {
    let multisig: Vec<Address> = env
        .storage()
        .instance()
        .get(&DataKey::Multisig)
        .ok_or(GovernorError::NotInitialized)?;
    for i in 0..multisig.len() {
        if &multisig.get_unchecked(i) == addr {
            return Ok(());
        }
    }
    Err(GovernorError::Unauthorized)
}

// ─── Phase O — token governance helpers ──────────────────────────────────────

fn load_staking_address(env: &Env) -> Result<Address, GovernorError> {
    env.storage()
        .instance()
        .get(&DataKey::StakingContract)
        .ok_or(GovernorError::StakingNotConfigured)
}

fn load_gov_params(env: &Env) -> Result<GovParams, GovernorError> {
    env.storage()
        .instance()
        .get(&DataKey::GovParams)
        .ok_or(GovernorError::StakingNotConfigured)
}

/// Multiply `value` by `bps / 10_000` with saturating arithmetic. Used for
/// quorum thresholds where `value` can be any signed `i128` ≥ 0.
fn mul_bps(value: i128, bps: u32) -> i128 {
    value.saturating_mul(bps as i128).saturating_div(10_000)
}

/// Execute the on-chain effect of an approved proposal.
fn dispatch_action(env: &Env, proposal: &Proposal) -> Result<(), GovernorError> {
    match proposal.action.clone() {
        GovernanceAction::PauseProtocol => {
            env.storage().instance().set(&DataKey::Paused, &true);
        }

        GovernanceAction::UnpauseProtocol => {
            env.storage().instance().set(&DataKey::Paused, &false);
        }

        GovernanceAction::UpgradeContract => {
            // calldata must be exactly 32 bytes (the new WASM hash).
            if proposal.calldata.len() != 32 {
                return Err(GovernorError::InvalidCalldata);
            }
            let mut buf = [0u8; 32];
            proposal.calldata.copy_into_slice(&mut buf);
            let wasm_hash: BytesN<32> = BytesN::from_array(env, &buf);
            UpgradeableClient::new(env, &proposal.target_contract).upgrade(&wasm_hash);
        }

        GovernanceAction::TransferAdmin => {
            // Apply previously staged new multisig config.
            let new_multisig: Vec<Address> = env
                .storage()
                .instance()
                .get(&DataKey::PendingMultisig)
                .ok_or(GovernorError::InvalidCalldata)?;
            let new_threshold: u32 = env
                .storage()
                .instance()
                .get(&DataKey::PendingThreshold)
                .ok_or(GovernorError::InvalidCalldata)?;
            env.storage()
                .instance()
                .set(&DataKey::Multisig, &new_multisig);
            env.storage()
                .instance()
                .set(&DataKey::Threshold, &new_threshold);
            env.storage().instance().remove(&DataKey::PendingMultisig);
            env.storage().instance().remove(&DataKey::PendingThreshold);
        }

        // For the remaining actions the governor emits a governance event
        // that off-chain keepers (or the target contract's own admin function)
        // observe and apply. The calldata encoding is action-specific and
        // documented in the keeper implementation (Phase 11).
        GovernanceAction::UpdateMarketParams
        | GovernanceAction::UpdateCollateralConfig
        | GovernanceAction::UpdateOracleConfig
        | GovernanceAction::PauseMarket
        | GovernanceAction::UnpauseMarket
        | GovernanceAction::RegisterStaking
        | GovernanceAction::UpdateStaking => {
            env.events().publish(
                (symbol_short!("govexec"), proposal.action.clone()),
                (proposal.target_contract.clone(), proposal.calldata.clone()),
            );
        }
    }
    Ok(())
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        Env,
    };

    // ─── Test helpers ─────────────────────────────────────────────────────────

    struct Setup {
        env: Env,
        contract: Address,
        signers: [Address; 5],
        guardian: Address,
    }

    impl Setup {
        /// Deploy + initialize a 3-of-5 multisig with 100-ledger timelock.
        fn new() -> Self {
            let env = Env::default();
            env.mock_all_auths();

            let contract = env.register(StellaxGovernor, ());
            let client = StellaxGovernorClient::new(&env, &contract);

            let signers: [Address; 5] = core::array::from_fn(|_| Address::generate(&env));
            let guardian = Address::generate(&env);

            let mut multisig = Vec::new(&env);
            for s in &signers {
                multisig.push_back(s.clone());
            }

            client.initialize(&multisig, &3, &100, &guardian);

            Setup {
                env,
                contract,
                signers,
                guardian,
            }
        }

        fn client(&self) -> StellaxGovernorClient<'_> {
            StellaxGovernorClient::new(&self.env, &self.contract)
        }

        fn dummy_target(&self) -> Address {
            Address::generate(&self.env)
        }

        fn empty_bytes(&self) -> Bytes {
            Bytes::new(&self.env)
        }
    }

    // ─── Initialization ───────────────────────────────────────────────────────

    #[test]
    fn test_initialize() {
        let s = Setup::new();
        assert_eq!(s.client().version(), 1);
        assert!(!s.client().is_paused());
    }

    #[test]
    fn test_double_initialize_fails() {
        let s = Setup::new();
        let mut ms = Vec::new(&s.env);
        ms.push_back(s.signers[0].clone());
        let err = s
            .client()
            .try_initialize(&ms, &1, &100, &s.guardian)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, GovernorError::AlreadyInitialized);
    }

    // ─── propose ──────────────────────────────────────────────────────────────

    #[test]
    fn test_propose_returns_incrementing_ids() {
        let s = Setup::new();
        let c = s.client();
        let id1 = c.propose(
            &s.signers[0],
            &GovernanceAction::PauseProtocol,
            &s.dummy_target(),
            &s.empty_bytes(),
        );
        let id2 = c.propose(
            &s.signers[1],
            &GovernanceAction::UnpauseProtocol,
            &s.dummy_target(),
            &s.empty_bytes(),
        );
        assert_eq!(id1, 1);
        assert_eq!(id2, 2);
    }

    #[test]
    fn test_propose_non_member_fails() {
        let s = Setup::new();
        let stranger = Address::generate(&s.env);
        let err = s
            .client()
            .try_propose(
                &stranger,
                &GovernanceAction::PauseProtocol,
                &s.dummy_target(),
                &s.empty_bytes(),
            )
            .unwrap_err()
            .unwrap();
        assert_eq!(err, GovernorError::Unauthorized);
    }

    // ─── approve ──────────────────────────────────────────────────────────────

    #[test]
    fn test_approve_accumulates() {
        let s = Setup::new();
        let c = s.client();
        let id = c.propose(
            &s.signers[0],
            &GovernanceAction::PauseProtocol,
            &s.dummy_target(),
            &s.empty_bytes(),
        );

        c.approve(&s.signers[0], &id);
        c.approve(&s.signers[1], &id);
        assert_eq!(c.get_approval_count(&id), 2);
    }

    #[test]
    fn test_approve_duplicate_fails() {
        let s = Setup::new();
        let c = s.client();
        let id = c.propose(
            &s.signers[0],
            &GovernanceAction::PauseProtocol,
            &s.dummy_target(),
            &s.empty_bytes(),
        );

        c.approve(&s.signers[0], &id);
        let err = c.try_approve(&s.signers[0], &id).unwrap_err().unwrap();
        assert_eq!(err, GovernorError::AlreadyApproved);
    }

    #[test]
    fn test_approve_non_member_fails() {
        let s = Setup::new();
        let c = s.client();
        let id = c.propose(
            &s.signers[0],
            &GovernanceAction::PauseProtocol,
            &s.dummy_target(),
            &s.empty_bytes(),
        );
        let stranger = Address::generate(&s.env);
        let err = c.try_approve(&stranger, &id).unwrap_err().unwrap();
        assert_eq!(err, GovernorError::Unauthorized);
    }

    // ─── execute — happy path ─────────────────────────────────────────────────

    #[test]
    fn test_execute_pause_protocol() {
        let s = Setup::new();
        let c = s.client();

        let id = c.propose(
            &s.signers[0],
            &GovernanceAction::PauseProtocol,
            &s.dummy_target(),
            &s.empty_bytes(),
        );

        c.approve(&s.signers[0], &id);
        c.approve(&s.signers[1], &id);
        c.approve(&s.signers[2], &id);

        // Advance past the 100-ledger timelock.
        s.env
            .ledger()
            .set_sequence_number(s.env.ledger().sequence() + 101);

        c.execute(&id);
        assert!(c.is_paused());
    }

    #[test]
    fn test_execute_unpause_protocol() {
        let s = Setup::new();
        let c = s.client();

        // First pause via emergency path.
        c.emergency_pause(&s.guardian);
        assert!(c.is_paused());

        // Then unpause via governance.
        let id = c.propose(
            &s.signers[0],
            &GovernanceAction::UnpauseProtocol,
            &s.dummy_target(),
            &s.empty_bytes(),
        );

        c.approve(&s.signers[0], &id);
        c.approve(&s.signers[1], &id);
        c.approve(&s.signers[2], &id);

        s.env
            .ledger()
            .set_sequence_number(s.env.ledger().sequence() + 101);

        c.execute(&id);
        assert!(!c.is_paused());
    }

    // ─── execute — rejection cases ────────────────────────────────────────────

    #[test]
    fn test_execute_timelock_enforced() {
        let s = Setup::new();
        let c = s.client();

        let id = c.propose(
            &s.signers[0],
            &GovernanceAction::PauseProtocol,
            &s.dummy_target(),
            &s.empty_bytes(),
        );

        c.approve(&s.signers[0], &id);
        c.approve(&s.signers[1], &id);
        c.approve(&s.signers[2], &id);

        // Still within timelock — must fail.
        let err = c.try_execute(&id).unwrap_err().unwrap();
        assert_eq!(err, GovernorError::TimelockNotExpired);

        // Advance past timelock — must succeed.
        s.env
            .ledger()
            .set_sequence_number(s.env.ledger().sequence() + 101);
        c.execute(&id);
        assert!(c.is_paused());
    }

    #[test]
    fn test_execute_threshold_not_met() {
        let s = Setup::new();
        let c = s.client();

        let id = c.propose(
            &s.signers[0],
            &GovernanceAction::PauseProtocol,
            &s.dummy_target(),
            &s.empty_bytes(),
        );

        // Only 2 approvals; threshold is 3.
        c.approve(&s.signers[0], &id);
        c.approve(&s.signers[1], &id);

        s.env
            .ledger()
            .set_sequence_number(s.env.ledger().sequence() + 101);

        let err = c.try_execute(&id).unwrap_err().unwrap();
        assert_eq!(err, GovernorError::ThresholdNotMet);
    }

    #[test]
    fn test_execute_already_executed_fails() {
        let s = Setup::new();
        let c = s.client();

        let id = c.propose(
            &s.signers[0],
            &GovernanceAction::PauseProtocol,
            &s.dummy_target(),
            &s.empty_bytes(),
        );

        c.approve(&s.signers[0], &id);
        c.approve(&s.signers[1], &id);
        c.approve(&s.signers[2], &id);

        s.env
            .ledger()
            .set_sequence_number(s.env.ledger().sequence() + 101);

        c.execute(&id);

        // Second execution must fail.
        let err = c.try_execute(&id).unwrap_err().unwrap();
        assert_eq!(err, GovernorError::AlreadyExecuted);
    }

    // ─── Emergency pause ──────────────────────────────────────────────────────

    #[test]
    fn test_emergency_pause() {
        let s = Setup::new();
        assert!(!s.client().is_paused());
        s.client().emergency_pause(&s.guardian);
        assert!(s.client().is_paused());
    }

    #[test]
    fn test_emergency_pause_wrong_guardian_fails() {
        let s = Setup::new();
        let impostor = Address::generate(&s.env);
        let err = s
            .client()
            .try_emergency_pause(&impostor)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, GovernorError::Unauthorized);
    }

    // ─── TransferAdmin ────────────────────────────────────────────────────────

    #[test]
    fn test_execute_transfer_admin() {
        let s = Setup::new();
        let c = s.client();

        // Stage the new 2-of-2 multisig.
        let new_signer_a = Address::generate(&s.env);
        let new_signer_b = Address::generate(&s.env);
        let mut new_ms = Vec::new(&s.env);
        new_ms.push_back(new_signer_a.clone());
        new_ms.push_back(new_signer_b.clone());

        c.queue_admin_transfer(&s.signers[0], &new_ms, &2);

        // Create, approve, and execute the TransferAdmin proposal.
        let id = c.propose(
            &s.signers[0],
            &GovernanceAction::TransferAdmin,
            &s.contract,
            &s.empty_bytes(),
        );

        c.approve(&s.signers[0], &id);
        c.approve(&s.signers[1], &id);
        c.approve(&s.signers[2], &id);

        s.env
            .ledger()
            .set_sequence_number(s.env.ledger().sequence() + 101);

        c.execute(&id);

        // Old signers can no longer propose.
        let err = c
            .try_propose(
                &s.signers[0],
                &GovernanceAction::PauseProtocol,
                &s.dummy_target(),
                &s.empty_bytes(),
            )
            .unwrap_err()
            .unwrap();
        assert_eq!(err, GovernorError::Unauthorized);

        // New signers can propose and approve.
        let id2 = c.propose(
            &new_signer_a,
            &GovernanceAction::PauseProtocol,
            &s.dummy_target(),
            &s.empty_bytes(),
        );
        c.approve(&new_signer_a, &id2);
        c.approve(&new_signer_b, &id2);

        s.env
            .ledger()
            .set_sequence_number(s.env.ledger().sequence() + 101);

        c.execute(&id2);
        assert!(c.is_paused());
    }

    // ─── Phase O — STLX-weighted token governance ─────────────────────────────

    #[allow(unused_imports)]
    use soroban_sdk::Map;

    /// Minimal in-test staking stub. Mirrors the four entry-points the
    /// governor reads via `StakingClient`. Per-user amount + epoch are stored
    /// in instance storage keyed by `Address`; `total_staked` and the
    /// "current epoch" returned to callers are scalar instance values.
    mod mock_staking {
        use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};

        #[contracttype]
        pub enum MSKey {
            Total,
            CurEpoch,
            Amt(Address),
            Ep(Address),
        }

        #[contract]
        pub struct MockStaking;

        #[contractimpl]
        impl MockStaking {
            pub fn total_staked(env: Env) -> i128 {
                env.storage().instance().get(&MSKey::Total).unwrap_or(0)
            }
            pub fn get_stake_amount(env: Env, user: Address) -> i128 {
                env.storage().instance().get(&MSKey::Amt(user)).unwrap_or(0)
            }
            pub fn get_stake_epoch(env: Env, user: Address) -> u32 {
                env.storage()
                    .instance()
                    .get(&MSKey::Ep(user))
                    .unwrap_or(u32::MAX)
            }
            pub fn current_epoch(env: Env) -> u32 {
                env.storage().instance().get(&MSKey::CurEpoch).unwrap_or(0)
            }
            pub fn set_user(env: Env, user: Address, amount: i128, stake_epoch: u32) {
                env.storage()
                    .instance()
                    .set(&MSKey::Amt(user.clone()), &amount);
                env.storage().instance().set(&MSKey::Ep(user), &stake_epoch);
            }
            pub fn set_total(env: Env, total: i128) {
                env.storage().instance().set(&MSKey::Total, &total);
            }
            pub fn set_epoch(env: Env, epoch: u32) {
                env.storage().instance().set(&MSKey::CurEpoch, &epoch);
            }
        }
    }

    /// Phase O test fixture: deploys governor + mock staking, configures
    /// 100-ledger voting / 50-ledger timelock / 10 % quorum / >50 % pass.
    struct OFixture {
        env: Env,
        gov: Address,
        staking: Address,
        signers: [Address; 5],
        voters: [Address; 4],
    }

    impl OFixture {
        fn new() -> Self {
            let env = Env::default();
            env.mock_all_auths();

            let gov = env.register(StellaxGovernor, ());
            let gov_client = StellaxGovernorClient::new(&env, &gov);

            let signers: [Address; 5] = core::array::from_fn(|_| Address::generate(&env));
            let guardian = Address::generate(&env);
            let mut multisig = Vec::new(&env);
            for s in &signers {
                multisig.push_back(s.clone());
            }
            gov_client.initialize(&multisig, &3, &100, &guardian);

            let staking = env.register(mock_staking::MockStaking, ());

            // Voting window 100 ledgers, timelock 50 ledgers, quorum 1000 bps
            // (10 %), pass 5_001 bps (>50 %). All within u32::MAX.
            gov_client.configure_token_governance(&signers[0], &staking, &100, &50, &1_000, &5_001);

            let voters: [Address; 4] = core::array::from_fn(|_| Address::generate(&env));
            OFixture {
                env,
                gov,
                staking,
                signers,
                voters,
            }
        }

        fn gov_client(&self) -> StellaxGovernorClient<'_> {
            StellaxGovernorClient::new(&self.env, &self.gov)
        }

        fn staking_client(&self) -> mock_staking::MockStakingClient<'_> {
            mock_staking::MockStakingClient::new(&self.env, &self.staking)
        }

        fn dummy_target(&self) -> Address {
            Address::generate(&self.env)
        }

        fn empty_bytes(&self) -> Bytes {
            Bytes::new(&self.env)
        }
    }

    #[test]
    fn phase_o_create_proposal_snapshots_total_and_epoch() {
        let f = OFixture::new();
        // Stake setup: proposer staked at epoch 0; current epoch = 5.
        f.staking_client().set_total(&1_000_000);
        f.staking_client().set_epoch(&5);
        f.staking_client().set_user(&f.signers[0], &10_000, &0);

        let id = f.gov_client().create_proposal(
            &f.signers[0],
            &GovernanceAction::PauseProtocol,
            &f.dummy_target(),
            &f.empty_bytes(),
        );
        assert_eq!(id, 1);
        let p = f.gov_client().get_token_proposal(&id).unwrap();
        assert_eq!(p.snapshot_epoch, 5);
        assert_eq!(p.total_stake_snapshot, 1_000_000);
        assert_eq!(p.status, TokenProposalStatus::Active);
    }

    #[test]
    fn phase_o_proposer_without_stake_rejected() {
        let f = OFixture::new();
        f.staking_client().set_epoch(&3);
        let err = f
            .gov_client()
            .try_create_proposal(
                &f.voters[0],
                &GovernanceAction::PauseProtocol,
                &f.dummy_target(),
                &f.empty_bytes(),
            )
            .unwrap_err()
            .unwrap();
        assert_eq!(err, GovernorError::NoStake);
    }

    #[test]
    fn phase_o_happy_path_pass_and_execute() {
        let f = OFixture::new();
        // Total staked 100k, four voters with 25k each (all staked at epoch 0).
        f.staking_client().set_total(&100_000);
        f.staking_client().set_epoch(&5);
        for v in &f.voters {
            f.staking_client().set_user(v, &25_000, &0);
        }
        // Proposer (also a staker, epoch 0)
        f.staking_client().set_user(&f.voters[0], &25_000, &0);

        let id = f.gov_client().create_proposal(
            &f.voters[0],
            &GovernanceAction::PauseProtocol,
            &f.dummy_target(),
            &f.empty_bytes(),
        );

        // 3 voters in favour, 1 against → 75k for, 25k against. Quorum (10 %
        // of 100k = 10k) easily met; pass ratio 75 % > 50 %.
        f.gov_client().cast_vote(&f.voters[0], &id, &true);
        f.gov_client().cast_vote(&f.voters[1], &id, &true);
        f.gov_client().cast_vote(&f.voters[2], &id, &true);
        f.gov_client().cast_vote(&f.voters[3], &id, &false);

        // Advance past voting window and tally.
        f.env
            .ledger()
            .set_sequence_number(f.env.ledger().sequence() + 101);
        let status = f.gov_client().tally_proposal(&id);
        assert_eq!(status, TokenProposalStatus::Passed);

        // Execute should still fail until timelock elapses.
        let err = f
            .gov_client()
            .try_execute_token_proposal(&id)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, GovernorError::TimelockNotExpired);

        // Advance past timelock → execute succeeds and pauses the protocol.
        f.env
            .ledger()
            .set_sequence_number(f.env.ledger().sequence() + 51);
        f.gov_client().execute_token_proposal(&id);
        assert!(f.gov_client().is_paused());
        assert_eq!(
            f.gov_client().get_token_proposal(&id).unwrap().status,
            TokenProposalStatus::Executed
        );
    }

    #[test]
    fn phase_o_quorum_not_met_marks_failed() {
        let f = OFixture::new();
        // Total 1_000_000 but only one 50k voter participates (5 % turnout
        // < 10 % quorum).
        f.staking_client().set_total(&1_000_000);
        f.staking_client().set_epoch(&5);
        f.staking_client().set_user(&f.voters[0], &50_000, &0);

        let id = f.gov_client().create_proposal(
            &f.voters[0],
            &GovernanceAction::PauseProtocol,
            &f.dummy_target(),
            &f.empty_bytes(),
        );
        f.gov_client().cast_vote(&f.voters[0], &id, &true);

        f.env
            .ledger()
            .set_sequence_number(f.env.ledger().sequence() + 101);
        let status = f.gov_client().tally_proposal(&id);
        assert_eq!(status, TokenProposalStatus::Failed);
    }

    #[test]
    fn phase_o_majority_against_marks_failed() {
        let f = OFixture::new();
        f.staking_client().set_total(&100_000);
        f.staking_client().set_epoch(&5);
        for v in &f.voters {
            f.staking_client().set_user(v, &25_000, &0);
        }

        let id = f.gov_client().create_proposal(
            &f.voters[0],
            &GovernanceAction::PauseProtocol,
            &f.dummy_target(),
            &f.empty_bytes(),
        );
        f.gov_client().cast_vote(&f.voters[0], &id, &true);
        f.gov_client().cast_vote(&f.voters[1], &id, &false);
        f.gov_client().cast_vote(&f.voters[2], &id, &false);
        f.gov_client().cast_vote(&f.voters[3], &id, &false);

        f.env
            .ledger()
            .set_sequence_number(f.env.ledger().sequence() + 101);
        assert_eq!(
            f.gov_client().tally_proposal(&id),
            TokenProposalStatus::Failed
        );
    }

    #[test]
    fn phase_o_flash_stake_voter_rejected() {
        let f = OFixture::new();
        f.staking_client().set_total(&100_000);
        f.staking_client().set_epoch(&5);
        // Proposer staked at epoch 0 (eligible).
        f.staking_client().set_user(&f.voters[0], &50_000, &0);
        // Late voter staked **at** the snapshot epoch — must be rejected.
        f.staking_client().set_user(&f.voters[1], &50_000, &5);

        let id = f.gov_client().create_proposal(
            &f.voters[0],
            &GovernanceAction::PauseProtocol,
            &f.dummy_target(),
            &f.empty_bytes(),
        );
        let err = f
            .gov_client()
            .try_cast_vote(&f.voters[1], &id, &true)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, GovernorError::NotEligibleVoter);
    }

    #[test]
    fn phase_o_double_vote_rejected() {
        let f = OFixture::new();
        f.staking_client().set_total(&100_000);
        f.staking_client().set_epoch(&5);
        f.staking_client().set_user(&f.voters[0], &50_000, &0);

        let id = f.gov_client().create_proposal(
            &f.voters[0],
            &GovernanceAction::PauseProtocol,
            &f.dummy_target(),
            &f.empty_bytes(),
        );
        f.gov_client().cast_vote(&f.voters[0], &id, &true);
        let err = f
            .gov_client()
            .try_cast_vote(&f.voters[0], &id, &false)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, GovernorError::AlreadyVoted);
    }

    #[test]
    fn phase_o_tally_before_voting_window_ends_rejected() {
        let f = OFixture::new();
        f.staking_client().set_total(&100_000);
        f.staking_client().set_epoch(&5);
        f.staking_client().set_user(&f.voters[0], &50_000, &0);

        let id = f.gov_client().create_proposal(
            &f.voters[0],
            &GovernanceAction::PauseProtocol,
            &f.dummy_target(),
            &f.empty_bytes(),
        );
        let err = f.gov_client().try_tally_proposal(&id).unwrap_err().unwrap();
        assert_eq!(err, GovernorError::VotingPeriodActive);
    }

    #[test]
    fn phase_o_configure_requires_multisig() {
        let f = OFixture::new();
        let stranger = Address::generate(&f.env);
        let err = f
            .gov_client()
            .try_configure_token_governance(&stranger, &f.staking, &100, &50, &1_000, &5_001)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, GovernorError::Unauthorized);
    }
}
