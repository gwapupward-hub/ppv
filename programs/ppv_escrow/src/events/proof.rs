use anchor_lang::prelude::*;

use crate::state::AgreementState;

/// Anchoring evidence is a fact about an agreement, not a transition of it.
/// `agreement_state` records the state the agreement was in when the proof
/// arrived, so a consumer can place the event in the lifecycle without having
/// to infer it — and so it is unmistakable that nothing moved.
///
/// `core_proof` is the join to `ppv_core`, which owns the commitment itself.
/// The hashes still appear here because this instruction received them as
/// arguments: an event is a projection, and repeating a value minted
/// atomically in the same transaction costs an indexer nothing and saves it a
/// cross-program read. The account behind this event is where duplication
/// would have been a second source of truth, and it stores no hash at all.
#[event]
pub struct ProofSubmitted {
    pub agreement: Pubkey,
    pub proof: Pubkey,
    /// The `ppv_core::ProofRecord` created by this instruction.
    pub core_proof: Pubkey,
    pub creator: Pubkey,
    pub counterparty: Pubkey,
    pub submitter: Pubkey,
    pub proof_index: u32,
    pub content_hash: [u8; 32],
    pub metadata_hash: [u8; 32],
    pub agreement_state: AgreementState,
    pub timestamp: i64,
}

/// A decision recorded against evidence. Like submission, it is a fact about
/// the agreement rather than a step in it: `agreement_state` is where the
/// agreement was, and stayed.
///
/// No hash here, unlike `ProofSubmitted`: a decision is about a proof, and the
/// hash is an attribute of the proof. This program no longer stores one, and
/// echoing it would mean reading `ppv_core`'s account to restate a value
/// `core_proof` already points at.
#[event]
pub struct ProofApproved {
    pub agreement: Pubkey,
    pub proof: Pubkey,
    pub core_proof: Pubkey,
    pub creator: Pubkey,
    pub counterparty: Pubkey,
    pub submitter: Pubkey,
    pub decided_by: Pubkey,
    pub proof_index: u32,
    pub agreement_state: AgreementState,
    pub timestamp: i64,
}

#[event]
pub struct ProofRejected {
    pub agreement: Pubkey,
    pub proof: Pubkey,
    pub core_proof: Pubkey,
    pub creator: Pubkey,
    pub counterparty: Pubkey,
    pub submitter: Pubkey,
    pub decided_by: Pubkey,
    pub proof_index: u32,
    pub agreement_state: AgreementState,
    pub timestamp: i64,
}
