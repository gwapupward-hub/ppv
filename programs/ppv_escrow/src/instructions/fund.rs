use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::constants::{AGREEMENT_SEED, VAULT_TOKEN_SEED};
use crate::errors::EscrowError;
use crate::events::AgreementFunded;
use crate::state::Agreement;

#[event_cpi]
#[derive(Accounts)]
pub struct Fund<'info> {
    pub buyer: Signer<'info>,
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
    /// The canonical vault. Re-deriving it from the agreement address makes a
    /// substituted vault a seeds failure rather than a balance surprise.
    #[account(
        mut,
        seeds = [VAULT_TOKEN_SEED, agreement.key().as_ref()],
        bump = agreement.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = funder_token_account.mint == agreement.mint @ EscrowError::MintMismatch,
        constraint = funder_token_account.owner == buyer.key() @ EscrowError::SourceNotOwnedByBuyer,
    )]
    pub funder_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_fund(ctx: Context<Fund>) -> Result<()> {
    let buyer = ctx.accounts.buyer.key();
    ctx.accounts.agreement.require_fundable(&buyer)?;

    let amount = ctx.accounts.agreement.amount;
    let balance_before = ctx.accounts.vault.amount;

    // Custody first. `transfer_checked` re-validates the mint and decimals
    // inside the token program, so a mint substituted between our constraint
    // and the transfer cannot silently move a different asset.
    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.funder_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.buyer.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;

    // A token balance is not protocol state, so the transition is recorded only
    // after the vault is re-read and the movement is exactly what was agreed.
    ctx.accounts.vault.reload()?;
    let credited = ctx
        .accounts
        .vault
        .amount
        .checked_sub(balance_before)
        .ok_or(EscrowError::CustodyMismatch)?;
    require_eq!(credited, amount, EscrowError::CustodyMismatch);

    let now = Clock::get()?.unix_timestamp;
    let agreement = &mut ctx.accounts.agreement;
    let previous_state = agreement.record_funded(now);

    emit_cpi!(AgreementFunded {
        agreement: agreement.key(),
        creator: agreement.creator,
        counterparty: agreement.counterparty,
        amount,
        mint: agreement.mint,
        vault: agreement.vault,
        previous_state,
        new_state: agreement.state,
        timestamp: now,
    });

    Ok(())
}
