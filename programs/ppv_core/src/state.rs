use crate::errors::CoreError;
use anchor_lang::prelude::*;

pub const PROOF_SCHEMA_VERSION: u8 = 1;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum ProofKind {
    Creation,
    Document,
    Agreement,
    Invoice,
    Deliverable,
    Other,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum ProofStatus {
    Active,
    Revoked,
}

#[account]
#[derive(InitSpace)]
pub struct ProofRecord {
    pub schema_version: u8,
    pub bump: u8,
    pub proof_id: [u8; 16],
    pub authority: Pubkey,
    /// SHA-256 over canonical plaintext bytes.
    pub content_hash: [u8; 32],
    /// Optional commitment to a private manifest. All zeroes means absent.
    pub context_hash: [u8; 32],
    pub kind: ProofKind,
    pub status: ProofStatus,
    pub created_at: i64,
    pub revoked_at: i64,
    /// Reserved account space for compatible schema evolution.
    pub reserved: [u8; 64],
}

impl ProofRecord {
    pub fn revoke(&mut self, signer: Pubkey, now: i64) -> Result<()> {
        require_keys_eq!(signer, self.authority, CoreError::Unauthorized);
        require!(
            self.status == ProofStatus::Active,
            CoreError::AlreadyRevoked
        );
        self.status = ProofStatus::Revoked;
        self.revoked_at = now;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn active_proof(authority: Pubkey) -> ProofRecord {
        ProofRecord {
            schema_version: PROOF_SCHEMA_VERSION,
            bump: 255,
            proof_id: [7; 16],
            authority,
            content_hash: [9; 32],
            context_hash: [0; 32],
            kind: ProofKind::Creation,
            status: ProofStatus::Active,
            created_at: 10,
            revoked_at: 0,
            reserved: [0; 64],
        }
    }

    #[test]
    fn only_authority_can_revoke() {
        let authority = Pubkey::new_unique();
        let mut proof = active_proof(authority);
        assert!(proof.revoke(Pubkey::new_unique(), 20).is_err());
        assert_eq!(proof.status, ProofStatus::Active);
    }

    #[test]
    fn revocation_is_terminal() {
        let authority = Pubkey::new_unique();
        let mut proof = active_proof(authority);
        proof.revoke(authority, 20).unwrap();
        assert_eq!(proof.status, ProofStatus::Revoked);
        assert_eq!(proof.revoked_at, 20);
        assert!(proof.revoke(authority, 30).is_err());
    }
}
