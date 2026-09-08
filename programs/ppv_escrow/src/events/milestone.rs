use anchor_lang::prelude::*;

use crate::state::{AgreementState, MilestoneState};

// Milestone events report the *milestone's* transition and the agreement state
// they happened in. Only `settle_milestone` moves money, and the payment it
// makes is reported by the `SettlementExecuted` emitted beside it — the same
// event a single-payment agreement emits — so a consumer counting payments has
// one event type to count however the payment was structured.

#[event]
pub struct MilestoneCreated {
    pub agreement: Pubkey,
    pub milestone: Pubkey,
    pub creator: Pubkey,
    pub counterparty: Pubkey,
    pub milestone_index: u32,
    pub amount: u64,
    pub terms_hash: [u8; 32],
    pub agreement_state: AgreementState,
    pub timestamp: i64,
}

#[event]
pub struct MilestoneSubmitted {
    pub agreement: Pubkey,
    pub milestone: Pubkey,
    pub creator: Pubkey,
    pub counterparty: Pubkey,
    pub milestone_index: u32,
    pub previous_state: MilestoneState,
    pub new_state: MilestoneState,
    pub agreement_state: AgreementState,
    pub timestamp: i64,
}

#[event]
pub struct MilestoneApproved {
    pub agreement: Pubkey,
    pub milestone: Pubkey,
    pub creator: Pubkey,
    pub counterparty: Pubkey,
    pub milestone_index: u32,
    pub previous_state: MilestoneState,
    pub new_state: MilestoneState,
    pub agreement_state: AgreementState,
    pub timestamp: i64,
}

/// A refusal sends the milestone back to `Pending`, so the seller can resubmit.
#[event]
pub struct MilestoneRejected {
    pub agreement: Pubkey,
    pub milestone: Pubkey,
    pub creator: Pubkey,
    pub counterparty: Pubkey,
    pub milestone_index: u32,
    pub previous_state: MilestoneState,
    pub new_state: MilestoneState,
    pub agreement_state: AgreementState,
    pub timestamp: i64,
}

#[event]
pub struct MilestoneSettled {
    pub agreement: Pubkey,
    pub milestone: Pubkey,
    pub creator: Pubkey,
    pub counterparty: Pubkey,
    pub milestone_index: u32,
    pub amount: u64,
    pub destination: Pubkey,
    pub proof: Option<Pubkey>,
    pub previous_state: MilestoneState,
    pub new_state: MilestoneState,
    /// The agreement state after this payment: still `Funded` while tranches
    /// remain, `Settled` once the last one is paid.
    pub agreement_state: AgreementState,
    pub timestamp: i64,
}
