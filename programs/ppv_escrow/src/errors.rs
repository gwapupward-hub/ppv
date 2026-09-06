use anchor_lang::prelude::*;

#[error_code]
pub enum EscrowError {
    #[msg("Counterparty must be a non-default wallet different from the creator")]
    InvalidCounterparty,
    #[msg("Escrow amount must be greater than zero")]
    InvalidAmount,
    #[msg("Terms hash must not be all zeroes")]
    InvalidTermsHash,
    #[msg("This agreement type is not implemented by the escrow kernel")]
    UnsupportedAgreementType,
    #[msg("Signer is not the buyer for this agreement")]
    NotTheBuyer,
    #[msg("Signer is not the seller for this agreement")]
    NotTheSeller,
    #[msg("Signer is not a party to this agreement")]
    NotAParty,
    #[msg("Agreement is not in a valid state for this instruction")]
    BadState,
    #[msg("Account does not use the agreement mint")]
    MintMismatch,
    #[msg("Funding source is not owned by the buyer")]
    SourceNotOwnedByBuyer,
    #[msg("Settlement destination is not owned by the seller")]
    DestinationNotOwnedBySeller,
    #[msg("Custody did not move by exactly the agreement amount")]
    CustodyMismatch,
    #[msg("Proof content hash must not be all zeroes")]
    InvalidContentHash,
    #[msg("Proof does not belong to this agreement")]
    ProofAgreementMismatch,
    #[msg("A party cannot decide its own proof")]
    CannotDecideOwnProof,
    #[msg("Proof has already been approved or rejected")]
    ProofAlreadyDecided,
    #[msg("Settlement can only cite an approved proof")]
    ProofNotApproved,
    #[msg("Vault address already holds data")]
    VaultAlreadyInitialized,
    #[msg("Arithmetic overflow")]
    Overflow,
}
