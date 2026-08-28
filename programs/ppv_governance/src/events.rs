use anchor_lang::prelude::*;

#[event]
pub struct GovernanceInitialized {
    pub governance: Pubkey,
    pub vault: Pubkey,
    pub member_count: u8,
    pub threshold: u8,
    pub min_delay_slots: u64,
    pub proposal_lifetime_slots: u64,
    pub treasury: Pubkey,
}

#[event]
pub struct ProposalCreated {
    pub governance: Pubkey,
    pub proposal: Pubkey,
    pub proposal_id: u64,
    pub proposer: Pubkey,
    /// 0 = upgrade, 1 = governance reconfiguration.
    pub action_kind: u8,
    pub governance_epoch: u64,
    pub execute_after_slot: u64,
    pub expires_at_slot: u64,
}

#[event]
pub struct ProposalApproved {
    pub governance: Pubkey,
    pub proposal: Pubkey,
    pub proposal_id: u64,
    pub member: Pubkey,
    pub approval_count: u8,
    pub threshold: u8,
}

#[event]
pub struct ProposalCancelled {
    pub governance: Pubkey,
    pub proposal: Pubkey,
    pub proposal_id: u64,
    pub proposer: Pubkey,
}

#[event]
pub struct ProgramUpgradeExecuted {
    pub governance: Pubkey,
    pub vault: Pubkey,
    pub proposal: Pubkey,
    pub proposal_id: u64,
    pub program: Pubkey,
    pub buffer: Pubkey,
    pub executor: Pubkey,
}

#[event]
pub struct GovernanceReconfigured {
    pub governance: Pubkey,
    pub proposal: Pubkey,
    pub proposal_id: u64,
    pub new_epoch: u64,
    pub member_count: u8,
    pub threshold: u8,
    pub min_delay_slots: u64,
    pub proposal_lifetime_slots: u64,
    pub treasury: Pubkey,
}
