use anchor_lang::prelude::*;

#[error_code]
pub enum PpvCoreError {
    #[msg("Protocol is paused for new proof creation")]
    Paused,
    #[msg("Signer is not authorized for this instruction")]
    NotAuthorized,
    #[msg("Only the proof owner may revoke this proof")]
    NotProofOwner,
    #[msg("Proof is already revoked")]
    AlreadyRevoked,
    #[msg("Proof kind is outside the supported range")]
    BadProofKind,
    #[msg("Pending admin does not match signer")]
    NoPendingAdmin,
    #[msg("New admin must differ from current admin and cannot be the zero address")]
    InvalidAdmin,
}
