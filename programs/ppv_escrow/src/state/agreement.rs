use anchor_lang::prelude::*;

use crate::errors::EscrowError;
use crate::state::enums::{AgreementState, AgreementType, DisputeOutcome};

pub const AGREEMENT_SCHEMA_VERSION: u8 = 1;

/// One agreement is one custody namespace: its own PDA, its own vault
/// authority, its own vault. Nothing here is shared between agreements.
#[account]
#[derive(InitSpace)]
pub struct Agreement {
    pub schema_version: u8,
    pub bump: u8,
    pub vault_authority_bump: u8,
    pub vault_bump: u8,
    /// Buyer. Funds the escrow and pays for the accounts.
    pub creator: Pubkey,
    /// Seller. Performs the work and receives settlement.
    pub counterparty: Pubkey,
    pub agreement_id: u64,
    pub agreement_type: AgreementType,
    /// Fixed at initialization and never rewritten (Invariant 7).
    pub mint: Pubkey,
    pub vault: Pubkey,
    /// The exact amount `fund` moves in and `settle` moves out.
    pub amount: u64,
    /// SHA-256 commitment to the canonical terms document.
    pub terms_hash: [u8; 32],
    pub state: AgreementState,
    pub created_at: i64,
    pub funded_at: i64,
    pub completed_at: i64,
    pub settled_at: i64,
    /// Number of proofs anchored to this agreement. Also the index the next
    /// one gets, which is what keeps proof indices dense and ordered instead
    /// of client-chosen and sparse.
    pub proof_count: u32,
    /// The approved proof settlement cited, or the default address when it
    /// cited none. Recording it here makes a settlement auditable from the
    /// account alone, without replaying its event.
    pub settlement_proof: Pubkey,
    /// Who opened the dispute, or the default address when none was opened.
    pub dispute_opened_by: Pubkey,
    /// When the agreement last changed state by a Phase 5 path — cancelled,
    /// disputed, or refunded. The earlier per-state timestamps stay as they
    /// are; adding one field per state would duplicate the event log on chain,
    /// which is the thing receipts exist to avoid.
    pub state_changed_at: i64,
    /// Reserved account space for compatible schema evolution.
    pub reserved: [u8; 64],
}

impl Agreement {
    pub fn buyer(&self) -> Pubkey {
        self.creator
    }

    pub fn seller(&self) -> Pubkey {
        self.counterparty
    }

    pub fn is_party(&self, signer: &Pubkey) -> bool {
        *signer == self.creator || *signer == self.counterparty
    }

    /// Every guard is expressed as a `require_*` that runs *before* any token
    /// movement, paired with a `record_*` that runs only after custody has
    /// actually settled. Protocol state is never written on the strength of a
    /// transfer that has not happened yet.
    pub fn require_fundable(&self, signer: &Pubkey) -> Result<()> {
        require_keys_eq!(*signer, self.creator, EscrowError::NotTheBuyer);
        require!(self.state == AgreementState::Open, EscrowError::BadState);
        Ok(())
    }

    pub fn record_funded(&mut self, now: i64) -> AgreementState {
        let previous = self.state;
        self.state = AgreementState::Funded;
        self.funded_at = now;
        previous
    }

    pub fn require_completable(&self, signer: &Pubkey) -> Result<()> {
        require_keys_eq!(*signer, self.counterparty, EscrowError::NotTheSeller);
        require!(self.state == AgreementState::Funded, EscrowError::BadState);
        Ok(())
    }

    pub fn record_completed(&mut self, now: i64) -> AgreementState {
        let previous = self.state;
        self.state = AgreementState::Completed;
        self.completed_at = now;
        previous
    }

