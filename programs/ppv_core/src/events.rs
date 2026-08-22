use crate::state::ProofKind;
use anchor_lang::prelude::*;

#[event]
pub struct ProofCreated {
    pub proof: Pubkey,
    pub authority: Pubkey,
    pub proof_id: [u8; 16],
    pub content_hash: [u8; 32],
    pub context_hash: [u8; 32],
    pub kind: ProofKind,
    pub created_at: i64,
}

#[event]
pub struct ProofRevoked {
    pub proof: Pubkey,
    pub authority: Pubkey,
    pub content_hash: [u8; 32],
    pub revoked_at: i64,
}
