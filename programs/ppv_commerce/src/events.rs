use anchor_lang::prelude::*;

#[event]
pub struct AgreementCreated {
    pub agreement: Pubkey,
    pub agreement_id: [u8; 16],
    pub party_a: Pubkey,
    pub party_b: Pubkey,
    pub version: u32,
    pub content_hash: [u8; 32],
    pub terms_hash: [u8; 32],
    pub expires_at: i64,
    pub created_at: i64,
}

#[event]
pub struct AgreementRevised {
    pub agreement: Pubkey,
    pub proposer: Pubkey,
    pub previous_version: u32,
    pub new_version: u32,
    pub content_hash: [u8; 32],
    pub terms_hash: [u8; 32],
    pub signatures_cleared: bool,
    pub revised_at: i64,
}

#[event]
pub struct AgreementSigned {
    pub agreement: Pubkey,
    pub signer: Pubkey,
    pub version: u32,
    pub content_hash: [u8; 32],
    pub terms_hash: [u8; 32],
    pub signed_at: i64,
}

#[event]
pub struct AgreementExecuted {
    pub agreement: Pubkey,
    pub party_a: Pubkey,
    pub party_b: Pubkey,
    pub version: u32,
    pub content_hash: [u8; 32],
    pub terms_hash: [u8; 32],
    pub executed_at: i64,
}

#[event]
pub struct AgreementCancelled {
    pub agreement: Pubkey,
    pub cancelled_by: Pubkey,
    pub version: u32,
    pub cancelled_at: i64,
}
