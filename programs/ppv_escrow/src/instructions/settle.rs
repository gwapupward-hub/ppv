use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::constants::{AGREEMENT_SEED, VAULT_AUTHORITY_SEED, VAULT_TOKEN_SEED};
use crate::errors::EscrowError;
use crate::events::SettlementExecuted;
use crate::state::Agreement;

#[event_cpi]
#[derive(Accounts)]
pub struct Settle<'info> {
    pub signer: Signer<'info>,
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
    /// CHECK: PDA with no data; the seeds constraint plus the stored bump are
    /// the whole authorization, and it signs only this transfer.
    #[account(
        seeds = [VAULT_AUTHORITY_SEED, agreement.key().as_ref()],
        bump = agreement.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,
    /// Settlement can only ever land in an account the seller owns, which is
    /// what makes it safe for either party to trigger.
    #[account(
        mut,
        constraint = seller_token_account.mint == agreement.mint @ EscrowError::MintMismatch,
        constraint = seller_token_account.owner == agreement.counterparty
            @ EscrowError::DestinationNotOwnedBySeller,
    )]
    pub seller_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_settle(ctx: Context<Settle>) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    ctx.accounts.agreement.require_settleable(&signer)?;

    let amount = ctx.accounts.agreement.amount;
    let agreement_key = ctx.accounts.agreement.key();
    let vault_before = ctx.accounts.vault.amount;
    let seller_before = ctx.accounts.seller_token_account.amount;

    let signer_seeds: &[&[&[u8]]] = &[&[
        VAULT_AUTHORITY_SEED,
        agreement_key.as_ref(),
        &[ctx.accounts.agreement.vault_authority_bump],
    ]];

    token::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.seller_token_account.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;

    // Assert both sides of the movement. A settlement event must describe a
    // transfer that actually happened, at the amount the agreement fixed.
    ctx.accounts.vault.reload()?;
    ctx.accounts.seller_token_account.reload()?;
    let debited = vault_before
        .checked_sub(ctx.accounts.vault.amount)
        .ok_or(EscrowError::CustodyMismatch)?;
    let credited = ctx
        .accounts
        .seller_token_account
        .amount
        .checked_sub(seller_before)
        .ok_or(EscrowError::CustodyMismatch)?;
    require_eq!(debited, amount, EscrowError::CustodyMismatch);
    require_eq!(credited, amount, EscrowError::CustodyMismatch);

    let now = Clock::get()?.unix_timestamp;
    let destination = ctx.accounts.seller_token_account.key();
    let agreement = &mut ctx.accounts.agreement;
    let previous_state = agreement.record_settled(now);

    emit_cpi!(SettlementExecuted {
        agreement: agreement.key(),
        buyer: agreement.creator,
        seller: agreement.counterparty,
        amount,
        mint: agreement.mint,
        destination,
        proof: None,
        previous_state,
        new_state: agreement.state,
        timestamp: now,
    });

    Ok(())
}
