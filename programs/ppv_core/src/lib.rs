//! PPV Core — non-custodial evidence registry for Private Proof Vault.
//!
//! This program never holds user value. It records durable proof facts that
//! GWAP products can verify or consume through CPI/indexing. Commerce depends
//! on this registry; this registry must never depend on PPV Commerce.

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

// BUILD-ONLY PLACEHOLDER. No private key is retained for this address.
// CI runs `anchor keys sync` after its first build. Before any deployment,
// generate deployment authorities securely and sync program IDs deliberately.
declare_id!("JDksLsU1s3wSMzuEMtQ13fyT5ieSK1UYgcD3jBXAsYnF");

#[program]
pub mod ppv_core {
    use super::*;

    pub fn initialize_core(ctx: Context<InitializeCore>) -> Result<()> {
        admin::initialize_core(ctx)
    }

    pub fn set_paused(ctx: Context<CoreAdminOnly>, paused: bool) -> Result<()> {
        admin::set_paused(ctx, paused)
    }

    pub fn propose_admin(ctx: Context<CoreAdminOnly>, new_admin: Pubkey) -> Result<()> {
        admin::propose_admin(ctx, new_admin)
    }

    pub fn accept_admin(ctx: Context<AcceptCoreAdmin>) -> Result<()> {
        admin::accept_admin(ctx)
    }

    pub fn create_proof(
        ctx: Context<CreateProof>,
        proof_id: [u8; 16],
        content_hash: [u8; 32],
        metadata_hash: [u8; 32],
        owner_gns: Pubkey,
        proof_kind: u8,
    ) -> Result<()> {
        proof::create_proof(
            ctx,
            proof_id,
            content_hash,
            metadata_hash,
            owner_gns,
            proof_kind,
        )
    }

    pub fn revoke_proof(ctx: Context<RevokeProof>, reason_hash: [u8; 32]) -> Result<()> {
        proof::revoke_proof(ctx, reason_hash)
    }

    pub fn register_issuer(
        ctx: Context<RegisterIssuer>,
        issuer: Pubkey,
        label_hash: [u8; 32],
    ) -> Result<()> {
        issuer::register_issuer(ctx, issuer, label_hash)
    }

    pub fn set_issuer_active(ctx: Context<SetIssuerActive>, active: bool) -> Result<()> {
        issuer::set_issuer_active(ctx, active)
    }
}
