use crate::{
    constants::*,
    errors::PpvCoreError,
    events::{IssuerRegistered, IssuerStatusChanged},
    state::{CoreConfig, IssuerRecord},
};
use anchor_lang::prelude::*;

#[event_cpi]
#[derive(Accounts)]
#[instruction(issuer: Pubkey)]
pub struct RegisterIssuer<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ PpvCoreError::NotAuthorized)]
    pub config: Account<'info, CoreConfig>,
    #[account(
        init,
        payer = admin,
        space = 8 + IssuerRecord::INIT_SPACE,
        seeds = [ISSUER_SEED, issuer.as_ref()],
        bump
    )]
    pub issuer_record: Account<'info, IssuerRecord>,
    pub system_program: Program<'info, System>,
}

pub fn register_issuer(
    ctx: Context<RegisterIssuer>,
    issuer: Pubkey,
    label_hash: [u8; 32],
) -> Result<()> {
    require!(!ctx.accounts.config.paused, PpvCoreError::Paused);
    let now = Clock::get()?.unix_timestamp;
    let record = &mut ctx.accounts.issuer_record;
    record.bump = ctx.bumps.issuer_record;
    record.version = SCHEMA_VERSION;
    record.issuer = issuer;
    record.label_hash = label_hash;
    record.active = true;
    record.registered_at = now;
    record.updated_at = now;
    emit_cpi!(IssuerRegistered {
        issuer_record: record.key(),
        issuer,
        active: true,
        registered_at: now,
    });
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct SetIssuerActive<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ PpvCoreError::NotAuthorized)]
    pub config: Account<'info, CoreConfig>,
    #[account(mut, seeds = [ISSUER_SEED, issuer_record.issuer.as_ref()], bump = issuer_record.bump)]
    pub issuer_record: Account<'info, IssuerRecord>,
}

pub fn set_issuer_active(ctx: Context<SetIssuerActive>, active: bool) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let record = &mut ctx.accounts.issuer_record;
    record.active = active;
    record.updated_at = now;
    emit_cpi!(IssuerStatusChanged {
        issuer_record: record.key(),
        issuer: record.issuer,
        active,
        updated_at: now,
    });
    Ok(())
}
