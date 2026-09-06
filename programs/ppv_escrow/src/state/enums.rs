use anchor_lang::prelude::*;

/// The composition model for everything PPV will build on the escrow kernel.
/// The wire format is fixed here so later phases add behaviour without moving
/// a discriminant; `initialize_agreement` accepts only the variants a phase has
/// actually implemented.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum AgreementType {
    Escrow,
    Invoice,
    Contract,
    MilestoneContract,
    Bounty,
    ProofOnly,
}

/// Custody lifecycle. Negotiation lifecycles (draft, proposed, countered,
/// accepted) live in `ppv_commerce` and are deliberately not folded into this
/// enum: one giant state machine spanning business and custody conditions is
/// how illegal transitions get smuggled in.
///
/// ```text
/// Open --fund()--> Funded --mark_completed()--> Completed --settle()--> Settled
/// ```
///
/// `Settled` is terminal. Dispute, refund, and cancellation states are appended
/// in later phases; borsh indices of the existing variants never move.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum AgreementState {
    Open,
    Funded,
    Completed,
    Settled,
}

impl AgreementState {
    /// A terminal state can never return to an active one (Invariant 16).
    pub fn is_terminal(&self) -> bool {
        matches!(self, AgreementState::Settled)
    }
}
