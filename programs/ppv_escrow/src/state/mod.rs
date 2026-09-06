pub mod agreement;
pub mod enums;
pub mod proof;

pub use agreement::*;
pub use enums::*;
pub use proof::*;

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::prelude::*;

    /// Pinned so a field added without widening the account is caught here
    /// rather than by a failing `init` on chain. The SDK asserts the same
    /// number, plus the 8-byte discriminator, in escrow-accounts.test.ts.
    #[test]
    fn agreement_account_space_is_pinned() {
        let expected = 4          // schema version + three bumps
            + 32 * 2              // creator + counterparty
            + 8                   // agreement id
            + 1                   // agreement type
            + 32 * 2              // mint + vault
            + 8                   // amount
            + 32                  // terms hash
            + 1                   // state
            + 8 * 4               // created / funded / completed / settled
            + 4                   // proof count
            + 32                  // settlement proof
            + 28; // reserved
        assert_eq!(Agreement::INIT_SPACE, expected);
        assert_eq!(
            expected, 278,
            "spending reserved bytes must not resize the account"
        );
    }

    #[test]
    fn proof_account_space_is_pinned() {
        let expected = 2          // schema version + bump
            + 32 * 2              // agreement + submitter
            + 4                   // proof index
            + 32 * 2              // content + metadata hash
            + 1                   // status
            + 8 * 2               // created + decided
            + 32                  // decided by
            + 32; // reserved
        assert_eq!(Proof::INIT_SPACE, expected);
        assert_eq!(expected, 215);
    }

    #[test]
    fn proof_status_discriminants_are_pinned() {
        assert_eq!(ProofStatus::Submitted.try_to_vec().unwrap(), vec![0]);
        assert_eq!(ProofStatus::Approved.try_to_vec().unwrap(), vec![1]);
        assert_eq!(ProofStatus::Rejected.try_to_vec().unwrap(), vec![2]);
    }

    #[test]
    fn state_and_type_discriminants_are_pinned() {
        assert_eq!(AgreementState::Open.try_to_vec().unwrap(), vec![0]);
        assert_eq!(AgreementState::Funded.try_to_vec().unwrap(), vec![1]);
        assert_eq!(AgreementState::Completed.try_to_vec().unwrap(), vec![2]);
        assert_eq!(AgreementState::Settled.try_to_vec().unwrap(), vec![3]);

        assert_eq!(AgreementType::Escrow.try_to_vec().unwrap(), vec![0]);
        assert_eq!(AgreementType::Invoice.try_to_vec().unwrap(), vec![1]);
        assert_eq!(AgreementType::Contract.try_to_vec().unwrap(), vec![2]);
        assert_eq!(
            AgreementType::MilestoneContract.try_to_vec().unwrap(),
            vec![3]
        );
        assert_eq!(AgreementType::Bounty.try_to_vec().unwrap(), vec![4]);
        assert_eq!(AgreementType::ProofOnly.try_to_vec().unwrap(), vec![5]);
    }

    #[test]
    fn only_settled_is_terminal() {
        assert!(AgreementState::Settled.is_terminal());
        for state in [
            AgreementState::Open,
            AgreementState::Funded,
            AgreementState::Completed,
        ] {
            assert!(!state.is_terminal());
        }
    }
}
