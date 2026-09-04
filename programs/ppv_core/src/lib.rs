use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod state;

use errors::CoreError;
use events::*;
use state::*;

pub const PROOF_SEED: &[u8] = b"proof";

// Controlled program ID. Matches the ppv_core-program.json keypair held by
// the deployer; commit the deployment manifest after each deploy.
declare_id!("ENBkdfjFLD8sjcBFDzwD1BJ437ummEeJPdw6osowuaPm");

#[program]
pub mod ppv_core {
    use super::*;

    pub fn create_proof(
        ctx: Context<CreateProof>,
        proof_id: [u8; 16],
        content_hash: [u8; 32],
        context_hash: [u8; 32],
        kind: ProofKind,
    ) -> Result<()> {
        require!(
            content_hash.iter().any(|byte| *byte != 0),
            CoreError::InvalidContentHash
        );

        let now = Clock::get()?.unix_timestamp;
        let authority = ctx.accounts.authority.key();
        let proof = &mut ctx.accounts.proof;

        proof.schema_version = PROOF_SCHEMA_VERSION;
        proof.bump = ctx.bumps.proof;
        proof.proof_id = proof_id;
        proof.authority = authority;
        proof.content_hash = content_hash;
        proof.context_hash = context_hash;
        proof.kind = kind;
        proof.status = ProofStatus::Active;
        proof.created_at = now;
        proof.revoked_at = 0;
        proof.reserved = [0; 64];

        emit_cpi!(ProofCreated {
            proof: proof.key(),
            authority,
            proof_id,
            content_hash,
            context_hash,
            kind,
            created_at: now,
        });

        Ok(())
    }

    pub fn revoke_proof(ctx: Context<RevokeProof>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let authority = ctx.accounts.authority.key();
        let proof = &mut ctx.accounts.proof;

        proof.revoke(authority, now)?;

        emit_cpi!(ProofRevoked {
            proof: proof.key(),
            authority,
            proof_id: proof.proof_id,
            content_hash: proof.content_hash,
            kind: proof.kind,
            revoked_at: now,
        });

        Ok(())
    }
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(proof_id: [u8; 16])]
pub struct CreateProof<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + ProofRecord::INIT_SPACE,
        seeds = [PROOF_SEED, authority.key().as_ref(), proof_id.as_ref()],
        bump
    )]
    pub proof: Account<'info, ProofRecord>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct RevokeProof<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [PROOF_SEED, proof.authority.as_ref(), proof.proof_id.as_ref()],
        bump = proof.bump,
        has_one = authority @ CoreError::Unauthorized
    )]
    pub proof: Account<'info, ProofRecord>,
}
