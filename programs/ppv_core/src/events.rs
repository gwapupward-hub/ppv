use anchor_lang::prelude::*;

#[event]
pub struct ProofCreated {
    pub proof: Pubkey,
    pub proof_id: [u8; 16],
    pub owner: Pubkey,
    pub owner_gns: Pubkey,
    pub content_hash: [u8; 32],
    pub metadata_hash: [u8; 32],
    pub proof_kind: u8,
    pub created_at: i64,
}

#[event]
pub struct ProofRevoked {
    pub proof: Pubkey,
    pub owner: Pubkey,
    pub reason_hash: [u8; 32],
    pub revoked_at: i64,
}

#[event]
pub struct IssuerRegistered {
    pub issuer_record: Pubkey,
    pub issuer: Pubkey,
    pub active: bool,
    pub registered_at: i64,
}

#[event]
pub struct IssuerStatusChanged {
    pub issuer_record: Pubkey,
    pub issuer: Pubkey,
    pub active: bool,
    pub updated_at: i64,
}
