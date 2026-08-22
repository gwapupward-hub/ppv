use anchor_lang::prelude::*;

#[error_code]
pub enum CoreError {
    #[msg("Content hash must not be all zeroes")]
    InvalidContentHash,
    #[msg("Signer is not the proof authority")]
    Unauthorized,
    #[msg("Proof is already revoked")]
    AlreadyRevoked,
}
