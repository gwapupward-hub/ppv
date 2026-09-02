use crate::state::ProofKind;
use anchor_lang::prelude::*;

#[event]
pub struct ProofCreated {
    pub proof: Pubkey,
    pub authority: Pubkey,
    pub proof_id: [u8; 16],
    pub content_hash: [u8; 32],
    pub context_hash: [u8; 32],
    pub kind: ProofKind,
    pub created_at: i64,
}

#[event]
pub struct ProofRevoked {
    pub proof: Pubkey,
    pub authority: Pubkey,
    pub proof_id: [u8; 16],
    pub content_hash: [u8; 32],
    pub kind: ProofKind,
    pub revoked_at: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::hash::hash;
    use anchor_lang::Discriminator;

    // The off-chain SDK decodes these events by discriminator. Pinning them
    // here means a renamed event fails this crate's tests, not a downstream
    // indexer at runtime.
    fn expected(name: &str) -> [u8; 8] {
        let digest = hash(format!("event:{name}").as_bytes()).to_bytes();
        let mut out = [0u8; 8];
        out.copy_from_slice(&digest[..8]);
        out
    }

    #[test]
    fn event_discriminators_are_pinned() {
        assert_eq!(ProofCreated::DISCRIMINATOR, expected("ProofCreated"));
        assert_eq!(ProofRevoked::DISCRIMINATOR, expected("ProofRevoked"));
    }

    // Byte-exact layout vector shared with sdk/test/reputation-chain-events.test.ts.
    #[test]
    fn proof_created_layout_is_pinned() {
        let event = ProofCreated {
            proof: Pubkey::new_from_array([1; 32]),
            authority: Pubkey::new_from_array([2; 32]),
            proof_id: [3; 16],
            content_hash: [4; 32],
            context_hash: [5; 32],
            kind: ProofKind::Deliverable,
            created_at: 1_700_000_000,
        };
        let bytes = event.try_to_vec().unwrap();
        assert_eq!(bytes.len(), 32 + 32 + 16 + 32 + 32 + 1 + 8);
        assert_eq!(bytes[144], 4, "ProofKind::Deliverable serializes as 4");
        assert_eq!(&bytes[145..], &1_700_000_000i64.to_le_bytes());
    }

    #[test]
    fn proof_revoked_layout_is_pinned() {
        let event = ProofRevoked {
            proof: Pubkey::new_from_array([1; 32]),
            authority: Pubkey::new_from_array([2; 32]),
            proof_id: [3; 16],
            content_hash: [4; 32],
            kind: ProofKind::Document,
            revoked_at: 1_700_000_001,
        };
        let bytes = event.try_to_vec().unwrap();
        assert_eq!(bytes.len(), 32 + 32 + 16 + 32 + 1 + 8);
        assert_eq!(bytes[112], 1, "ProofKind::Document serializes as 1");
    }
}
