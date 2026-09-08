use anchor_lang::prelude::*;

use crate::constants::AGREEMENT_SEED;
use crate::events::CounterpartyAssigned;
use crate::state::EscrowAgreement;

/// Naming the wallet a bounty will pay.
///
/// This is the one field of an agreement that is not fixed at creation, and the
/// exception is narrow on purpose. A bounty escrows *before* it knows who will
/// be paid — that is what lets applicants see the money exists before doing the
/// work — so the payee has to be assignable once, afterwards.
///
/// "Once" is the whole safety of it: `require_counterparty_assignable` refuses
/// an agreement that already has a payee, so from selection onward the
/// destination is as frozen as it is for every other agreement, and Invariant 5
/// holds unchanged. The sponsor can choose, and cannot re-choose after seeing
/// what a settlement would do.
#[event_cpi]
#[derive(Accounts)]
pub struct SelectCounterparty<'info> {
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

pub fn handle_select_counterparty(
    ctx: Context<SelectCounterparty>,
    counterparty: Pubkey,
) -> Result<()> {
    let creator = ctx.accounts.creator.key();
    ctx.accounts
        .agreement
        .require_counterparty_assignable(&creator)?;

    let now = Clock::get()?.unix_timestamp;
    let agreement = &mut ctx.accounts.agreement;
    agreement.record_counterparty(counterparty, now)?;

    emit_cpi!(CounterpartyAssigned {
        agreement: agreement.key(),
        creator,
        counterparty,
        agreement_state: agreement.state,
        timestamp: now,
    });

    Ok(())
}
