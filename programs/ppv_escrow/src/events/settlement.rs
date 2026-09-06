use anchor_lang::prelude::*;

use crate::state::AgreementState;

/// `proof` is always `None` in the escrow kernel: the proof vault arrives in
/// Phase 3. The field is present from the first release so adding proofs later
/// does not move a byte of this layout for existing indexers.
#[event]
pub struct SettlementExecuted {
    pub agreement: Pubkey,
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub amount: u64,
    pub mint: Pubkey,
    pub destination: Pubkey,
    pub proof: Option<Pubkey>,
    pub previous_state: AgreementState,
    pub new_state: AgreementState,
    pub timestamp: i64,
}