    /// Either party may trigger settlement. That is safe because the
    /// destination is constrained to the seller's own token account, so a
    /// buyer-initiated settlement can only pay the seller; it is not a
    /// permissionless crank, because a third party has no business touching
    /// custody in the kernel.
    pub fn require_settleable(&self, signer: &Pubkey) -> Result<()> {
        require!(self.is_party(signer), EscrowError::NotAParty);
        require!(
            self.state == AgreementState::Completed,
            EscrowError::BadState
        );
        Ok(())
    }

    /// The window in which the agreement still accepts facts about itself.
    /// Before funding there is nothing escrowed to say anything about; after
    /// settlement the record is closed.
    pub fn is_live(&self) -> bool {
        matches!(
            self.state,
            AgreementState::Funded | AgreementState::Completed | AgreementState::Disputed
        )
    }

    /// Abandoning an agreement nobody funded. Cancellation and refund are not
    /// the same act and must never share a path: this one moves no money
    /// because there is none to move, and the check that keeps it that way is
    /// the `Open` requirement.
    pub fn require_cancellable(&self, signer: &Pubkey) -> Result<()> {
        require_keys_eq!(*signer, self.creator, EscrowError::NotTheBuyer);
        require!(self.state == AgreementState::Open, EscrowError::BadState);
        Ok(())
    }

    pub fn record_cancelled(&mut self, now: i64) -> AgreementState {
        let previous = self.state;
        self.state = AgreementState::Cancelled;
        self.state_changed_at = now;
        previous
    }

    /// Either party may raise a dispute over money already escrowed. Doing so
    /// halts the normal settlement path, because `settle` demands `Completed`
    /// and this state is not it (Invariant 9).
    pub fn require_disputable(&self, signer: &Pubkey) -> Result<()> {
        require!(self.is_party(signer), EscrowError::NotAParty);
        require!(
            matches!(
                self.state,
                AgreementState::Funded | AgreementState::Completed
            ),
            EscrowError::BadState
        );
        Ok(())
    }

    pub fn record_disputed(&mut self, opened_by: Pubkey, now: i64) -> AgreementState {
        let previous = self.state;
        self.state = AgreementState::Disputed;
        self.dispute_opened_by = opened_by;
        self.state_changed_at = now;
        previous
    }

    /// Resolution by concession: the signer gives up its own claim, and the
    /// beneficiary is the other party. Nobody can direct this agreement's money
    /// to a party that did not have it conceded to them, and no third party is
    /// trusted to decide, because none is consulted.
    pub fn require_resolvable(&self, signer: &Pubkey, beneficiary: &Pubkey) -> Result<()> {
        require!(
            self.state == AgreementState::Disputed,
            EscrowError::BadState
        );
        require!(self.is_party(signer), EscrowError::NotAParty);
        require!(self.is_party(beneficiary), EscrowError::NotAParty);
        require!(signer != beneficiary, EscrowError::CannotConcedeToSelf);
        Ok(())
    }

    /// A seller giving the money back without an argument. Restricted to the
    /// seller because it is the seller's claim being surrendered; a buyer who
    /// wants its money back over the seller's objection has to dispute.
    pub fn require_refundable(&self, signer: &Pubkey) -> Result<()> {
        require_keys_eq!(*signer, self.counterparty, EscrowError::NotTheSeller);
        require!(
            matches!(
                self.state,
                AgreementState::Funded | AgreementState::Completed
            ),
            EscrowError::BadState
        );
        Ok(())
    }

    pub fn record_refunded(&mut self, now: i64) -> AgreementState {
        let previous = self.state;
        self.state = AgreementState::Refunded;
        self.state_changed_at = now;
        previous
    }

    /// Which side a resolution favours, derived from who receives the money.
    pub fn outcome_for(&self, beneficiary: &Pubkey) -> DisputeOutcome {
        if *beneficiary == self.counterparty {
            DisputeOutcome::SellerPaid
        } else {
            DisputeOutcome::BuyerRefunded
        }
    }

