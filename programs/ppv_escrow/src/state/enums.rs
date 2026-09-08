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
///                    Open ──cancel()──> Cancelled
///                      │ fund()
///                      ▼
///        ┌────────── Funded ──────────┐
///        │ mark_completed()           │ open_dispute() / refund()
///        ▼                            ▼
///    Completed ─open_dispute()─> Disputed ─resolve_dispute()─> Settled
///        │ settle()                   └──────────────────────> Refunded
///        ▼
///     Settled
/// ```
///
/// The four original variants keep their borsh indices; Phase 5 appended the
/// three terminal ones after them, so anything already decoding this enum reads
/// the same bytes for the same states.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum AgreementState {
    Open,
    Funded,
    Completed,
    Settled,
    Cancelled,
    Disputed,
    Refunded,
}

impl AgreementState {
    /// A terminal state can never return to an active one (Invariant 16).
    /// Every way an agreement can end is terminal: paid, refunded, or
    /// abandoned before any money was involved.
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            AgreementState::Settled | AgreementState::Cancelled | AgreementState::Refunded
        )
    }
}

/// How a dispute ended. Phase 5 resolves disputes by concession only — the
/// party who would lose signs away its own claim — so the outcome is always one
/// side whole and never a split. Percentage splits and third-party arbiters are
/// Phase 13, behind the arbiter policy gate.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum DisputeOutcome {
    SellerPaid,
    BuyerRefunded,
}

/// One milestone's lifecycle, a child machine of the agreement's.
///
/// ```text
/// Pending ─submit_milestone()─> Submitted ─approve_milestone()─> Approved ─settle_milestone()─> Settled
///    ▲                              │
///    └────reject_milestone()────────┘
/// ```
///
/// There is no `Funded` here, and that is a deliberate departure from a
/// per-milestone funding model: the whole budget is escrowed once, up front, and
/// milestones release tranches of it. A buyer therefore knows exactly what it is
/// funding before any money moves, and a seller knows the money for every
/// milestone is already in the vault. Partial funding would mean a seller can
/// finish work the buyer never escrowed for.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum MilestoneState {
    Pending,
    Submitted,
    Approved,
    Settled,
}
