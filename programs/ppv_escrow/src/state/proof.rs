use anchor_lang::prelude::*;

pub const PROOF_SCHEMA_VERSION: u8 = 1;

/// What has been decided about a piece of evidence.
///
/// `Approved` and `Rejected` are written by Phase 4's `approve_proof` and
/// `reject_proof`. The variants and the account fields that record a decision
/// are defined here, in the release that creates proofs, so adding the decision
/// instructions later does not move a byte for anything already decoding them.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum ProofStatus {
    Submitted,
    Approved,
    Rejected,
}

/// A cryptographic commitment anchored to one agreement.
///
/// The chain stores hashes and references, never the evidence itself. The bytes
/// a `content_hash` commits to live in IPFS, Arweave, encrypted object storage,
/// or the party's own machine; PPV's claim is only that a particular wallet
/// committed to particular bytes, bound to a particular agreement, no later
/// than a Solana-confirmed time.
#[account]
#[derive(InitSpace)]
pub struct Proof {
    pub schema_version: u8,
    pub bump: u8,
    /// The agreement this evidence belongs to, and can never leave.
    pub agreement: Pubkey,
    pub submitter: Pubkey,
    pub proof_index: u32,
    /// SHA-256 over the canonical deliverable bytes. Never all zeroes.
    pub content_hash: [u8; 32],
    /// SHA-256 over a private manifest or metadata. All zeroes means none.
    pub metadata_hash: [u8; 32],
    pub status: ProofStatus,
    pub created_at: i64,
    /// Set when Phase 4 approves or rejects; zero while `Submitted`.
    pub decided_at: i64,
    pub decided_by: Pubkey,
    pub reserved: [u8; 32],
}
