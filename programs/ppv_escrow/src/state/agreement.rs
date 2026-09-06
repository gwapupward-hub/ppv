use anchor_lang::prelude::*;

use crate::errors::EscrowError;
use crate::state::enums::{AgreementState, AgreementType};

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
