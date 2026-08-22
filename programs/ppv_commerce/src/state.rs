use crate::errors::CommerceError;
use anchor_lang::prelude::*;

pub const AGREEMENT_SCHEMA_VERSION: u8 = 1;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum AgreementState {
    Pending,
    Executed,
    Cancelled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, InitSpace)]
pub struct SignatureRecord {
    pub signer: Pubkey,
    pub version_signed: u32,
    pub content_hash_signed: [u8; 32],
    pub terms_hash_signed: [u8; 32],
    pub signed_at: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Agreement {
    pub schema_version: u8,
    pub bump: u8,
    pub agreement_id: [u8; 16],
    pub party_a: Pubkey,
    pub party_b: Pubkey,
    pub version: u32,
    pub content_hash: [u8; 32],
    pub terms_hash: [u8; 32],
    pub sig_a: Option<SignatureRecord>,
    pub sig_b: Option<SignatureRecord>,
    pub state: AgreementState,
    pub created_at: i64,
    pub expires_at: i64,
    pub executed_at: i64,
    pub cancelled_at: i64,
    /// Reserved account space for compatible schema evolution.
    pub reserved: [u8; 64],
}

impl Agreement {
    pub fn is_party(&self, signer: &Pubkey) -> bool {
        *signer == self.party_a || *signer == self.party_b
    }

    fn require_party(&self, signer: &Pubkey) -> Result<()> {
        require!(self.is_party(signer), CommerceError::NotAParty);
        Ok(())
    }

    fn require_pending_and_unexpired(&self, now: i64) -> Result<()> {
        require!(
            self.state == AgreementState::Pending,
            CommerceError::BadState
        );
        require!(now < self.expires_at, CommerceError::Expired);
        Ok(())
    }

    pub fn revise(
        &mut self,
        signer: Pubkey,
        expected_version: u32,
        new_content_hash: [u8; 32],
        new_terms_hash: [u8; 32],
        now: i64,
    ) -> Result<u32> {
        self.require_party(&signer)?;
        self.require_pending_and_unexpired(now)?;
        require!(
            expected_version == self.version,
            CommerceError::StaleVersion
        );
        require!(
            new_content_hash.iter().any(|byte| *byte != 0),
            CommerceError::InvalidContentHash
        );
        require!(
            new_terms_hash.iter().any(|byte| *byte != 0),
            CommerceError::InvalidTermsHash
        );
        require!(
            new_content_hash != self.content_hash || new_terms_hash != self.terms_hash,
            CommerceError::NoChanges
        );

        let previous_version = self.version;
        self.version = self.version.checked_add(1).ok_or(CommerceError::Overflow)?;
        self.content_hash = new_content_hash;
        self.terms_hash = new_terms_hash;
        self.sig_a = None;
        self.sig_b = None;
        Ok(previous_version)
    }

    pub fn sign(
        &mut self,
        signer: Pubkey,
        expected_version: u32,
        expected_content_hash: [u8; 32],
        expected_terms_hash: [u8; 32],
        now: i64,
    ) -> Result<bool> {
        self.require_party(&signer)?;
        self.require_pending_and_unexpired(now)?;
        require!(
            expected_version == self.version,
            CommerceError::StaleVersion
        );
        require!(
            expected_content_hash == self.content_hash,
            CommerceError::ContentHashMismatch
        );
        require!(
            expected_terms_hash == self.terms_hash,
            CommerceError::TermsHashMismatch
        );

        let signature = SignatureRecord {
            signer,
            version_signed: expected_version,
            content_hash_signed: expected_content_hash,
            terms_hash_signed: expected_terms_hash,
            signed_at: now,
        };

        if signer == self.party_a {
            require!(self.sig_a.is_none(), CommerceError::AlreadySigned);
            self.sig_a = Some(signature);
        } else {
            require!(self.sig_b.is_none(), CommerceError::AlreadySigned);
            self.sig_b = Some(signature);
        }

        let executed = self.sig_a.is_some() && self.sig_b.is_some();
        if executed {
            self.state = AgreementState::Executed;
            self.executed_at = now;
        }
        Ok(executed)
    }

