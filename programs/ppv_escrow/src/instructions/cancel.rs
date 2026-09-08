use anchor_lang::prelude::*;

use crate::constants::AGREEMENT_SEED;
use crate::events::AgreementAbandoned;
use crate::state::EscrowAgreement;

/// Abandoning an agreement nobody funded.
///
/// Cancellation and refund are deliberately different instructions with
/// different states. This one exists only for `Open`, where the vault is empty
/// by construction, so it takes no token accounts at all — there is nothing it
/// could move even if it were wrong. Once money is escrowed, giving it back is
/// a refund, and a refund has to move custody.
#[event_cpi]
#[derive(Accounts)]
pub struct Cancel<'info> {
    pub creator: Signer<'info>,
    #[account(
        mut,
        seeds = [
            AGREEMENT_SEED,
            agreement.creator.as_ref(),
            &agreement.agreement_id.to_le_bytes()
        ],
        bump = agreement.bump,
    )]
    pub agreement: Account<'info, EscrowAgreement>,
}

pub fn handle_cancel(ctx: Context<Cancel>) -> Result<()> {
    let creator = ctx.accounts.creator.key();
    ctx.accounts.agreement.require_cancellable(&creator)?;

    let now = Clock::get()?.unix_timestamp;
    let agreement = &mut ctx.accounts.agreement;
    let previous_state = agreement.record_cancelled(now);

    emit_cpi!(AgreementAbandoned {
        agreement: agreement.key(),
        creator: agreement.creator,
        counterparty: agreement.counterparty,
        cancelled_by: creator,
        previous_state,
        new_state: agreement.state,
        timestamp: now,
    });

    Ok(())
}
