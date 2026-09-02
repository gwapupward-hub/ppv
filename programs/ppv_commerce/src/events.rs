use anchor_lang::prelude::*;

#[event]
pub struct AgreementCreated {
    pub agreement: Pubkey,
    pub agreement_id: [u8; 16],
    pub party_a: Pubkey,
    pub party_b: Pubkey,
    pub version: u32,
    pub content_hash: [u8; 32],
    pub terms_hash: [u8; 32],
    pub expires_at: i64,
    pub created_at: i64,
}

// Every event names both parties so an off-chain consumer can attribute it
// without reading the account: webhook delivery is at-least-once and unordered,
// and a stateless normalizer is what keeps replay and reordering harmless.

#[event]
pub struct AgreementRevised {
    pub agreement: Pubkey,
    pub party_a: Pubkey,
    pub party_b: Pubkey,
    pub proposer: Pubkey,
    pub previous_version: u32,
    pub new_version: u32,
    pub content_hash: [u8; 32],
    pub terms_hash: [u8; 32],
    pub signatures_cleared: bool,
    pub revised_at: i64,
}

#[event]
pub struct AgreementSigned {
    pub agreement: Pubkey,
    pub party_a: Pubkey,
    pub party_b: Pubkey,
    pub signer: Pubkey,
    pub version: u32,
    pub content_hash: [u8; 32],
    pub terms_hash: [u8; 32],
    pub signed_at: i64,
}

#[event]
pub struct AgreementExecuted {
    pub agreement: Pubkey,
    pub party_a: Pubkey,
    pub party_b: Pubkey,
    pub version: u32,
    pub content_hash: [u8; 32],
    pub terms_hash: [u8; 32],
    pub executed_at: i64,
}

#[event]
pub struct AgreementCancelled {
    pub agreement: Pubkey,
    pub party_a: Pubkey,
    pub party_b: Pubkey,
    pub cancelled_by: Pubkey,
    pub version: u32,
    pub cancelled_at: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
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
        assert_eq!(
            AgreementRevised::DISCRIMINATOR,
            expected("AgreementRevised")
        );
        assert_eq!(AgreementSigned::DISCRIMINATOR, expected("AgreementSigned"));
        assert_eq!(
            AgreementExecuted::DISCRIMINATOR,
            expected("AgreementExecuted")
        );
        assert_eq!(
            AgreementCancelled::DISCRIMINATOR,
            expected("AgreementCancelled")
        );
    }

    // Byte-exact layout vectors shared with sdk/test/reputation-chain-events.test.ts.
    #[test]
    fn agreement_executed_layout_is_pinned() {
        let event = AgreementExecuted {
            agreement: Pubkey::new_from_array([9; 32]),
            party_a: Pubkey::new_from_array([1; 32]),
            party_b: Pubkey::new_from_array([2; 32]),
            version: 3,
            content_hash: [4; 32],
            terms_hash: [5; 32],
            executed_at: 1_700_000_002,
        };
        let bytes = event.try_to_vec().unwrap();
        assert_eq!(bytes.len(), 32 * 3 + 4 + 32 * 2 + 8);
        assert_eq!(&bytes[96..100], &3u32.to_le_bytes());
    }

    #[test]
    fn agreement_signed_names_both_parties_before_the_signer() {
        let event = AgreementSigned {
            agreement: Pubkey::new_from_array([9; 32]),
            party_a: Pubkey::new_from_array([1; 32]),
            party_b: Pubkey::new_from_array([2; 32]),
            signer: Pubkey::new_from_array([2; 32]),
            version: 1,
            content_hash: [4; 32],
            terms_hash: [5; 32],
            signed_at: 1_700_000_003,
        };
        let bytes = event.try_to_vec().unwrap();
        assert_eq!(bytes.len(), 32 * 4 + 4 + 32 * 2 + 8);
        assert_eq!(&bytes[32..64], &[1u8; 32]);
        assert_eq!(&bytes[64..96], &[2u8; 32]);
        assert_eq!(&bytes[96..128], &[2u8; 32]);
    }

    #[test]
    fn agreement_cancelled_layout_is_pinned() {
        let event = AgreementCancelled {
            agreement: Pubkey::new_from_array([9; 32]),
            party_a: Pubkey::new_from_array([1; 32]),
            party_b: Pubkey::new_from_array([2; 32]),
            cancelled_by: Pubkey::new_from_array([1; 32]),
            version: 2,
            cancelled_at: 1_700_000_004,
        };
        let bytes = event.try_to_vec().unwrap();
        assert_eq!(bytes.len(), 32 * 4 + 4 + 8);
    }
}
