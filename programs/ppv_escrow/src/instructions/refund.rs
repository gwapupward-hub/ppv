use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::{AGREEMENT_SEED, VAULT_AUTHORITY_SEED, VAULT_TOKEN_SEED};
use crate::errors::EscrowError;
use crate::events::RefundExecuted;
use crate::instructions::custody::pay_out_of_vault;
use crate::state::Agreement;

/// A seller giving the money back.
///
/// Restricted to the seller because it is the seller's claim being surrendered.
/// A buyer who wants its money back over the seller's objection cannot take it
/// here — that is what `open_dispute` is for, and why the two are separate
/// instructions rather than one with a branch.
#[event_cpi]
#[derive(Accounts)]
pub struct Refund<'info> {
    pub seller: Signer<'info>,
    #[account(
        mut,
        seeds = [
            AGREEMENT_SEED,
            agreement.creator.as_ref(),
            &agreement.agreement_id.to_le_bytes()
        ],
        bump = agreement.bump,
        has_one = mint @ EscrowError::MintMismatch,
        has_one = vault @ EscrowError::CustodyMismatch,
    )]
    pub agreement: Account<'info, Agreement>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [VAULT_TOKEN_SEED, agreement.key().as_ref()],
        bump = agreement.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: PDA with no data; the seeds and the stored bump are the whole
    /// authorization, and it signs only this transfer.
    #[account(
        seeds = [VAULT_AUTHORITY_SEED, agreement.key().as_ref()],
        bump = agreement.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,
    /// A refund can only ever land in an account the buyer owns (Invariant 6).
    #[account(
        mut,
        constraint = buyer_token_account.mint == agreement.mint @ EscrowError::MintMismatch,
        constraint = buyer_token_account.owner == agreement.creator
            @ EscrowError::DestinationNotOwnedByBuyer,
    )]
    pub buyer_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_refund(ctx: Context<Refund>) -> Result<()> {
    let seller = ctx.accounts.seller.key();
    ctx.accounts.agreement.require_refundable(&seller)?;

    // Whatever is left. A milestone contract abandoned midway returns the
    // tranches nobody earned, not the whole original budget.
    let amount = ctx.accounts.agreement.remaining();
    let agreement_key = ctx.accounts.agreement.key();

    pay_out_of_vault(
        &ctx.accounts.token_program,
        &mut ctx.accounts.vault,
        &ctx.accounts.vault_authority,
        &ctx.accounts.mint,
        &mut ctx.accounts.buyer_token_account,
        &agreement_key,
        ctx.accounts.agreement.vault_authority_bump,
        amount,
    )?;

    let now = Clock::get()?.unix_timestamp;
    let destination = ctx.accounts.buyer_token_account.key();
    let agreement = &mut ctx.accounts.agreement;
    agreement.record_payout(amount)?;
    let previous_state = agreement.record_refunded(now);

    emit_cpi!(RefundExecuted {
        agreement: agreement.key(),
        buyer: agreement.creator,
        seller: agreement.counterparty,
        refunded_by: seller,
        amount,
        mint: agreement.mint,
        destination,
        previous_state,
        new_state: agreement.state,
        timestamp: now,
    });

    Ok(())
}
