use crate::{constants::*, errors::PpvCoreError, state::CoreConfig};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct InitializeCore<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + CoreConfig::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, CoreConfig>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_core(ctx: Context<InitializeCore>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let config = &mut ctx.accounts.config;
    config.bump = ctx.bumps.config;
    config.version = SCHEMA_VERSION;
    config.admin = ctx.accounts.admin.key();
    config.pending_admin = Pubkey::default();
    config.paused = false;
    config.created_at = now;
    Ok(())
}

#[derive(Accounts)]
pub struct CoreAdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ PpvCoreError::NotAuthorized)]
    pub config: Account<'info, CoreConfig>,
}

pub fn set_paused(ctx: Context<CoreAdminOnly>, paused: bool) -> Result<()> {
    ctx.accounts.config.paused = paused;
    Ok(())
}

pub fn propose_admin(ctx: Context<CoreAdminOnly>, new_admin: Pubkey) -> Result<()> {
    require!(
        new_admin != Pubkey::default() && new_admin != ctx.accounts.config.admin,
        PpvCoreError::InvalidAdmin
    );
    ctx.accounts.config.pending_admin = new_admin;
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptCoreAdmin<'info> {
    pub pending_admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, CoreConfig>,
}

pub fn accept_admin(ctx: Context<AcceptCoreAdmin>) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.pending_admin.key(),
        ctx.accounts.config.pending_admin,
        PpvCoreError::NoPendingAdmin
    );
    ctx.accounts.config.admin = ctx.accounts.pending_admin.key();
    ctx.accounts.config.pending_admin = Pubkey::default();
    Ok(())
}
