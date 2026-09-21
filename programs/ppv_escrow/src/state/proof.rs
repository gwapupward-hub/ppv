use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;

use crate::constants::CORE_PROOF_ID_DOMAIN;
use crate::errors::EscrowError;
use crate::state::agreement::EscrowAgreement;
use ppv_core::state::ProofStatus as CoreProofStatus;

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

/// The facts `settle` and `settle_milestone` read out of the linked
/// `ppv_core::ProofRecord` before any money moves.
///
/// A plain struct rather than four loose arguments, for one reason: the rule
/// below is the custody boundary RR13-001 found missing, and a rule reachable
/// only through an `AccountInfo` is a rule only a validator can test. Lifted
/// out this way it is an ordinary function with ordinary unit tests, and
/// `scripts/mutation-qualify.sh` can break it and watch `cargo test` notice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CoreCommitment {
    /// The address of the account presented as the core record.
    pub key: Pubkey,
    /// The program that owns it. Anything but `ppv_core` is not a proof record
    /// at all, whatever its bytes decode to.
    pub owner: Pubkey,
    /// `ProofRecord.authority` — the wallet that made the commitment.
    pub authority: Pubkey,
    /// `ProofRecord.status`. The field this whole remediation exists for.
    pub status: CoreProofStatus,
}

