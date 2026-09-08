use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::{AGREEMENT_SEED, VAULT_AUTHORITY_SEED, VAULT_TOKEN_SEED};
use crate::errors::EscrowError;
use crate::events::SettlementExecuted;
use crate::instructions::custody::pay_out_of_vault;
use crate::state::{EscrowAgreement, Proof};

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
    pub agreement: Account<'info, EscrowAgreement>,
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
    /// The approved evidence this settlement pays out against, when there is
    /// any. Optional on purpose: a plain escrow settles on the parties' own
    /// signatures, and making a proof mandatory here would fold approval into
    /// custody. When one is cited it is checked, recorded on the agreement, and
    /// named in the event, so the payment and its justification are one record.
    pub settlement_proof: Option<Account<'info, Proof>>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_settle(ctx: Context<Settle>) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    ctx.accounts.agreement.require_settleable(&signer)?;

    // What the vault still owes, not what the agreement was worth. For a
    // single-payment agreement these are the same number; the distinction
    // exists because a milestone contract can already have paid some of it out.
    let amount = ctx.accounts.agreement.remaining();
    let agreement_key = ctx.accounts.agreement.key();

    // Checked before any custody moves: a settlement that cites evidence must
    // cite this agreement's evidence, and evidence the other party accepted.
    let cited_proof = match &ctx.accounts.settlement_proof {
        Some(proof) => {
            require_keys_eq!(
                proof.agreement,
                agreement_key,
                EscrowError::ProofAgreementMismatch
            );
            require!(proof.is_approved(), EscrowError::ProofNotApproved);
            Some(proof.key())
        }
        None => None,
    };

    pay_out_of_vault(
        &ctx.accounts.token_program,
        &mut ctx.accounts.vault,
        &ctx.accounts.vault_authority,
        &ctx.accounts.mint,
        &mut ctx.accounts.seller_token_account,
        &agreement_key,
        ctx.accounts.agreement.vault_authority_bump,
        amount,
    )?;

    let now = Clock::get()?.unix_timestamp;
    let destination = ctx.accounts.seller_token_account.key();
    let agreement = &mut ctx.accounts.agreement;
    agreement.record_payout(amount)?;
    let previous_state = agreement.record_settled(now);
    agreement.settlement_proof = cited_proof.unwrap_or_default();

    emit_cpi!(SettlementExecuted {
        agreement: agreement.key(),
        buyer: agreement.creator,
        seller: agreement.counterparty,
        amount,
        mint: agreement.mint,
        destination,
        proof: cited_proof,
        previous_state,
        new_state: agreement.state,
        timestamp: now,
    });

    Ok(())
}
