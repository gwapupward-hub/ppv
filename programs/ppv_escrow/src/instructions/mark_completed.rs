use anchor_lang::prelude::*;

use crate::constants::AGREEMENT_SEED;
use crate::events::WorkCompleted;
use crate::state::Agreement;

/// Completion moves no money. Keeping it separate from settlement is what
/// leaves room for approvals, proofs, dispute windows, and milestone
/// verification without rewriting the custody path.
#[event_cpi]
#[derive(Accounts)]
pub struct MarkCompleted<'info> {
    pub seller: Signer<'info>,
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

pub fn handle_mark_completed(ctx: Context<MarkCompleted>) -> Result<()> {
    let seller = ctx.accounts.seller.key();
    ctx.accounts.agreement.require_completable(&seller)?;

    let now = Clock::get()?.unix_timestamp;
    let agreement = &mut ctx.accounts.agreement;
    let previous_state = agreement.record_completed(now);

    emit_cpi!(WorkCompleted {
        agreement: agreement.key(),
        creator: agreement.creator,
        counterparty: agreement.counterparty,
        actor: seller,
        previous_state,
        new_state: agreement.state,
        timestamp: now,
    });

    Ok(())
}
