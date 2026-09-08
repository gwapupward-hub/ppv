use anchor_lang::prelude::*;

use crate::constants::{AGREEMENT_SEED, PROOF_SEED};
use crate::events::{ProofApproved, ProofRejected};
use crate::state::{EscrowAgreement, Proof, ProofStatus};

/// Approval and rejection are the same authorization and the same state gate,
/// differing only in the decision recorded. They share one accounts struct so
/// the two paths cannot drift apart.
#[event_cpi]
#[derive(Accounts)]
pub struct DecideProof<'info> {
    pub decider: Signer<'info>,
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
            PROOF_SEED,
            agreement.key().as_ref(),
            &proof.proof_index.to_le_bytes()
        ],
        bump = proof.bump,
    )]
    pub proof: Account<'info, Proof>,
}

fn decide(ctx: Context<DecideProof>, status: ProofStatus) -> Result<()> {
    let decider = ctx.accounts.decider.key();
    let agreement_key = ctx.accounts.agreement.key();
    ctx.accounts
        .proof
        .require_decidable(&ctx.accounts.agreement, &agreement_key, &decider)?;

    let now = Clock::get()?.unix_timestamp;
    let agreement = &ctx.accounts.agreement;
    let creator = agreement.creator;
    let counterparty = agreement.counterparty;
    let agreement_state = agreement.state;

    let proof = &mut ctx.accounts.proof;
    proof.record_decision(status, decider, now);

    let proof_key = proof.key();
    let proof_index = proof.proof_index;
    let submitter = proof.submitter;
    let core_proof = proof.core_proof;

    match status {
        ProofStatus::Approved => emit_cpi!(ProofApproved {
            agreement: agreement_key,
            proof: proof_key,
            core_proof,
            creator,
            counterparty,
            submitter,
            decided_by: decider,
            proof_index,
            agreement_state,
            timestamp: now,
        }),
        ProofStatus::Rejected => emit_cpi!(ProofRejected {
            agreement: agreement_key,
            proof: proof_key,
            core_proof,
            creator,
            counterparty,
            submitter,
            decided_by: decider,
            proof_index,
            agreement_state,
            timestamp: now,
        }),
        // `require_decidable` already refused anything but `Submitted`, and the
        // only callers pass a decision. Reaching here would mean the caller
        // asked to "decide" a proof as undecided.
        ProofStatus::Submitted => return err!(crate::errors::EscrowError::ProofAlreadyDecided),
    }

    Ok(())
}

pub fn handle_approve_proof(ctx: Context<DecideProof>) -> Result<()> {
    decide(ctx, ProofStatus::Approved)
}

pub fn handle_reject_proof(ctx: Context<DecideProof>) -> Result<()> {
    decide(ctx, ProofStatus::Rejected)
}
