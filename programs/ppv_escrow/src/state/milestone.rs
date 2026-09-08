use anchor_lang::prelude::*;

use crate::errors::EscrowError;
use crate::state::agreement::EscrowAgreement;
use crate::state::enums::MilestoneState;

pub const MILESTONE_SCHEMA_VERSION: u8 = 1;

/// A tranche of one agreement's escrow, with its own small lifecycle.
///
/// A milestone never holds custody of its own: the money is in the agreement's
/// single vault, and a milestone is the record of which part of it has been
/// earned. Giving each milestone a vault would multiply the custody surface by
/// the number of milestones for no gain.
#[account]
#[derive(InitSpace)]
pub struct Milestone {
    pub schema_version: u8,
    pub bump: u8,
    /// The agreement this milestone belongs to, and can never leave.
    pub agreement: Pubkey,
    pub milestone_index: u32,
    pub amount: u64,
    /// SHA-256 commitment to what this milestone requires.
    pub terms_hash: [u8; 32],
    pub state: MilestoneState,
    /// The approved proof cited when this milestone settled, or the default
    /// address when it cited none.
    pub proof: Pubkey,
    pub created_at: i64,
    pub submitted_at: i64,
    pub approved_at: i64,
    pub settled_at: i64,
    pub reserved: [u8; 32],
}

impl Milestone {
    fn require_belongs_to(&self, agreement_key: &Pubkey) -> Result<()> {
        require_keys_eq!(
            self.agreement,
            *agreement_key,
            EscrowError::MilestoneAgreementMismatch
        );
        Ok(())
    }

    /// The seller says a tranche of work is done. Like `mark_completed`, this
    /// moves no money.
    pub fn require_submittable(
        &self,
        agreement: &EscrowAgreement,
        agreement_key: &Pubkey,
        signer: &Pubkey,
    ) -> Result<()> {
        self.require_belongs_to(agreement_key)?;
        require_keys_eq!(*signer, agreement.counterparty, EscrowError::NotTheSeller);
        require!(
            self.state == MilestoneState::Pending,
            EscrowError::MilestoneBadState
        );
        Ok(())
    }

    /// The buyer accepts or refuses it. A refusal returns the milestone to
    /// `Pending` so the seller can try again — unlike a proof decision, which
    /// is about a fixed set of bytes and is final.
    pub fn require_decidable(
        &self,
        agreement: &EscrowAgreement,
        agreement_key: &Pubkey,
        signer: &Pubkey,
    ) -> Result<()> {
        self.require_belongs_to(agreement_key)?;
        require_keys_eq!(*signer, agreement.creator, EscrowError::NotTheBuyer);
        require!(
            self.state == MilestoneState::Submitted,
            EscrowError::MilestoneBadState
        );
        Ok(())
    }

    /// Either party may release an approved tranche, for the same reason either
    /// may settle an agreement: the destination is the seller's regardless.
    pub fn require_settleable(
        &self,
        agreement: &EscrowAgreement,
        agreement_key: &Pubkey,
        signer: &Pubkey,
    ) -> Result<()> {
        self.require_belongs_to(agreement_key)?;
        require!(agreement.is_party(signer), EscrowError::NotAParty);
        require!(
            self.state == MilestoneState::Approved,
            EscrowError::MilestoneBadState
        );
        Ok(())
    }

    pub fn record_submitted(&mut self, now: i64) -> MilestoneState {
        let previous = self.state;
        self.state = MilestoneState::Submitted;
        self.submitted_at = now;
        previous
    }

    pub fn record_approved(&mut self, now: i64) -> MilestoneState {
        let previous = self.state;
        self.state = MilestoneState::Approved;
        self.approved_at = now;
        previous
    }

    pub fn record_rejected(&mut self, now: i64) -> MilestoneState {
        let previous = self.state;
        self.state = MilestoneState::Pending;
        self.submitted_at = now;
        previous
    }

