use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct CoreConfig {
    pub bump: u8,
    pub version: u8,
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
    /// Pause blocks new proofs and issuer registrations only. Existing owners
    /// retain the ability to revoke while paused.
    pub paused: bool,
    pub created_at: i64,
}

#[account]
#[derive(InitSpace)]
pub struct ProofRecord {
    pub bump: u8,
    pub version: u8,
    /// Client-generated 16-byte identifier. Included in the PDA seed, so a
    /// replayed create transaction cannot initialize a second proof.
    pub proof_id: [u8; 16],
    /// Wallet authority. GNS is display context only and never authorizes.
    pub owner: Pubkey,
    pub owner_gns: Pubkey,
    /// SHA-256 of the original plaintext bytes or canonical document bytes.
    pub content_hash: [u8; 32],
    /// SHA-256 of canonical, non-sensitive metadata.
    pub metadata_hash: [u8; 32],
    pub proof_kind: u8,
    pub created_at: i64,
    pub revoked: bool,
    pub revoked_at: i64,
    pub revocation_reason_hash: [u8; 32],
}

#[account]
#[derive(InitSpace)]
pub struct IssuerRecord {
    pub bump: u8,
    pub version: u8,
    pub issuer: Pubkey,
    pub label_hash: [u8; 32],
    pub active: bool,
    pub registered_at: i64,
    pub updated_at: i64,
}
