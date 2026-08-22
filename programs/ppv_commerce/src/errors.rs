use anchor_lang::prelude::*;

#[error_code]
pub enum CommerceError {
    #[msg("Signer is not a party to this agreement")]
    NotAParty,
    #[msg("Counterparty must be a non-default wallet different from the creator")]
    InvalidParty,
    #[msg("Agreement is not in a valid state for this instruction")]
    BadState,
    #[msg("Agreement has expired")]
    Expired,
    #[msg("This party has already signed the current version")]
    AlreadySigned,
    #[msg("Instruction targets a stale agreement version")]
    StaleVersion,
    #[msg("Instruction targets a different content hash")]
    ContentHashMismatch,
    #[msg("Instruction targets a different terms hash")]
    TermsHashMismatch,
    #[msg("Content hash must not be all zeroes")]
    InvalidContentHash,
    #[msg("Terms hash must not be all zeroes")]
    InvalidTermsHash,
    #[msg("Revision must change the content hash or terms hash")]
    NoChanges,
    #[msg("Expiry must be in the future and within the maximum lifetime")]
    InvalidExpiry,
    #[msg("Arithmetic overflow")]
    Overflow,
}