    pub fn record_settled(&mut self, proof: Pubkey, now: i64) -> MilestoneState {
        let previous = self.state;
        self.state = MilestoneState::Settled;
        self.proof = proof;
        self.settled_at = now;
        previous
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{AgreementState, AgreementType, AGREEMENT_SCHEMA_VERSION};

    fn contract(buyer: Pubkey, seller: Pubkey, state: AgreementState) -> EscrowAgreement {
        EscrowAgreement {
            schema_version: AGREEMENT_SCHEMA_VERSION,
            bump: 254,
            vault_authority_bump: 253,
            vault_bump: 252,
            creator: buyer,
            counterparty: seller,
            agreement_id: 42,
            agreement_type: AgreementType::MilestoneContract,
            mint: Pubkey::new_unique(),
            vault: Pubkey::new_unique(),
            amount: 100,
            terms_hash: [9; 32],
            state,
            created_at: 10,
            funded_at: 20,
            completed_at: 0,
            settled_at: 0,
            proof_count: 0,
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

    fn milestone(agreement_key: Pubkey, amount: u64) -> Milestone {
        Milestone {
            schema_version: MILESTONE_SCHEMA_VERSION,
            bump: 250,
            agreement: agreement_key,
            milestone_index: 0,
            amount,
            terms_hash: [11; 32],
            state: MilestoneState::Pending,
            proof: Pubkey::default(),
            created_at: 30,
            submitted_at: 0,
            approved_at: 0,
            settled_at: 0,
            reserved: [0; 32],
        }
    }

    #[test]
    fn a_tranche_walks_its_own_lifecycle() {
        let (buyer, seller) = (Pubkey::new_unique(), Pubkey::new_unique());
        let key = Pubkey::new_unique();
        let agreement = contract(buyer, seller, AgreementState::Funded);
        let mut tranche = milestone(key, 40);

        assert!(tranche
            .require_submittable(&agreement, &key, &seller)
            .is_ok());
        assert_eq!(tranche.record_submitted(40), MilestoneState::Pending);
        assert!(tranche.require_decidable(&agreement, &key, &buyer).is_ok());
        assert_eq!(tranche.record_approved(50), MilestoneState::Submitted);
        assert!(tranche
            .require_settleable(&agreement, &key, &seller)
            .is_ok());
        assert_eq!(
            tranche.record_settled(Pubkey::default(), 60),
            MilestoneState::Approved
        );
        assert_eq!(tranche.state, MilestoneState::Settled);
    }

    #[test]
    fn each_step_is_the_right_partys_and_only_from_the_right_state() {
        let (buyer, seller) = (Pubkey::new_unique(), Pubkey::new_unique());
        let outsider = Pubkey::new_unique();
        let key = Pubkey::new_unique();
        let agreement = contract(buyer, seller, AgreementState::Funded);
        let mut tranche = milestone(key, 40);

        assert!(tranche
            .require_submittable(&agreement, &key, &buyer)
            .is_err());
        assert!(tranche
            .require_submittable(&agreement, &key, &outsider)
            .is_err());
        // Nothing to decide or settle before it is submitted.
        assert!(tranche.require_decidable(&agreement, &key, &buyer).is_err());
        assert!(tranche
            .require_settleable(&agreement, &key, &seller)
            .is_err());

        tranche.record_submitted(40);
        // The seller cannot approve its own submission.
        assert!(tranche
            .require_decidable(&agreement, &key, &seller)
            .is_err());
        assert!(tranche
            .require_settleable(&agreement, &key, &seller)
            .is_err());

        tranche.record_approved(50);
        assert!(tranche.require_decidable(&agreement, &key, &buyer).is_err());
        // Either party may release an approved tranche; the destination is the
        // seller's regardless.
        assert!(tranche.require_settleable(&agreement, &key, &buyer).is_ok());
    }

    #[test]
    fn a_rejection_sends_the_tranche_back_to_be_redone() {
        let (buyer, seller) = (Pubkey::new_unique(), Pubkey::new_unique());
        let key = Pubkey::new_unique();
        let agreement = contract(buyer, seller, AgreementState::Funded);
        let mut tranche = milestone(key, 40);

        tranche.record_submitted(40);
        assert_eq!(tranche.record_rejected(45), MilestoneState::Submitted);
        assert_eq!(tranche.state, MilestoneState::Pending);
        // Unlike a proof decision, which is about a fixed set of bytes and is
        // final, a rejected milestone can be resubmitted.
        assert!(tranche
            .require_submittable(&agreement, &key, &seller)
            .is_ok());
    }

    #[test]
    fn a_settled_tranche_cannot_be_paid_twice() {
        let (buyer, seller) = (Pubkey::new_unique(), Pubkey::new_unique());
        let key = Pubkey::new_unique();
        let agreement = contract(buyer, seller, AgreementState::Funded);
        let mut tranche = milestone(key, 40);

        tranche.record_submitted(40);
        tranche.record_approved(50);
        tranche.record_settled(Pubkey::default(), 60);
        assert!(tranche
            .require_settleable(&agreement, &key, &seller)
            .is_err());
    }

    #[test]
    fn a_tranche_of_another_agreement_is_unusable_here() {
        let (buyer, seller) = (Pubkey::new_unique(), Pubkey::new_unique());
        let key = Pubkey::new_unique();
        let agreement = contract(buyer, seller, AgreementState::Funded);
        let elsewhere = milestone(Pubkey::new_unique(), 40);
        assert!(elsewhere
            .require_submittable(&agreement, &key, &seller)
            .is_err());
        assert!(elsewhere
            .require_decidable(&agreement, &key, &buyer)
            .is_err());
        assert!(elsewhere
            .require_settleable(&agreement, &key, &seller)
            .is_err());
    }

    #[test]
    fn a_schedule_cannot_promise_more_than_the_escrow_holds() {
        let (buyer, seller) = (Pubkey::new_unique(), Pubkey::new_unique());
        let mut agreement = contract(buyer, seller, AgreementState::Open);

        assert_eq!(agreement.record_milestone(60).unwrap(), 0);
        assert_eq!(agreement.record_milestone(40).unwrap(), 1);
        assert_eq!(agreement.milestone_total, 100);
        // The schedule is full; one more tranche would promise money the vault
        // will never hold.
        assert!(agreement.record_milestone(1).is_err());
    }

    #[test]
    fn the_agreement_settles_when_its_last_tranche_does() {
        let (buyer, seller) = (Pubkey::new_unique(), Pubkey::new_unique());
        let mut agreement = contract(buyer, seller, AgreementState::Open);
        agreement.record_milestone(60).unwrap();
        agreement.record_milestone(40).unwrap();
        agreement.record_funded(20);

        assert!(!agreement.record_milestone_settled(60, 30).unwrap());
        assert_eq!(agreement.state, AgreementState::Funded);
        assert_eq!(agreement.remaining(), 40);

        assert!(agreement.record_milestone_settled(40, 40).unwrap());
        assert_eq!(agreement.state, AgreementState::Settled);
        assert_eq!(agreement.remaining(), 0);
        assert!(agreement.state.is_terminal());
    }

    #[test]
    fn a_refund_midway_returns_only_what_is_left() {
        let (buyer, seller) = (Pubkey::new_unique(), Pubkey::new_unique());
        let mut agreement = contract(buyer, seller, AgreementState::Open);
        agreement.record_milestone(60).unwrap();
        agreement.record_milestone(40).unwrap();
        agreement.record_funded(20);
        agreement.record_milestone_settled(60, 30).unwrap();

        // The tranche the seller earned is not the buyer's to take back.
        assert_eq!(agreement.remaining(), 40);
        agreement.record_payout(40).unwrap();
        assert_eq!(agreement.remaining(), 0);
        // And nothing can pay out more than was escrowed.
        assert!(agreement.record_payout(1).is_err());
    }

    #[test]
    fn a_milestone_contract_has_no_single_moment_of_completion() {
        let (buyer, seller) = (Pubkey::new_unique(), Pubkey::new_unique());
        let mut agreement = contract(buyer, seller, AgreementState::Open);
        agreement.record_milestone(100).unwrap();
        agreement.record_funded(20);
        assert!(agreement.require_completable(&seller).is_err());
    }
}
