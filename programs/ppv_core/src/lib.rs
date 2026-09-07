use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod state;

use errors::CoreError;
use events::*;
use state::*;

pub const PROOF_SEED: &[u8] = b"proof";

// PERMANENT PROTOCOL IDENTITY — do not change this address.
//
// This is not a build placeholder. It is the deterministic namespace every
// ppv_core account derives from, and it must correspond to the backed-up
// permanent program keypair held for ppv_core. Replacing it does not migrate
// anything: it creates a distinct protocol universe in which every existing
// address resolves to nothing.
//
// Do NOT run `anchor keys sync` against generated or arbitrary keys in this
// checkout. The only tool permitted to substitute an id here is the F1 harness
// (`scripts/verify-f1.sh`), which generates throwaway keypairs under the
// ignored `target/deploy/`, syncs them for a local-validator run, and restores
// this file on every exit path. `scripts/verify-devnet-readiness.sh` asserts
// that the restoration was complete.
declare_id!("9cWE41ZDNQChvFrRoVuPQDeoVLg46ACTiZRCZaBZzfwU");

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