    /// Evidence may be anchored while the agreement is live. Submission is not
    /// a state transition: it adds a fact, and no custody or lifecycle
    /// consequence follows from it on its own.
    pub fn require_proof_submittable(&self, signer: &Pubkey) -> Result<()> {
        require!(self.is_party(signer), EscrowError::NotAParty);
        require!(self.is_live(), EscrowError::BadState);
        Ok(())
    }

    pub fn record_proof(&mut self) -> Result<u32> {
        let index = self.proof_count;
        self.proof_count = self
            .proof_count
            .checked_add(1)
            .ok_or(EscrowError::Overflow)?;
        Ok(index)
    }

    pub fn record_settled(&mut self, now: i64) -> AgreementState {
        let previous = self.state;
        self.state = AgreementState::Settled;
        self.settled_at = now;
        previous
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TERMS: [u8; 32] = [9; 32];

    fn open(buyer: Pubkey, seller: Pubkey) -> Agreement {
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
            terms_hash: TERMS,
            state: AgreementState::Open,
            created_at: 10,
            funded_at: 0,
            completed_at: 0,
            settled_at: 0,
            proof_count: 0,
            settlement_proof: Pubkey::default(),
            dispute_opened_by: Pubkey::default(),
            state_changed_at: 0,
            reserved: [0; 64],
        }
    }

    fn parties() -> (Pubkey, Pubkey, Pubkey) {
        (
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        )
    }

    #[test]
    fn happy_path_walks_the_whole_lifecycle() {
        let (buyer, seller, _) = parties();
        let mut agreement = open(buyer, seller);

        agreement.require_fundable(&buyer).unwrap();
        assert_eq!(agreement.record_funded(20), AgreementState::Open);

        agreement.require_completable(&seller).unwrap();
        assert_eq!(agreement.record_completed(30), AgreementState::Funded);

        agreement.require_settleable(&buyer).unwrap();
        assert_eq!(agreement.record_settled(40), AgreementState::Completed);

        assert_eq!(agreement.state, AgreementState::Settled);
        assert_eq!(
            (
                agreement.funded_at,
                agreement.completed_at,
                agreement.settled_at
            ),
            (20, 30, 40)
        );
    }

    #[test]
    fn only_the_buyer_can_fund() {
        let (buyer, seller, attacker) = parties();
        let agreement = open(buyer, seller);
        assert!(agreement.require_fundable(&seller).is_err());
        assert!(agreement.require_fundable(&attacker).is_err());
        assert!(agreement.require_fundable(&buyer).is_ok());
    }

    #[test]
    fn funding_twice_is_rejected() {
        let (buyer, seller, _) = parties();
        let mut agreement = open(buyer, seller);
        agreement.require_fundable(&buyer).unwrap();
        agreement.record_funded(20);
        assert!(agreement.require_fundable(&buyer).is_err());
    }

    #[test]
    fn completion_requires_funding_and_the_seller() {
        let (buyer, seller, attacker) = parties();
        let mut agreement = open(buyer, seller);

        // Complete before funding.
        assert!(agreement.require_completable(&seller).is_err());

        agreement.record_funded(20);
        assert!(agreement.require_completable(&buyer).is_err());
        assert!(agreement.require_completable(&attacker).is_err());
        assert!(agreement.require_completable(&seller).is_ok());
    }

    #[test]
    fn completion_cannot_repeat() {
        let (buyer, seller, _) = parties();
        let mut agreement = open(buyer, seller);
        agreement.record_funded(20);
        agreement.require_completable(&seller).unwrap();
        agreement.record_completed(30);
        assert!(agreement.require_completable(&seller).is_err());
    }

    #[test]
    fn settlement_is_illegal_before_completion() {
        let (buyer, seller, _) = parties();
        let mut agreement = open(buyer, seller);

        assert!(agreement.require_settleable(&seller).is_err()); // Open
        agreement.record_funded(20);
        assert!(agreement.require_settleable(&seller).is_err()); // Funded
        agreement.record_completed(30);
        assert!(agreement.require_settleable(&seller).is_ok());
    }

