pub mod agreement;
pub mod dispute;
pub mod proof;
pub mod settlement;

pub use agreement::*;
pub use dispute::*;
pub use proof::*;
pub use settlement::*;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{AgreementState, AgreementType};
    use anchor_lang::prelude::*;
    use anchor_lang::solana_program::hash::hash;
    use anchor_lang::Discriminator;

    fn expected(name: &str) -> [u8; 8] {
        let digest = hash(format!("event:{name}").as_bytes()).to_bytes();
        let mut out = [0u8; 8];
        out.copy_from_slice(&digest[..8]);
        out
    }

    #[test]
    fn event_discriminators_are_pinned() {
        assert_eq!(
            AgreementCreated::DISCRIMINATOR,
            expected("AgreementCreated")
        );
        assert_eq!(AgreementFunded::DISCRIMINATOR, expected("AgreementFunded"));
        assert_eq!(WorkCompleted::DISCRIMINATOR, expected("WorkCompleted"));
        assert_eq!(
            SettlementExecuted::DISCRIMINATOR,
            expected("SettlementExecuted")
        );
        assert_eq!(ProofSubmitted::DISCRIMINATOR, expected("ProofSubmitted"));
        assert_eq!(ProofApproved::DISCRIMINATOR, expected("ProofApproved"));
        assert_eq!(ProofRejected::DISCRIMINATOR, expected("ProofRejected"));
        assert_eq!(
            AgreementCancelled::DISCRIMINATOR,
            expected("AgreementCancelled")
        );
        assert_eq!(DisputeOpened::DISCRIMINATOR, expected("DisputeOpened"));
        assert_eq!(DisputeResolved::DISCRIMINATOR, expected("DisputeResolved"));
        assert_eq!(RefundExecuted::DISCRIMINATOR, expected("RefundExecuted"));
    }

    // `ppv_commerce` emits an `AgreementCreated` too, and Anchor derives the
    // discriminator from the name alone, so the two are byte-identical. This
    // pins that fact rather than leaving it to be discovered by an indexer:
    // event identity is (program id, discriminator), and the SDK decodes
    // through `decodeEventForProgram`.
    #[test]
    fn agreement_created_shares_a_discriminator_with_commerce() {
        assert_eq!(
            AgreementCreated::DISCRIMINATOR,
            expected("AgreementCreated")
        );
    }

    // Byte-exact layout vectors shared with sdk/test/escrow-events.test.ts.
    #[test]
    fn agreement_funded_layout_is_pinned() {
        let event = AgreementFunded {
            agreement: Pubkey::new_from_array([5; 32]),
            creator: Pubkey::new_from_array([1; 32]),
            counterparty: Pubkey::new_from_array([2; 32]),
            amount: 100_000_000,
            mint: Pubkey::new_from_array([3; 32]),
            vault: Pubkey::new_from_array([4; 32]),
            previous_state: AgreementState::Open,
            new_state: AgreementState::Funded,
            timestamp: 1_700_000_100,
        };
        let bytes = event.try_to_vec().unwrap();
        assert_eq!(bytes.len(), 32 * 3 + 8 + 32 * 2 + 1 + 1 + 8);
        assert_eq!(&bytes[96..104], &100_000_000u64.to_le_bytes());
        assert_eq!(bytes[168], 0); // Open
        assert_eq!(bytes[169], 1); // Funded
    }

    #[test]
    fn settlement_layout_reserves_the_proof_slot() {
        let event = SettlementExecuted {
            agreement: Pubkey::new_from_array([5; 32]),
            buyer: Pubkey::new_from_array([1; 32]),
            seller: Pubkey::new_from_array([2; 32]),
            amount: 100_000_000,
            mint: Pubkey::new_from_array([3; 32]),
            destination: Pubkey::new_from_array([6; 32]),
            proof: None,
            previous_state: AgreementState::Completed,
            new_state: AgreementState::Settled,
            timestamp: 1_700_000_300,
        };
        let bytes = event.try_to_vec().unwrap();
        assert_eq!(bytes.len(), 32 * 3 + 8 + 32 * 2 + 1 + 1 + 1 + 8);
        assert_eq!(bytes[168], 0, "None encodes as a single zero byte");

        let with_proof = SettlementExecuted {
            proof: Some(Pubkey::new_from_array([7; 32])),
            ..event
        };
        assert_eq!(with_proof.try_to_vec().unwrap().len(), bytes.len() + 32);
    }

    #[test]
    fn proof_submitted_layout_is_pinned() {
        let event = ProofSubmitted {
            agreement: Pubkey::new_from_array([5; 32]),
            proof: Pubkey::new_from_array([8; 32]),
            creator: Pubkey::new_from_array([1; 32]),
            counterparty: Pubkey::new_from_array([2; 32]),
            submitter: Pubkey::new_from_array([2; 32]),
            proof_index: 0,
            content_hash: [7; 32],
            metadata_hash: [0; 32],
            agreement_state: AgreementState::Funded,
            timestamp: 1_700_000_150,
        };
        let bytes = event.try_to_vec().unwrap();
        assert_eq!(bytes.len(), 32 * 5 + 4 + 32 * 2 + 1 + 8);
        assert_eq!(&bytes[160..164], &0u32.to_le_bytes());
        assert_eq!(bytes[228], 1, "AgreementState::Funded");
    }

    #[test]
    fn proof_decision_layouts_are_pinned_and_identical() {
        let approved = ProofApproved {
            agreement: Pubkey::new_from_array([5; 32]),
            proof: Pubkey::new_from_array([8; 32]),
            creator: Pubkey::new_from_array([1; 32]),
            counterparty: Pubkey::new_from_array([2; 32]),
            submitter: Pubkey::new_from_array([2; 32]),
            decided_by: Pubkey::new_from_array([1; 32]),
            proof_index: 0,
            content_hash: [7; 32],
            agreement_state: AgreementState::Completed,
            timestamp: 1_700_000_250,
        };
        let rejected = ProofRejected {
            agreement: approved.agreement,
            proof: approved.proof,
            creator: approved.creator,
            counterparty: approved.counterparty,
            submitter: approved.submitter,
            decided_by: approved.decided_by,
            proof_index: approved.proof_index,
            content_hash: approved.content_hash,
            agreement_state: approved.agreement_state,
            timestamp: approved.timestamp,
        };

        let bytes = approved.try_to_vec().unwrap();
        assert_eq!(bytes.len(), 32 * 6 + 4 + 32 + 1 + 8);
        // The two decisions differ only in which event was emitted, so a
        // consumer never has to reconcile two shapes for one kind of fact.
        assert_eq!(bytes, rejected.try_to_vec().unwrap());
        assert_ne!(ProofApproved::DISCRIMINATOR, ProofRejected::DISCRIMINATOR);
    }

    #[test]
    fn creation_layout_is_pinned() {
        let event = AgreementCreated {
            agreement: Pubkey::new_from_array([5; 32]),
            agreement_id: 42,
            creator: Pubkey::new_from_array([1; 32]),
            counterparty: Pubkey::new_from_array([2; 32]),
            agreement_type: AgreementType::Escrow,
            mint: Pubkey::new_from_array([3; 32]),
            vault: Pubkey::new_from_array([4; 32]),
            amount: 100_000_000,
            terms_hash: [7; 32],
            new_state: AgreementState::Open,
            timestamp: 1_700_000_000,
        };
        let bytes = event.try_to_vec().unwrap();
        assert_eq!(bytes.len(), 32 + 8 + 32 * 2 + 1 + 32 * 2 + 8 + 32 + 1 + 8);
        assert_eq!(&bytes[32..40], &42u64.to_le_bytes());
        assert_eq!(bytes[104], 0, "AgreementType::Escrow is discriminant 0");
    }
}
