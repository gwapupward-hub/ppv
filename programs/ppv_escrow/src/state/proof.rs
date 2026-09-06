use anchor_lang::prelude::*;

use crate::errors::EscrowError;
use crate::state::agreement::Agreement;

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

impl Proof {
    /// A decision is made by the party who did *not* submit. Approving your own
    /// evidence would make approval meaningless, and it is the one check that
    /// authorization alone would not catch: both parties are authorized here.
    pub fn require_decidable(
        &self,
        agreement: &Agreement,
        agreement_key: &Pubkey,
        signer: &Pubkey,
    ) -> Result<()> {
        require_keys_eq!(
            self.agreement,
            *agreement_key,
            EscrowError::ProofAgreementMismatch
        );
        require!(agreement.is_party(signer), EscrowError::NotAParty);
        require!(agreement.is_live(), EscrowError::BadState);
        require!(*signer != self.submitter, EscrowError::CannotDecideOwnProof);
        require!(
            self.status == ProofStatus::Submitted,
            EscrowError::ProofAlreadyDecided
        );
        Ok(())
    }

    /// A decision is final. Re-deciding would let a party withdraw an approval
    /// a settlement had already relied on.
    pub fn record_decision(&mut self, status: ProofStatus, decided_by: Pubkey, now: i64) {
        self.status = status;
        self.decided_by = decided_by;
        self.decided_at = now;
    }

    pub fn is_approved(&self) -> bool {
        self.status == ProofStatus::Approved
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{AgreementState, AgreementType, AGREEMENT_SCHEMA_VERSION};

    fn agreement(buyer: Pubkey, seller: Pubkey, state: AgreementState) -> Agreement {
        Agreement {
            schema_version: AGREEMENT_SCHEMA_VERSION,
            bump: 254,
            vault_authority_bump: 253,
            vault_bump: 252,
            creator: buyer,
            counterparty: seller,
            agreement_id: 42,
            agreement_type: AgreementType::Escrow,
            mint: Pubkey::new_unique(),
            vault: Pubkey::new_unique(),
            amount: 100,
            terms_hash: [9; 32],
            state,
            created_at: 10,
            funded_at: 20,
            completed_at: 0,
            settled_at: 0,
            proof_count: 1,
            settlement_proof: Pubkey::default(),
            reserved: [0; 28],
        }
    }

    fn proof(agreement_key: Pubkey, submitter: Pubkey) -> Proof {
        Proof {
            schema_version: PROOF_SCHEMA_VERSION,
            bump: 250,
            agreement: agreement_key,
            submitter,
            proof_index: 0,
            content_hash: [12; 32],
            metadata_hash: [0; 32],
            status: ProofStatus::Submitted,
            created_at: 30,
            decided_at: 0,
            decided_by: Pubkey::default(),
            reserved: [0; 32],
        }
    }

    #[test]
    fn the_other_party_decides_and_the_submitter_cannot() {
        let (buyer, seller) = (Pubkey::new_unique(), Pubkey::new_unique());
        let key = Pubkey::new_unique();
        let agreement = agreement(buyer, seller, AgreementState::Funded);
        let evidence = proof(key, seller);

        assert!(evidence.require_decidable(&agreement, &key, &buyer).is_ok());
        // Both parties are authorized on this agreement, so authorization alone
        // would let the seller approve its own deliverable.
        assert!(evidence
            .require_decidable(&agreement, &key, &seller)
            .is_err());
        assert!(evidence
            .require_decidable(&agreement, &key, &Pubkey::new_unique())
            .is_err());
    }

    #[test]
    fn a_decision_is_final() {
        let (buyer, seller) = (Pubkey::new_unique(), Pubkey::new_unique());
        let key = Pubkey::new_unique();
        let agreement = agreement(buyer, seller, AgreementState::Funded);
        let mut evidence = proof(key, seller);

        evidence.record_decision(ProofStatus::Approved, buyer, 40);
        assert!(evidence.is_approved());
        assert_eq!(evidence.decided_by, buyer);
        assert_eq!(evidence.decided_at, 40);

        // Re-deciding would let a party withdraw an approval a settlement had
        // already relied on.
        assert!(evidence
            .require_decidable(&agreement, &key, &buyer)
            .is_err());
    }

    #[test]
    fn evidence_of_another_agreement_cannot_be_decided_here() {
        let (buyer, seller) = (Pubkey::new_unique(), Pubkey::new_unique());
        let key = Pubkey::new_unique();
        let agreement = agreement(buyer, seller, AgreementState::Funded);
        let elsewhere = proof(Pubkey::new_unique(), seller);
        assert!(elsewhere
            .require_decidable(&agreement, &key, &buyer)
            .is_err());
    }

    #[test]
    fn a_closed_agreement_accepts_no_decisions() {
        let (buyer, seller) = (Pubkey::new_unique(), Pubkey::new_unique());
        let key = Pubkey::new_unique();
        let evidence = proof(key, seller);
        for state in [AgreementState::Open, AgreementState::Settled] {
            let agreement = agreement(buyer, seller, state);
            assert!(evidence
                .require_decidable(&agreement, &key, &buyer)
                .is_err());
        }
    }
}
