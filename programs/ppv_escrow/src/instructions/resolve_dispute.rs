use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::{AGREEMENT_SEED, VAULT_AUTHORITY_SEED, VAULT_TOKEN_SEED};
use crate::errors::EscrowError;
use crate::events::{DisputeResolved, RefundExecuted, SettlementExecuted};
use crate::instructions::custody::pay_out_of_vault;
use crate::state::{Agreement, AgreementState, DisputeOutcome};

/// Resolution by concession.
///
/// There is no arbiter here and nothing to trust. The signer gives up its own
/// claim and the money goes to the *other* party — so the only person who can
/// direct this vault to the seller is the buyer, and the only person who can
/// direct it back to the buyer is the seller. Neither can take it.
///
/// The beneficiary is read from the destination account's owner rather than
/// passed as a flag, so there is one fact deciding the outcome instead of two
/// that could disagree.
///
/// Percentage splits, designated arbiters, and multisig arbitration are Phase
/// 13, behind the arbiter policy gate. Concession is what a protocol can do
/// safely before it has decided who is allowed to judge.
#[event_cpi]
#[derive(Accounts)]
pub struct ResolveDispute<'info> {
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
    /// CHECK: PDA with no data; the seeds and the stored bump are the whole
    /// authorization, and it signs only this transfer.
    #[account(
        seeds = [VAULT_AUTHORITY_SEED, agreement.key().as_ref()],
        bump = agreement.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,
    /// Must belong to one of the two parties, and the handler requires that it
    /// is not the signer's own.
    #[account(
        mut,
        constraint = destination.mint == agreement.mint @ EscrowError::MintMismatch,
    )]
    pub destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_resolve_dispute(ctx: Context<ResolveDispute>) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    let beneficiary = ctx.accounts.destination.owner;
    require!(
        ctx.accounts.agreement.is_party(&beneficiary),
        EscrowError::DestinationNotAParty
    );
    ctx.accounts
        .agreement
        .require_resolvable(&signer, &beneficiary)?;

    let amount = ctx.accounts.agreement.amount;
    let agreement_key = ctx.accounts.agreement.key();
    let outcome = ctx.accounts.agreement.outcome_for(&beneficiary);

    pay_out_of_vault(
        &ctx.accounts.token_program,
        &mut ctx.accounts.vault,
        &ctx.accounts.vault_authority,
        &ctx.accounts.mint,
        &mut ctx.accounts.destination,
        &agreement_key,
        ctx.accounts.agreement.vault_authority_bump,
        amount,
    )?;

    let now = Clock::get()?.unix_timestamp;
    let destination = ctx.accounts.destination.key();
    let agreement = &mut ctx.accounts.agreement;
    let previous_state = match outcome {
        DisputeOutcome::SellerPaid => agreement.record_settled(now),
        DisputeOutcome::BuyerRefunded => agreement.record_refunded(now),
    };
    debug_assert_eq!(previous_state, AgreementState::Disputed);

    // Two events, because two different things happened: the dispute ended,
    // and money moved. The custody event is the same one the undisputed path
    // emits, so a consumer counting payments has one event type to count
    // however the payment came about.
    emit_cpi!(DisputeResolved {
        agreement: agreement_key,
        creator: agreement.creator,
        counterparty: agreement.counterparty,
        resolved_by: signer,
        beneficiary,
        outcome,
        opened_by: agreement.dispute_opened_by,
        resulting_state: agreement.state,
        timestamp: now,
    });

    match outcome {
        DisputeOutcome::SellerPaid => emit_cpi!(SettlementExecuted {
            agreement: agreement_key,
            buyer: agreement.creator,
            seller: agreement.counterparty,
            amount,
            mint: agreement.mint,
            destination,
            proof: None,
            previous_state,
            new_state: agreement.state,
            timestamp: now,
        }),
        DisputeOutcome::BuyerRefunded => emit_cpi!(RefundExecuted {
            agreement: agreement_key,
            buyer: agreement.creator,
            seller: agreement.counterparty,
            refunded_by: signer,
            amount,
            mint: agreement.mint,
            destination,
            previous_state,
            new_state: agreement.state,
            timestamp: now,
        }),
    }

    Ok(())
}
