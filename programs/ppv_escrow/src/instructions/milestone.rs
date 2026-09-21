use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::{AGREEMENT_SEED, MILESTONE_SEED, VAULT_AUTHORITY_SEED, VAULT_TOKEN_SEED};
use crate::errors::EscrowError;
use crate::events::{
    MilestoneApproved, MilestoneCreated, MilestoneRejected, MilestoneSettled, MilestoneSubmitted,
    SettlementExecuted,
};
use crate::instructions::custody::pay_out_of_vault;
use crate::instructions::settlement_proof::require_cited_proof;
use crate::state::{EscrowAgreement, Milestone, Proof, MILESTONE_SCHEMA_VERSION};

#[event_cpi]
#[derive(Accounts)]
pub struct CreateMilestone<'info> {
    #[account(mut)]
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
    /// As with proofs, the index comes from the agreement's own counter, so the
    /// schedule is dense and ordered and no client can leave a gap.
    #[account(
        init,
        payer = creator,
        space = 8 + Milestone::INIT_SPACE,
        seeds = [
            MILESTONE_SEED,
            agreement.key().as_ref(),
            &agreement.milestone_count.to_le_bytes()
        ],
        bump
    )]
    pub milestone: Account<'info, Milestone>,
    pub system_program: Program<'info, System>,
}

pub fn handle_create_milestone(
    ctx: Context<CreateMilestone>,
    amount: u64,
    terms_hash: [u8; 32],
) -> Result<()> {
    let creator = ctx.accounts.creator.key();
    ctx.accounts
        .agreement
        .require_milestone_creatable(&creator)?;
    require!(amount > 0, EscrowError::InvalidMilestoneAmount);
    require!(
        terms_hash.iter().any(|byte| *byte != 0),
        EscrowError::InvalidTermsHash
    );

    let now = Clock::get()?.unix_timestamp;
    let agreement_key = ctx.accounts.agreement.key();
    let milestone_index = ctx.accounts.agreement.record_milestone(amount)?;

    let milestone = &mut ctx.accounts.milestone;
    milestone.schema_version = MILESTONE_SCHEMA_VERSION;
    milestone.bump = ctx.bumps.milestone;
    milestone.agreement = agreement_key;
    milestone.milestone_index = milestone_index;
    milestone.amount = amount;
    milestone.terms_hash = terms_hash;
    milestone.state = crate::state::MilestoneState::Pending;
    milestone.proof = Pubkey::default();
    milestone.created_at = now;
    milestone.submitted_at = 0;
    milestone.approved_at = 0;
    milestone.settled_at = 0;
    milestone.reserved = [0; 32];

    let milestone_key = milestone.key();
    let agreement = &ctx.accounts.agreement;

    emit_cpi!(MilestoneCreated {
        agreement: agreement_key,
        milestone: milestone_key,
        creator: agreement.creator,
        counterparty: agreement.counterparty,
        milestone_index,
        amount,
        terms_hash,
        agreement_state: agreement.state,
        timestamp: now,
    });

    Ok(())
}

/// Submission, approval and rejection all move a milestone and nothing else, so
/// they share one accounts struct and take no token accounts at all.
#[event_cpi]
#[derive(Accounts)]
pub struct UpdateMilestone<'info> {
    pub signer: Signer<'info>,
    #[account(
        seeds = [
            AGREEMENT_SEED,
            agreement.creator.as_ref(),
            &agreement.agreement_id.to_le_bytes()
        ],
        bump = agreement.bump,
    )]
    pub agreement: Account<'info, EscrowAgreement>,
    #[account(
        mut,
        seeds = [
            MILESTONE_SEED,
            agreement.key().as_ref(),
            &milestone.milestone_index.to_le_bytes()
        ],
        bump = milestone.bump,
    )]
    pub milestone: Account<'info, Milestone>,
}

pub fn handle_submit_milestone(ctx: Context<UpdateMilestone>) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    let agreement_key = ctx.accounts.agreement.key();
    ctx.accounts.agreement.require_milestone_active()?;
    ctx.accounts
        .milestone
        .require_submittable(&ctx.accounts.agreement, &agreement_key, &signer)?;

    let now = Clock::get()?.unix_timestamp;
    let agreement = &ctx.accounts.agreement;
    let (creator, counterparty, agreement_state) =
        (agreement.creator, agreement.counterparty, agreement.state);

    let milestone = &mut ctx.accounts.milestone;
    let previous_state = milestone.record_submitted(now);

    emit_cpi!(MilestoneSubmitted {
        agreement: agreement_key,
        milestone: milestone.key(),
        creator,
        counterparty,
        milestone_index: milestone.milestone_index,
        previous_state,
        new_state: milestone.state,
        agreement_state,
        timestamp: now,
    });

    Ok(())
}