impl Proof {
    /// A decision is made by the party who did *not* submit. Approving your own
    /// evidence would make approval meaningless, and it is the one check that
    /// authorization alone would not catch: both parties are authorized here.
    pub fn require_decidable(
        &self,
        agreement: &EscrowAgreement,
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

    /// The rule RR13-001 found missing: evidence an agreement pays out against
    /// must still be evidence at the moment the money moves.
    ///
    /// `ppv_core` is the protocol's canonical commitment primitive, and
    /// `revoke_proof` is its author's statement that the commitment no longer
    /// stands. An escrow approval is a decision *about* that commitment, not a
    /// replacement for it, so a settlement citing a revoked record would be a
    /// payment justified by something its own author has withdrawn — and the
    /// on-chain record would say the payment was proof-backed when it was not.
    ///
    /// Liveness is unaffected, and that is why this can be a hard rule rather
    /// than a policy: citing evidence is optional in both settlement paths, so
    /// a revocation removes a *justification*, never the payment. See
    /// `docs/security-model.md`, "Core revocation and settlement".
    ///
    /// Four things are established before the status is even consulted, because
    /// a status read off the wrong account proves nothing:
    ///
    /// 1. the account is owned by `ppv_core` — otherwise its bytes are some
    ///    other program's, and any layout can be forged into them;
    /// 2. it is the address this decision recorded at submission time;
    /// 3. it is the address the protocol's own derivation produces from
    ///    `(submitter, agreement, proof_index)`, so a stored field is never the
    ///    only thing standing between custody and a substituted account;
    /// 4. the commitment is the submitter's own.
    ///
    /// The discriminator is checked by the caller, which is the only party that
    /// holds the account's bytes; see
    /// `instructions::settlement_proof::load_core_commitment`.
    pub fn require_live_core_commitment(&self, core: &CoreCommitment) -> Result<()> {
        require_keys_eq!(core.owner, ppv_core::ID, EscrowError::CoreProofMismatch);
        require_keys_eq!(core.key, self.core_proof, EscrowError::CoreProofMismatch);

        let (derived, _) = core_proof_address(&self.submitter, &self.agreement, self.proof_index);
        require_keys_eq!(core.key, derived, EscrowError::CoreProofMismatch);
        require_keys_eq!(
            core.authority,
            self.submitter,
            EscrowError::CoreProofMismatch
        );

        require!(
            core.status == CoreProofStatus::Active,
            EscrowError::CoreProofRevoked
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{AgreementState, AgreementType, AGREEMENT_SCHEMA_VERSION};

    fn agreement(buyer: Pubkey, seller: Pubkey, state: AgreementState) -> EscrowAgreement {
        EscrowAgreement {
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

    /// An escrow proof whose `core_proof` really is the address the protocol
    /// derives, which is the only shape `submit_proof` can ever produce.
    fn linked_proof(agreement_key: Pubkey, submitter: Pubkey) -> Proof {
        let mut evidence = proof(agreement_key, submitter);
        evidence.status = ProofStatus::Approved;
        evidence.core_proof = core_proof_address(&submitter, &agreement_key, 0).0;
        evidence
    }

    fn commitment(evidence: &Proof, status: CoreProofStatus) -> CoreCommitment {
        CoreCommitment {
            key: evidence.core_proof,
            owner: ppv_core::ID,
            authority: evidence.submitter,
            status,
        }
    }

    #[test]
    fn approved_evidence_on_a_live_commitment_may_back_a_payout() {
        let submitter = Pubkey::new_unique();
        let evidence = linked_proof(Pubkey::new_unique(), submitter);
        assert!(evidence
            .require_live_core_commitment(&commitment(&evidence, CoreProofStatus::Active))
            .is_ok());
    }

    #[test]
    fn a_revoked_core_commitment_cannot_back_a_payout() {
        // RR13-001. The escrow decision is untouched and still `Approved`: the
        // counterparty did accept this evidence, and that acceptance is not
        // being rewritten. What changed is the commitment it accepted, which
        // its own author has since withdrawn — so the citation is gone even
        // though the approval is not.
        let submitter = Pubkey::new_unique();
        let evidence = linked_proof(Pubkey::new_unique(), submitter);
        assert!(evidence.is_approved());
        assert!(evidence
            .require_live_core_commitment(&commitment(&evidence, CoreProofStatus::Revoked))
            .is_err());
    }

    #[test]
    fn a_record_owned_by_another_program_is_not_a_commitment() {
        // Checked before anything is read out of it: with the owner unchecked,
        // any program could present an account whose bytes spell `Active`.
        let submitter = Pubkey::new_unique();
        let evidence = linked_proof(Pubkey::new_unique(), submitter);
        let mut foreign = commitment(&evidence, CoreProofStatus::Active);
        foreign.owner = crate::ID;
        assert!(evidence.require_live_core_commitment(&foreign).is_err());
        foreign.owner = Pubkey::new_unique();
        assert!(evidence.require_live_core_commitment(&foreign).is_err());
    }

    #[test]
    fn another_proofs_core_record_cannot_stand_in() {
        // A live record of a different agreement, a different index, or a
        // different submitter is still a live record. Substituting one would
        // satisfy a status check that looked no further.
        let submitter = Pubkey::new_unique();
        let agreement_key = Pubkey::new_unique();
        let evidence = linked_proof(agreement_key, submitter);

        for elsewhere in [
            core_proof_address(&submitter, &Pubkey::new_unique(), 0).0,
            core_proof_address(&submitter, &agreement_key, 1).0,
            core_proof_address(&Pubkey::new_unique(), &agreement_key, 0).0,
        ] {
            let mut substituted = commitment(&evidence, CoreProofStatus::Active);
            substituted.key = elsewhere;
            assert!(evidence.require_live_core_commitment(&substituted).is_err());
        }
    }

    #[test]
    fn the_stored_link_is_never_the_only_thing_checked() {
        // Both the recorded address and the derived one must agree. If the
        // stored field were the only test, a proof account whose `core_proof`
        // was ever written wrongly would be enough to move money; if the
        // derivation were the only test, the account this decision was
        // actually made about would stop mattering.
        let submitter = Pubkey::new_unique();
        let agreement_key = Pubkey::new_unique();
        let mut evidence = linked_proof(agreement_key, submitter);
        let derived = evidence.core_proof;

        evidence.core_proof = Pubkey::new_unique();
        let mut presented = commitment(&evidence, CoreProofStatus::Active);
        presented.key = derived;
        assert!(evidence.require_live_core_commitment(&presented).is_err());

        presented.key = evidence.core_proof;
        assert!(evidence.require_live_core_commitment(&presented).is_err());
    }

    #[test]
    fn a_commitment_made_by_someone_else_cannot_back_this_evidence() {
        let submitter = Pubkey::new_unique();
        let evidence = linked_proof(Pubkey::new_unique(), submitter);
        let mut wrong_author = commitment(&evidence, CoreProofStatus::Active);
        wrong_author.authority = Pubkey::new_unique();
        assert!(evidence
            .require_live_core_commitment(&wrong_author)
            .is_err());
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