    pub fn cancel(&mut self, signer: Pubkey, now: i64) -> Result<()> {
        self.require_party(&signer)?;
        require!(
            self.state == AgreementState::Pending,
            CommerceError::BadState
        );
        self.state = AgreementState::Cancelled;
        self.cancelled_at = now;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONTENT_V1: [u8; 32] = [1; 32];
    const TERMS_V1: [u8; 32] = [2; 32];
    const CONTENT_V2: [u8; 32] = [3; 32];
    const TERMS_V2: [u8; 32] = [4; 32];

    fn pending(a: Pubkey, b: Pubkey) -> Agreement {
        Agreement {
            schema_version: AGREEMENT_SCHEMA_VERSION,
            bump: 255,
            agreement_id: [7; 16],
            party_a: a,
            party_b: b,
            version: 1,
            content_hash: CONTENT_V1,
            terms_hash: TERMS_V1,
            sig_a: None,
            sig_b: None,
            state: AgreementState::Pending,
            created_at: 10,
            expires_at: 1_000,
            executed_at: 0,
            cancelled_at: 0,
            reserved: [0; 64],
        }
    }

    #[test]
    fn revision_clears_every_signature() {
        let a = Pubkey::new_unique();
        let b = Pubkey::new_unique();
        let mut agreement = pending(a, b);
        agreement.sign(a, 1, CONTENT_V1, TERMS_V1, 20).unwrap();
        assert!(agreement.sig_a.is_some());

        let previous = agreement.revise(b, 1, CONTENT_V2, TERMS_V2, 30).unwrap();
        assert_eq!(previous, 1);
        assert_eq!(agreement.version, 2);
        assert!(agreement.sig_a.is_none());
        assert!(agreement.sig_b.is_none());
    }

    #[test]
    fn optimistic_version_lock_rejects_lost_update() {
        let a = Pubkey::new_unique();
        let b = Pubkey::new_unique();
        let mut agreement = pending(a, b);
        agreement.revise(a, 1, CONTENT_V2, TERMS_V2, 20).unwrap();
        assert!(agreement.revise(b, 1, [5; 32], [6; 32], 30).is_err());
        assert_eq!(agreement.version, 2);
        assert_eq!(agreement.content_hash, CONTENT_V2);
    }

    #[test]
    fn signature_binds_content_and_machine_terms() {
        let a = Pubkey::new_unique();
        let b = Pubkey::new_unique();
        let mut agreement = pending(a, b);
        assert!(agreement.sign(a, 1, CONTENT_V1, TERMS_V2, 20).is_err());
        assert!(agreement.sig_a.is_none());
    }

    #[test]
    fn execution_requires_both_current_signatures() {
        let a = Pubkey::new_unique();
        let b = Pubkey::new_unique();
        let mut agreement = pending(a, b);
        assert!(!agreement.sign(a, 1, CONTENT_V1, TERMS_V1, 20).unwrap());
        assert!(agreement.sign(b, 1, CONTENT_V1, TERMS_V1, 21).unwrap());
        assert_eq!(agreement.state, AgreementState::Executed);
        assert_eq!(agreement.executed_at, 21);
        assert!(agreement.revise(a, 1, CONTENT_V2, TERMS_V2, 30).is_err());
    }

    #[test]
    fn outsider_cannot_sign_or_cancel() {
        let a = Pubkey::new_unique();
        let b = Pubkey::new_unique();
        let outsider = Pubkey::new_unique();
        let mut agreement = pending(a, b);
        assert!(agreement
            .sign(outsider, 1, CONTENT_V1, TERMS_V1, 20)
            .is_err());
        assert!(agreement.cancel(outsider, 20).is_err());
        assert_eq!(agreement.state, AgreementState::Pending);
    }

    #[test]
    fn expired_agreement_cannot_be_signed_or_revised() {
        let a = Pubkey::new_unique();
        let b = Pubkey::new_unique();
        let mut agreement = pending(a, b);
        assert!(agreement.sign(a, 1, CONTENT_V1, TERMS_V1, 1_000).is_err());
        assert!(agreement.revise(a, 1, CONTENT_V2, TERMS_V2, 1_000).is_err());
    }
}