    #[test]
    fn double_settlement_is_impossible() {
        let (buyer, seller, _) = parties();
        let mut agreement = open(buyer, seller);
        agreement.record_funded(20);
        agreement.record_completed(30);
        agreement.require_settleable(&seller).unwrap();
        agreement.record_settled(40);

        assert!(agreement.require_settleable(&seller).is_err());
        assert!(agreement.require_settleable(&buyer).is_err());
    }

    #[test]
    fn an_outsider_can_do_nothing() {
        let (buyer, seller, attacker) = parties();
        let mut agreement = open(buyer, seller);
        agreement.record_funded(20);
        agreement.record_completed(30);
        assert!(agreement.require_settleable(&attacker).is_err());
    }

    #[test]
    fn evidence_can_be_anchored_only_while_the_agreement_is_live() {
        let (buyer, seller, attacker) = parties();
        let mut agreement = open(buyer, seller);

        // Nothing has been escrowed yet, so there is nothing to deliver against.
        assert!(agreement.require_proof_submittable(&seller).is_err());

        agreement.record_funded(20);
        assert!(agreement.require_proof_submittable(&seller).is_ok());
        assert!(agreement.require_proof_submittable(&buyer).is_ok());
        assert!(agreement.require_proof_submittable(&attacker).is_err());

        agreement.record_completed(30);
        assert!(agreement.require_proof_submittable(&seller).is_ok());

        // Settlement closes the record. Evidence cannot be added to a finished
        // agreement after the money has moved.
        agreement.record_settled(40);
        assert!(agreement.require_proof_submittable(&seller).is_err());
    }

    #[test]
    fn proof_indices_are_dense_and_assigned_by_the_agreement() {
        let (buyer, seller, _) = parties();
        let mut agreement = open(buyer, seller);
        assert_eq!(agreement.record_proof().unwrap(), 0);
        assert_eq!(agreement.record_proof().unwrap(), 1);
        assert_eq!(agreement.record_proof().unwrap(), 2);
        assert_eq!(agreement.proof_count, 3);
    }

    #[test]
    fn cancellation_is_only_for_an_agreement_nobody_funded() {
        let (buyer, seller, attacker) = parties();
        let mut agreement = open(buyer, seller);

        assert!(agreement.require_cancellable(&seller).is_err());
        assert!(agreement.require_cancellable(&attacker).is_err());
        assert!(agreement.require_cancellable(&buyer).is_ok());

        // Once money is escrowed, giving it back is a refund, not a
        // cancellation, and it has to move custody.
        agreement.record_funded(20);
        assert!(agreement.require_cancellable(&buyer).is_err());
    }

    #[test]
    fn a_dispute_halts_settlement() {
        let (buyer, seller, attacker) = parties();
        let mut agreement = open(buyer, seller);

        assert!(
            agreement.require_disputable(&buyer).is_err(),
            "nothing escrowed yet"
        );
        agreement.record_funded(20);
        assert!(agreement.require_disputable(&attacker).is_err());
        assert!(agreement.require_disputable(&buyer).is_ok());

        agreement.record_completed(30);
        assert_eq!(
            agreement.record_disputed(seller, 40),
            AgreementState::Completed
        );
        assert_eq!(agreement.dispute_opened_by, seller);

        // Invariant 9, and not as a separate check: settlement demands
        // Completed, and the agreement is no longer in it.
        assert!(agreement.require_settleable(&buyer).is_err());
        assert!(agreement.require_completable(&seller).is_err());
    }

