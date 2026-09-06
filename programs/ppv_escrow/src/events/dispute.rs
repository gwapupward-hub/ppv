use anchor_lang::prelude::*;

use crate::state::{AgreementState, DisputeOutcome};

/// `reason_hash` is a commitment to the complaint, not the complaint itself.
/// The text lives wherever the parties keep their evidence; the chain records
/// that a specific party objected to this agreement, to these bytes, at this
/// time — and that the normal settlement path stopped.
#[event]
pub struct DisputeOpened {
    pub agreement: Pubkey,
    pub creator: Pubkey,
    pub counterparty: Pubkey,
    pub opened_by: Pubkey,
    pub reason_hash: [u8; 32],
    pub previous_state: AgreementState,
    pub new_state: AgreementState,
    pub timestamp: i64,
}

/// How a dispute ended, and who conceded.
///
/// This event deliberately does *not* report a state transition, even though
/// resolving a dispute plainly moves the agreement. The transition is reported
/// by the `SettlementExecuted` or `RefundExecuted` emitted beside it, and if
/// both claimed to leave `Disputed`, a consumer rebuilding history would see
/// two transitions out of one state — a fork the program cannot produce. One
/// transition, one event; this one carries the reason and names the state the
/// agreement ended in.
#[event]
pub struct DisputeResolved {
    pub agreement: Pubkey,
    pub creator: Pubkey,
    pub counterparty: Pubkey,
    pub resolved_by: Pubkey,
    pub beneficiary: Pubkey,
    pub outcome: DisputeOutcome,
    pub opened_by: Pubkey,
    pub resulting_state: AgreementState,
    pub timestamp: i64,
}
