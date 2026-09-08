use anchor_lang::prelude::*;

use crate::state::{AgreementState, AgreementType};

// Every event carries both parties, the mint, and the exact state transition it
// committed, so an indexer can attribute and order it without reading the
// account it describes. Names are protocol facts, never UI vocabulary and never
// judgements: PPV records what happened, GwapScore decides what it means.

#[event]
pub struct AgreementOpened {
    pub agreement: Pubkey,
    pub agreement_id: u64,
    pub creator: Pubkey,
    pub counterparty: Pubkey,
    pub agreement_type: AgreementType,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub amount: u64,
    pub terms_hash: [u8; 32],
    pub new_state: AgreementState,
    pub timestamp: i64,
}

#[event]
pub struct AgreementFunded {
    pub agreement: Pubkey,
    pub creator: Pubkey,
    pub counterparty: Pubkey,
    pub amount: u64,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub previous_state: AgreementState,
    pub new_state: AgreementState,
    pub timestamp: i64,
}

#[event]
pub struct WorkCompleted {
    pub agreement: Pubkey,
    pub creator: Pubkey,
    pub counterparty: Pubkey,
    pub actor: Pubkey,
    pub previous_state: AgreementState,
    pub new_state: AgreementState,
    pub timestamp: i64,
}

/// An agreement abandoned before it was ever funded. There is no custody event
/// beside it because there was no custody.
#[event]
pub struct AgreementAbandoned {
    pub agreement: Pubkey,
    pub creator: Pubkey,
    pub counterparty: Pubkey,
    pub cancelled_by: Pubkey,
    pub previous_state: AgreementState,
    pub new_state: AgreementState,
    pub timestamp: i64,
}

/// A bounty's payee, named after the fact. Emitted once per agreement at most:
/// the field cannot be reassigned, so this event cannot repeat.
#[event]
pub struct CounterpartyAssigned {
    pub agreement: Pubkey,
    pub creator: Pubkey,
    pub counterparty: Pubkey,
    pub agreement_state: AgreementState,
    pub timestamp: i64,
}
