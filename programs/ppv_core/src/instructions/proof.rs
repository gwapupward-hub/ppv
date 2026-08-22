use crate::{
    constants::*,
    errors::PpvCoreError,
    events::{ProofCreated, ProofRevoked},
    state::{CoreConfig, ProofRecord},
};
use anchor_lang::prelude::*;

#[event_cpi]
#[derive(Accounts)]
#[instruction(proof_id: [u8; 16])]
pub struct CreateProof<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, CoreConfig>,
    #[account(
        init,
        payer = owner,
        space = 8 + ProofRecord::INIT_SPACE,
        seeds = [PROOF_SEED, proof_id.as_ref()],
        bump
    )]
    pub proof: Account<'info, ProofRecord>,
    pub system_program: Program<'info, System>,
}

pub fn create_proof(
    ctx: Context<CreateProof>,
    proof_id: [u8; 16],
    content_hash: [u8; 32],
    metadata_hash: [u8; 32],
    owner_gns: Pubkey,
    proof_kind: u8,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, PpvCoreError::Paused);
    require!(proof_kind <= MAX_PROOF_KIND, PpvCoreError::BadProofKind);

    let now = Clock::get()?.unix_timestamp;
    let proof = &mut ctx.accounts.proof;
    proof.bump = ctx.bumps.proof;
    proof.version = SCHEMA_VERSION;
    proof.proof_id = proof_id;
    proof.owner = ctx.accounts.owner.key();
    proof.owner_gns = owner_gns;
    proof.content_hash = content_hash;
    proof.metadata_hash = metadata_hash;
    proof.proof_kind = proof_kind;
    proof.created_at = now;
    proof.revoked = false;
    proof.revoked_at = 0;
    proof.revocation_reason_hash = [0u8; 32];

    emit_cpi!(ProofCreated {
        proof: proof.key(),
        proof_id,
        owner: proof.owner,
        owner_gns,
        content_hash,
        metadata_hash,
        proof_kind,
        created_at: now,
    });
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct RevokeProof<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [PROOF_SEED, proof.proof_id.as_ref()],
        bump = proof.bump,
        has_one = owner @ PpvCoreError::NotProofOwner
    )]
    pub proof: Account<'info, ProofRecord>,
}

pub fn revoke_proof(ctx: Context<RevokeProof>, reason_hash: [u8; 32]) -> Result<()> {
    let proof = &mut ctx.accounts.proof;
    require!(!proof.revoked, PpvCoreError::AlreadyRevoked);
    let now = Clock::get()?.unix_timestamp;
    proof.revoked = true;
    proof.revoked_at = now;
    proof.revocation_reason_hash = reason_hash;
    emit_cpi!(ProofRevoked {
        proof: proof.key(),
        owner: proof.owner,
        reason_hash,
        revoked_at: now,
    });
    Ok(())
}
