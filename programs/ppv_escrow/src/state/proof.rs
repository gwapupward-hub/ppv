use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;

use crate::constants::CORE_PROOF_ID_DOMAIN;
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

/// One agreement's decision about one piece of evidence.
///
/// This account deliberately does **not** hold a content hash. PPV has exactly
/// one proof primitive — `ppv_core::ProofRecord` — and a second program storing
/// its own copy of a commitment is a second source of truth: two records that
/// can disagree, two things to revoke, and an indexer that has to pick one.
/// `submit_proof` mints the commitment in `ppv_core` over a CPI and records
/// only its address here.
///
/// What is left is genuinely escrow's: which agreement the evidence was offered
/// under, who offered it, and what the counterparty decided. None of that
/// belongs in a standalone registry, and none of it is a restatement of
/// anything `ppv_core` already knows.
///
/// The bytes a commitment covers live in IPFS, Arweave, encrypted object
/// storage, or the party's own machine. The chain's claim is only that a
/// particular wallet committed to particular bytes, bound to a particular
/// agreement, no later than a Solana-confirmed time.
#[account]
#[derive(InitSpace)]
pub struct Proof {
    pub schema_version: u8,
    pub bump: u8,
    /// The agreement this evidence belongs to, and can never leave.
    pub agreement: Pubkey,
    /// The `ppv_core::ProofRecord` holding the commitment. Its address is a
    /// pure function of `(agreement, proof_index)` and the submitter — see
    /// [`core_proof_id`] — so this field is a convenience for readers, not a
    /// fact anyone has to be trusted for.
    pub core_proof: Pubkey,
    pub submitter: Pubkey,
    pub proof_index: u32,
    pub status: ProofStatus,
    pub created_at: i64,
    /// Set when a decision is recorded; zero while `Submitted`.
    pub decided_at: i64,
    pub decided_by: Pubkey,
    pub reserved: [u8; 32],
}

/// The `proof_id` ppv_escrow asks ppv_core to mint for one agreement's proof.
///
/// Deterministic, so the core record's address follows from facts already on
/// chain, and domain-separated, so an id minted through escrow can never
/// collide with one a wallet chose for itself.
pub fn core_proof_id(agreement: &Pubkey, proof_index: u32) -> [u8; 16] {
    let digest = hashv(&[
        CORE_PROOF_ID_DOMAIN,
        agreement.as_ref(),
        &proof_index.to_le_bytes(),
    ]);
    let mut id = [0u8; 16];
    id.copy_from_slice(&digest.to_bytes()[..16]);
    id
}

/// The address `ppv_core` will hold this agreement's proof at.
///
/// Exported so a client builds the account list from the protocol's own
/// derivation instead of guessing, and so an indexer can verify the link rather
/// than believing the `core_proof` field.
pub fn core_proof_address(
    submitter: &Pubkey,
    agreement: &Pubkey,
    proof_index: u32,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            ppv_core::PROOF_SEED,
            submitter.as_ref(),
            core_proof_id(agreement, proof_index).as_ref(),
        ],
        &ppv_core::ID,
    )
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
            dispute_opened_by: Pubkey::default(),
            state_changed_at: 0,
            milestone_count: 0,
            milestones_settled: 0,
            milestone_total: 0,
            settled_total: 0,
            reserved: [0; 40],
        }
    }

    fn proof(agreement_key: Pubkey, submitter: Pubkey) -> Proof {
        Proof {
            schema_version: PROOF_SCHEMA_VERSION,
            bump: 250,
            agreement: agreement_key,
            core_proof: Pubkey::new_unique(),
            submitter,
            proof_index: 0,
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

    #[test]
    fn the_core_proof_id_is_bound_to_the_agreement_and_the_index() {
        let a = Pubkey::new_unique();
        let b = Pubkey::new_unique();
        assert_ne!(core_proof_id(&a, 0), core_proof_id(&b, 0));
        assert_ne!(core_proof_id(&a, 0), core_proof_id(&a, 1));
        // Deterministic: an indexer that recomputes it must get the same answer
        // as the program did.
        assert_eq!(core_proof_id(&a, 3), core_proof_id(&a, 3));
    }

    #[test]
    fn the_core_proof_id_is_domain_separated() {
        // Without the prefix this would be sha256(agreement || index), which a
        // future derivation over the same inputs could reproduce by accident.
        let agreement = Pubkey::new_unique();
        let undomained = hashv(&[agreement.as_ref(), &0u32.to_le_bytes()]);
        assert_ne!(
            &core_proof_id(&agreement, 0)[..],
            &undomained.to_bytes()[..16]
        );
    }

    #[test]
    fn the_core_proof_address_is_a_ppv_core_pda() {
        // Escrow derives it under ppv_core's id, never its own: the record is
        // ppv_core's account, and only ppv_core can create it.
        let submitter = Pubkey::new_unique();
        let agreement = Pubkey::new_unique();
        let (address, _) = core_proof_address(&submitter, &agreement, 0);
        let expected = Pubkey::find_program_address(
            &[
                ppv_core::PROOF_SEED,
                submitter.as_ref(),
                core_proof_id(&agreement, 0).as_ref(),
            ],
            &ppv_core::ID,
        )
        .0;
        assert_eq!(address, expected);
        assert_ne!(
            address,
            Pubkey::find_program_address(
                &[
                    ppv_core::PROOF_SEED,
                    submitter.as_ref(),
                    core_proof_id(&agreement, 0).as_ref(),
                ],
                &crate::ID,
            )
            .0
        );
    }

    #[test]
    fn two_submitters_cannot_land_on_the_same_core_record() {
        // ppv_core keys its proofs by authority as well as id, so the same
        // agreement and index under two wallets are two distinct records.
        let agreement = Pubkey::new_unique();
        let one = Pubkey::new_unique();
        let two = Pubkey::new_unique();
        assert_ne!(
            core_proof_address(&one, &agreement, 0).0,
            core_proof_address(&two, &agreement, 0).0
        );
    }
}
