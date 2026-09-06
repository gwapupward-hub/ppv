use anchor_lang::prelude::*;

use crate::constants::AGREEMENT_SEED;
use crate::errors::EscrowError;
use crate::events::DisputeOpened;
use crate::state::Agreement;

/// Halting the normal path.
///
/// Opening a dispute moves no money. What it does is take the agreement out of
/// `Completed`, and `settle` demands `Completed` — so Invariant 9 is not an
/// extra check anyone has to remember to write, it is the state machine.
#[event_cpi]
#[derive(Accounts)]
pub struct OpenDispute<'info> {
    pub party: Signer<'info>,
    #[account(
        mut,
        seeds = [
            AGREEMENT_SEED,
            agreement.creator.as_ref(),
            &agreement.agreement_id.to_le_bytes()
        ],
        bump = agreement.bump,
    )]
    pub agreement: Account<'info, Agreement>,
}

pub fn handle_open_dispute(ctx: Context<OpenDispute>, reason_hash: [u8; 32]) -> Result<()> {
    let party = ctx.accounts.party.key();
    ctx.accounts.agreement.require_disputable(&party)?;
    require!(
        reason_hash.iter().any(|byte| *byte != 0),
        EscrowError::InvalidContentHash
    );

    let now = Clock::get()?.unix_timestamp;
    let agreement = &mut ctx.accounts.agreement;
    let previous_state = agreement.record_disputed(party, now);

    emit_cpi!(DisputeOpened {
        agreement: agreement.key(),
        creator: agreement.creator,
        counterparty: agreement.counterparty,
        opened_by: party,
        reason_hash,
        previous_state,
        new_state: agreement.state,
        timestamp: now,
    });

    Ok(())
}
