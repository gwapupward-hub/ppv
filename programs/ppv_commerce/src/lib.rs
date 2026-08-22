use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod state;

use errors::CommerceError;
use events::*;
use state::*;

pub const AGREEMENT_SEED: &[u8] = b"agreement";
pub const MAX_AGREEMENT_TTL_SECS: i64 = 365 * 24 * 60 * 60;

// Build-only placeholder. Run `anchor keys sync` with controlled program
// keypairs before deployment and commit the resulting deployment manifest.
declare_id!("4Y83YzUZnJ5LF9M1PcKHtsYcQ1LRxedwDi93PVf5H1FJ");

#[program]
pub mod ppv_commerce {
    use super::*;

    pub fn create_agreement(
        ctx: Context<CreateAgreement>,
        agreement_id: [u8; 16],
        party_b: Pubkey,
        content_hash: [u8; 32],
        terms_hash: [u8; 32],
        expires_at: i64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let party_a = ctx.accounts.party_a.key();
        let max_expiry = now
            .checked_add(MAX_AGREEMENT_TTL_SECS)
            .ok_or(CommerceError::Overflow)?;

        require!(
            party_b != Pubkey::default() && party_b != party_a,
            CommerceError::InvalidParty
        );
        require!(
            content_hash.iter().any(|byte| *byte != 0),
            CommerceError::InvalidContentHash
        );
        require!(
            terms_hash.iter().any(|byte| *byte != 0),
            CommerceError::InvalidTermsHash
        );
        require!(
            expires_at > now && expires_at <= max_expiry,
            CommerceError::InvalidExpiry
        );

        let agreement = &mut ctx.accounts.agreement;
        agreement.schema_version = AGREEMENT_SCHEMA_VERSION;
        agreement.bump = ctx.bumps.agreement;
        agreement.agreement_id = agreement_id;
        agreement.party_a = party_a;
        agreement.party_b = party_b;
        agreement.version = 1;
        agreement.content_hash = content_hash;
        agreement.terms_hash = terms_hash;
        agreement.sig_a = None;
        agreement.sig_b = None;
        agreement.state = AgreementState::Pending;
        agreement.created_at = now;
        agreement.expires_at = expires_at;
        agreement.executed_at = 0;
        agreement.cancelled_at = 0;
        agreement.reserved = [0; 64];

        emit_cpi!(AgreementCreated {
            agreement: agreement.key(),
            agreement_id,
            party_a,
            party_b,
            version: 1,
            content_hash,
            terms_hash,
            expires_at,
            created_at: now,
        });

        Ok(())
    }

    pub fn propose_revision(
        ctx: Context<MutateAgreement>,
        expected_version: u32,
        new_content_hash: [u8; 32],
        new_terms_hash: [u8; 32],
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let signer = ctx.accounts.signer.key();
        let agreement = &mut ctx.accounts.agreement;

        let previous_version = agreement.revise(
            signer,
            expected_version,
            new_content_hash,
            new_terms_hash,
            now,
        )?;

        emit_cpi!(AgreementRevised {
            agreement: agreement.key(),
            proposer: signer,
            previous_version,
            new_version: agreement.version,
            content_hash: agreement.content_hash,
            terms_hash: agreement.terms_hash,
            signatures_cleared: true,
            revised_at: now,
        });

        Ok(())
    }

    pub fn sign_agreement(
        ctx: Context<MutateAgreement>,
        expected_version: u32,
        expected_content_hash: [u8; 32],
        expected_terms_hash: [u8; 32],
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let signer = ctx.accounts.signer.key();
        let agreement = &mut ctx.accounts.agreement;

        let executed = agreement.sign(
            signer,
            expected_version,
            expected_content_hash,
            expected_terms_hash,
            now,
        )?;

        emit_cpi!(AgreementSigned {
            agreement: agreement.key(),
            signer,
            version: expected_version,
            content_hash: expected_content_hash,
            terms_hash: expected_terms_hash,
            signed_at: now,
        });

        if executed {
            emit_cpi!(AgreementExecuted {
                agreement: agreement.key(),
                party_a: agreement.party_a,
                party_b: agreement.party_b,
                version: agreement.version,
                content_hash: agreement.content_hash,
                terms_hash: agreement.terms_hash,
                executed_at: agreement.executed_at,
            });
        }

        Ok(())
    }

    pub fn cancel_agreement(ctx: Context<MutateAgreement>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let signer = ctx.accounts.signer.key();
        let agreement = &mut ctx.accounts.agreement;

        agreement.cancel(signer, now)?;

        emit_cpi!(AgreementCancelled {
            agreement: agreement.key(),
            cancelled_by: signer,
            version: agreement.version,
            cancelled_at: now,
        });

        Ok(())
    }
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(agreement_id: [u8; 16])]
pub struct CreateAgreement<'info> {
    #[account(mut)]
    pub party_a: Signer<'info>,
    #[account(
        init,
        payer = party_a,
        space = 8 + Agreement::INIT_SPACE,
        seeds = [AGREEMENT_SEED, party_a.key().as_ref(), agreement_id.as_ref()],
        bump
    )]
    pub agreement: Account<'info, Agreement>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct MutateAgreement<'info> {
    pub signer: Signer<'info>,
    #[account(
        mut,
        seeds = [
            AGREEMENT_SEED,
            agreement.party_a.as_ref(),
            agreement.agreement_id.as_ref()
        ],
        bump = agreement.bump
    )]
    pub agreement: Account<'info, Agreement>,
}