pub fn handle_approve_milestone(ctx: Context<UpdateMilestone>) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    let agreement_key = ctx.accounts.agreement.key();
    ctx.accounts.agreement.require_milestone_active()?;
    ctx.accounts
        .milestone
        .require_decidable(&ctx.accounts.agreement, &agreement_key, &signer)?;

    let now = Clock::get()?.unix_timestamp;
    let agreement = &ctx.accounts.agreement;
    let (creator, counterparty, agreement_state) =
        (agreement.creator, agreement.counterparty, agreement.state);

    let milestone = &mut ctx.accounts.milestone;
    let previous_state = milestone.record_approved(now);

    emit_cpi!(MilestoneApproved {
        agreement: agreement_key,
        milestone: milestone.key(),
        creator,
        counterparty,
        milestone_index: milestone.milestone_index,
        previous_state,
        new_state: milestone.state,
        agreement_state,
        timestamp: now,
    });

    Ok(())
}

pub fn handle_reject_milestone(ctx: Context<UpdateMilestone>) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    let agreement_key = ctx.accounts.agreement.key();
    ctx.accounts.agreement.require_milestone_active()?;
    ctx.accounts
        .milestone
        .require_decidable(&ctx.accounts.agreement, &agreement_key, &signer)?;

    let now = Clock::get()?.unix_timestamp;
    let agreement = &ctx.accounts.agreement;
    let (creator, counterparty, agreement_state) =
        (agreement.creator, agreement.counterparty, agreement.state);

    let milestone = &mut ctx.accounts.milestone;
    let previous_state = milestone.record_rejected(now);

    emit_cpi!(MilestoneRejected {
        agreement: agreement_key,
        milestone: milestone.key(),
        creator,
        counterparty,
        milestone_index: milestone.milestone_index,
        previous_state,
        new_state: milestone.state,
        agreement_state,
        timestamp: now,
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct SettleMilestone<'info> {
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
    #[account(
        mut,
        seeds = [
            MILESTONE_SEED,
            agreement.key().as_ref(),
            &milestone.milestone_index.to_le_bytes()
        ],
        bump = milestone.bump,
    )]
    pub milestone: Account<'info, Milestone>,
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
    #[account(
        mut,
        constraint = seller_token_account.mint == agreement.mint @ EscrowError::MintMismatch,
        constraint = seller_token_account.owner == agreement.counterparty
            @ EscrowError::DestinationNotOwnedBySeller,
    )]
    pub seller_token_account: Account<'info, TokenAccount>,
    pub settlement_proof: Option<Account<'info, Proof>>,
    /// CHECK: as in `Settle` — the cited evidence's `ppv_core::ProofRecord`,
    /// fully validated in `require_cited_proof` before its status decides
    /// whether this tranche may be released.
    pub core_proof: Option<UncheckedAccount<'info>>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_settle_milestone(ctx: Context<SettleMilestone>) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    let agreement_key = ctx.accounts.agreement.key();
    ctx.accounts.agreement.require_milestone_active()?;
    ctx.accounts
        .milestone
        .require_settleable(&ctx.accounts.agreement, &agreement_key, &signer)?;

    // The same citation rule single-payment settlement runs, from the same
    // function: a tranche is money leaving the vault, and a revoked commitment
    // is no more of a justification for the third tranche than for the only
    // payment of a plain escrow.
    let cited_proof = require_cited_proof(
        &ctx.accounts.settlement_proof,
        &ctx.accounts.core_proof,
        &agreement_key,
    )?;

    let amount = ctx.accounts.milestone.amount;
    // A tranche can never exceed what the vault still owes, whatever the
    // milestone account says.
    require!(
        amount <= ctx.accounts.agreement.remaining(),
        EscrowError::CustodyMismatch
    );

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
    let previous_agreement_state = ctx.accounts.agreement.state;

    let milestone = &mut ctx.accounts.milestone;
    let previous_state = milestone.record_settled(cited_proof.unwrap_or_default(), now);
    let milestone_index = milestone.milestone_index;
    let milestone_key = milestone.key();
    let new_milestone_state = milestone.state;

    let agreement = &mut ctx.accounts.agreement;
    let finished = agreement.record_milestone_settled(amount, now)?;
    if finished {
        agreement.settlement_proof = cited_proof.unwrap_or_default();
    }

    emit_cpi!(MilestoneSettled {
        agreement: agreement_key,
        milestone: milestone_key,
        creator: agreement.creator,
        counterparty: agreement.counterparty,
        milestone_index,
        amount,
        destination,
        proof: cited_proof,
        previous_state,
        new_state: new_milestone_state,
        agreement_state: agreement.state,
        timestamp: now,
    });

    // The payment itself is reported by the same event a single-payment
    // agreement emits. Its previous and new agreement states are equal while
    // tranches remain, which is exactly what says "money moved but the
    // agreement did not".
    emit_cpi!(SettlementExecuted {
        agreement: agreement_key,
        buyer: agreement.creator,
        seller: agreement.counterparty,
        amount,
        mint: agreement.mint,
        destination,
        proof: cited_proof,
        previous_state: previous_agreement_state,
        new_state: agreement.state,
        timestamp: now,
    });

    Ok(())
}
