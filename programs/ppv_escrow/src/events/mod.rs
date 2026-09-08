pub mod agreement;
pub mod dispute;
pub mod milestone;
pub mod proof;
pub mod settlement;

pub use agreement::*;
pub use dispute::*;
pub use milestone::*;
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
        assert_eq!(AgreementOpened::DISCRIMINATOR, expected("AgreementOpened"));
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
            AgreementAbandoned::DISCRIMINATOR,
            expected("AgreementAbandoned")
        );
        assert_eq!(DisputeOpened::DISCRIMINATOR, expected("DisputeOpened"));
        assert_eq!(DisputeResolved::DISCRIMINATOR, expected("DisputeResolved"));
        assert_eq!(RefundExecuted::DISCRIMINATOR, expected("RefundExecuted"));
        assert_eq!(
            MilestoneCreated::DISCRIMINATOR,
            expected("MilestoneCreated")
        );
        assert_eq!(
            MilestoneSubmitted::DISCRIMINATOR,
            expected("MilestoneSubmitted")
        );
        assert_eq!(
            MilestoneApproved::DISCRIMINATOR,
            expected("MilestoneApproved")
        );
        assert_eq!(
            MilestoneRejected::DISCRIMINATOR,
            expected("MilestoneRejected")
        );
        assert_eq!(
            MilestoneSettled::DISCRIMINATOR,
            expected("MilestoneSettled")
        );
    }

    // Anchor derives an event discriminator from the name alone, so two PPV
    // programs sharing an event name emit byte-identical prefixes over
    // incompatible bodies — a decoder keying on the prefix does not merely
    // misattribute the event, it mis-deserializes it.
    //
    // `ppv_commerce` emitted `AgreementCreated` and `AgreementCancelled`, and
    // so did this program. `ppv_commerce` carries a permanent identity and is
    // frozen for its first deployment, so the escrow kernel is the side that
    // moved: nothing is deployed here, and the rename costs nothing.
    //
    // Program-scoped decoding is still how an indexer must read events, and
    // `decodeEventForProgram` still enforces it — a collision-free protocol is
    // a defence in depth, not a reason to key on the discriminator alone.
    // `scripts/test/discriminators.test.mjs` checks all three programs at once;
    // these two assertions pin the specific names that were wrong.
    #[test]
    fn the_renamed_events_no_longer_collide_with_ppv_commerce() {
        assert_ne!(AgreementOpened::DISCRIMINATOR, expected("AgreementCreated"));
        assert_ne!(
            AgreementAbandoned::DISCRIMINATOR,
            expected("AgreementCancelled")
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
            core_proof: Pubkey::new_from_array([9; 32]),
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
        assert_eq!(bytes.len(), 32 * 6 + 4 + 32 * 2 + 1 + 8);
        assert_eq!(&bytes[64..96], &[9u8; 32], "core_proof follows proof");
        assert_eq!(&bytes[192..196], &0u32.to_le_bytes());
        assert_eq!(bytes[260], 1, "AgreementState::Funded");
    }

    #[test]
    fn proof_decision_layouts_are_pinned_and_identical() {
        let approved = ProofApproved {
            agreement: Pubkey::new_from_array([5; 32]),
            proof: Pubkey::new_from_array([8; 32]),
            core_proof: Pubkey::new_from_array([9; 32]),
            creator: Pubkey::new_from_array([1; 32]),
            counterparty: Pubkey::new_from_array([2; 32]),
            submitter: Pubkey::new_from_array([2; 32]),
            decided_by: Pubkey::new_from_array([1; 32]),
            proof_index: 0,
            agreement_state: AgreementState::Completed,
            timestamp: 1_700_000_250,
        };
        let rejected = ProofRejected {
            agreement: approved.agreement,
            proof: approved.proof,
            core_proof: approved.core_proof,
            creator: approved.creator,
            counterparty: approved.counterparty,
            submitter: approved.submitter,
            decided_by: approved.decided_by,
            proof_index: approved.proof_index,
            agreement_state: approved.agreement_state,
            timestamp: approved.timestamp,
        };

        let bytes = approved.try_to_vec().unwrap();
        assert_eq!(bytes.len(), 32 * 7 + 4 + 1 + 8);
        // The two decisions differ only in which event was emitted, so a
        // consumer never has to reconcile two shapes for one kind of fact.
        assert_eq!(bytes, rejected.try_to_vec().unwrap());
        assert_ne!(ProofApproved::DISCRIMINATOR, ProofRejected::DISCRIMINATOR);
    }

    #[test]
    fn creation_layout_is_pinned() {
        let event = AgreementOpened {
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
