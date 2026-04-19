//! StellaX governance contract — Phase 10.
//!
//! Multi-sig admin governance (v1 — not token-based):
//! - Proposal system with timelock: `propose` → `approve` (N-of-M) → `execute`.
//! - `GovernanceAction` enum dispatches on-chain effects or emits events for keepers.
//! - Emergency guardian: single-sig fast pause, full multisig + timelock for unpause.
//! - Upgradeable: governor can upgrade itself or other protocol contracts via
//!   the `UpgradeContract` action.
#![no_std]
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
}

// ─── Cross-contract client (upgrade target contracts) ─────────────────────────

/// Minimal interface every upgradeable StellaX contract exposes.
#[contractclient(name = "UpgradeableClient")]
#[allow(dead_code)]
trait UpgradeableContract {
    fn upgrade(env: Env, new_wasm_hash: BytesN<32>);
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
        | GovernanceAction::UnpauseMarket => {
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
}
