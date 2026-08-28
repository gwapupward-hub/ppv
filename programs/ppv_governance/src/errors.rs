use anchor_lang::prelude::*;

#[error_code]
pub enum GovernanceError {
    #[msg("Governance requires between 2 and 8 unique members")]
    InvalidMemberCount,
    #[msg("Governance members cannot use the default public key")]
    DefaultMember,
    #[msg("Governance members must be unique")]
    DuplicateMember,
    #[msg("Threshold must be at least 2 and no greater than the member count")]
    InvalidThreshold,
    #[msg("Proposal lifetime must be greater than the configured execution delay")]
    InvalidProposalLifetime,
    #[msg("Treasury/spill destination cannot be the default public key")]
    InvalidTreasury,
    #[msg("Governance may only be initialized by the program's current upgrade authority")]
    UnauthorizedBootstrap,
    #[msg("Signer is not a governance member")]
    UnauthorizedMember,
    #[msg("Proposal id must equal governance.next_proposal_id")]
    InvalidProposalId,
    #[msg("This member already approved the proposal")]
    AlreadyApproved,
    #[msg("Proposal is already executed or cancelled")]
    ProposalNotActive,
    #[msg("Proposal has expired")]
    ProposalExpired,
    #[msg("Proposal belongs to a stale governance epoch")]
    StaleGovernanceEpoch,
    #[msg("The execution delay has not elapsed")]
    TimelockNotElapsed,
    #[msg("The proposal has not reached the approval threshold")]
    ThresholdNotMet,
    #[msg("Only the proposal creator may cancel this proposal")]
    UnauthorizedCancellation,
    #[msg("Proposal action does not match this execution instruction")]
    WrongProposalAction,
    #[msg("Target program does not match the approved proposal")]
    WrongTargetProgram,
    #[msg("Program buffer does not match the approved proposal")]
    WrongBuffer,
    #[msg("ProgramData account does not match the target program")]
    WrongProgramData,
    #[msg("Target program, ProgramData, or buffer is not owned by the upgradeable loader")]
    WrongLoaderOwner,
    #[msg("Spill destination does not match the configured governance treasury")]
    WrongSpillDestination,
    #[msg("Governance vault does not match the configured PDA")]
    WrongVault,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
}
