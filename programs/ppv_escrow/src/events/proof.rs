use anchor_lang::prelude::*;

use crate::state::AgreementState;

/// Anchoring evidence is a fact about an agreement, not a transition of it.
/// `agreement_state` records the state the agreement was in when the proof
/// arrived, so a consumer can place the event in the lifecycle without having
/// to infer it — and so it is unmistakable that nothing moved.
#[event]
pub struct ProofSubmitted {
    pub agreement: Pubkey,
    pub proof: Pubkey,
    pub creator: Pubkey,
    pub counterparty: Pubkey,
    pub submitter: Pubkey,
    pub proof_index: u32,
    pub content_hash: [u8; 32],
    pub metadata_hash: [u8; 32],
    pub agreement_state: AgreementState,
    pub timestamp: i64,
}
