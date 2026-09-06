use anchor_lang::prelude::*;

use crate::constants::{AGREEMENT_SEED, PROOF_SEED};
use crate::errors::EscrowError;
use crate::events::ProofSubmitted;
use crate::state::{Agreement, Proof, ProofStatus, PROOF_SCHEMA_VERSION};

#[event_cpi]
#[derive(Accounts)]
pub struct SubmitProof<'info> {
    #[account(mut)]
    pub submitter: Signer<'info>,
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
    /// The index comes from the agreement's own counter rather than from the
    /// caller, so proof indices are dense and ordered, and two clients racing
    /// to submit cannot silently overwrite or skip one: the loser's
    /// transaction fails on an account that already exists.
    #[account(
        init,
        payer = submitter,
        space = 8 + Proof::INIT_SPACE,
        seeds = [
            PROOF_SEED,
            agreement.key().as_ref(),
            &agreement.proof_count.to_le_bytes()
        ],
        bump
    )]
    pub proof: Account<'info, Proof>,
    pub system_program: Program<'info, System>,
}

pub fn handle_submit_proof(
    ctx: Context<SubmitProof>,
    content_hash: [u8; 32],
    metadata_hash: [u8; 32],
) -> Result<()> {
    let submitter = ctx.accounts.submitter.key();
    ctx.accounts
        .agreement
        .require_proof_submittable(&submitter)?;
    require!(
        content_hash.iter().any(|byte| *byte != 0),
        EscrowError::InvalidContentHash
    );

    let now = Clock::get()?.unix_timestamp;
    let agreement_key = ctx.accounts.agreement.key();
    let proof_index = ctx.accounts.agreement.record_proof()?;

    let proof = &mut ctx.accounts.proof;
    proof.schema_version = PROOF_SCHEMA_VERSION;
    proof.bump = ctx.bumps.proof;
    proof.agreement = agreement_key;
    proof.submitter = submitter;
    proof.proof_index = proof_index;
    proof.content_hash = content_hash;
    proof.metadata_hash = metadata_hash;
    proof.status = ProofStatus::Submitted;
    proof.created_at = now;
    proof.decided_at = 0;
    proof.decided_by = Pubkey::default();
    proof.reserved = [0; 32];

    let proof_key = proof.key();
    let agreement = &ctx.accounts.agreement;

    emit_cpi!(ProofSubmitted {
        agreement: agreement_key,
        proof: proof_key,
        creator: agreement.creator,
        counterparty: agreement.counterparty,
        submitter,
        proof_index,
        content_hash,
        metadata_hash,
        agreement_state: agreement.state,
        timestamp: now,
    });

    Ok(())
}