    #[test]
    fn resolution_gives_the_money_to_the_other_party() {
        let (buyer, seller, attacker) = parties();
        let mut agreement = open(buyer, seller);
        agreement.record_funded(20);
        agreement.record_disputed(buyer, 30);

        // Each party can only concede: neither can direct the money to itself.
        assert!(agreement.require_resolvable(&buyer, &seller).is_ok());
        assert!(agreement.require_resolvable(&seller, &buyer).is_ok());
        assert!(agreement.require_resolvable(&buyer, &buyer).is_err());
        assert!(agreement.require_resolvable(&seller, &seller).is_err());
        assert!(agreement.require_resolvable(&attacker, &seller).is_err());
        assert!(agreement.require_resolvable(&buyer, &attacker).is_err());

        assert_eq!(agreement.outcome_for(&seller), DisputeOutcome::SellerPaid);
        assert_eq!(agreement.outcome_for(&buyer), DisputeOutcome::BuyerRefunded);
    }

    #[test]
    fn only_a_disputed_agreement_can_be_resolved() {
        let (buyer, seller, _) = parties();
        let mut agreement = open(buyer, seller);
        assert!(agreement.require_resolvable(&buyer, &seller).is_err());
        agreement.record_funded(20);
        assert!(agreement.require_resolvable(&buyer, &seller).is_err());
        agreement.record_completed(30);
        assert!(agreement.require_resolvable(&buyer, &seller).is_err());
    }

    #[test]
    fn a_refund_is_the_sellers_to_give() {
        let (buyer, seller, attacker) = parties();
        let mut agreement = open(buyer, seller);

        assert!(
            agreement.require_refundable(&seller).is_err(),
            "nothing escrowed yet"
        );
        agreement.record_funded(20);
        // A buyer wanting its money back over the seller's objection has to
        // dispute; it cannot simply take it.
        assert!(agreement.require_refundable(&buyer).is_err());
        assert!(agreement.require_refundable(&attacker).is_err());
        assert!(agreement.require_refundable(&seller).is_ok());

        assert_eq!(agreement.record_refunded(40), AgreementState::Funded);
        assert!(agreement.state.is_terminal());
        assert!(agreement.require_refundable(&seller).is_err());
    }

    #[test]
    fn every_ending_is_final() {
        let (buyer, seller, _) = parties();
        for ending in ["cancelled", "refunded", "settled"] {
            let mut agreement = open(buyer, seller);
            match ending {
                "cancelled" => {
                    agreement.record_cancelled(20);
                }
                "refunded" => {
                    agreement.record_funded(20);
                    agreement.record_refunded(30);
                }
                _ => {
                    agreement.record_funded(20);
                    agreement.record_completed(30);
                    agreement.record_settled(40);
                }
            }

            assert!(agreement.state.is_terminal(), "{ending} must be terminal");
            assert!(agreement.require_fundable(&buyer).is_err());
            assert!(agreement.require_completable(&seller).is_err());
            assert!(agreement.require_settleable(&buyer).is_err());
            assert!(agreement.require_disputable(&buyer).is_err());
            assert!(agreement.require_refundable(&seller).is_err());
            assert!(agreement.require_cancellable(&buyer).is_err());
            assert!(agreement.require_resolvable(&buyer, &seller).is_err());
            assert!(agreement.require_proof_submittable(&seller).is_err());
        }
    }

    #[test]
    fn evidence_can_still_be_anchored_during_a_dispute() {
        let (buyer, seller, _) = parties();
        let mut agreement = open(buyer, seller);
        agreement.record_funded(20);
        agreement.record_disputed(buyer, 30);

        // A dispute is exactly when the parties most need to put evidence on
        // the record.
        assert!(agreement.require_proof_submittable(&buyer).is_ok());
        assert!(agreement.require_proof_submittable(&seller).is_ok());
    }

    #[test]
    fn a_settled_agreement_cannot_reopen() {
        let (buyer, seller, _) = parties();
        let mut agreement = open(buyer, seller);
        agreement.record_funded(20);
        agreement.record_completed(30);
        agreement.record_settled(40);

        assert!(agreement.state.is_terminal());
        assert!(agreement.require_fundable(&buyer).is_err());
        assert!(agreement.require_completable(&seller).is_err());
    }
}
