use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::system_program::{
    allocate, assign, create_account, transfer, Allocate, Assign, CreateAccount, Transfer,
};
use anchor_spl::token::{self, InitializeAccount3, Mint, Token};

use crate::constants::{AGREEMENT_SEED, VAULT_AUTHORITY_SEED, VAULT_TOKEN_SEED};
use crate::errors::EscrowError;
use crate::events::AgreementCreated;
use crate::state::{Agreement, AgreementState, AgreementType, AGREEMENT_SCHEMA_VERSION};

#[event_cpi]
#[derive(Accounts)]
#[instruction(agreement_id: u64)]
pub struct InitializeAgreement<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = creator,
        space = 8 + Agreement::INIT_SPACE,
        seeds = [AGREEMENT_SEED, creator.key().as_ref(), &agreement_id.to_le_bytes()],
        bump
    )]
    pub agreement: Account<'info, Agreement>,
    /// CHECK: PDA with no data. It exists only to sign vault transfers, and it
    /// is re-derived from the agreement address on every custody instruction.
    #[account(
        seeds = [VAULT_AUTHORITY_SEED, agreement.key().as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: created and initialized as an SPL token account by this
    /// instruction. The seeds constraint fixes its address before anything is
    /// written to it, and every later instruction re-derives it the same way.
    #[account(
        mut,
        seeds = [VAULT_TOKEN_SEED, agreement.key().as_ref()],
        bump
    )]
    pub vault: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_agreement(
    ctx: Context<InitializeAgreement>,
    agreement_id: u64,
    counterparty: Pubkey,
    agreement_type: AgreementType,
    amount: u64,
    terms_hash: [u8; 32],
) -> Result<()> {
    let creator = ctx.accounts.creator.key();

    require!(
        counterparty != Pubkey::default() && counterparty != creator,
        EscrowError::InvalidCounterparty
    );
    require!(amount > 0, EscrowError::InvalidAmount);
    require!(
        terms_hash.iter().any(|byte| *byte != 0),
        EscrowError::InvalidTermsHash
    );
    // The kernel implements one type. Every other variant is reserved wire
    // format, and an agreement whose semantics do not exist yet must not be
    // creatable on chain.
    require!(
        agreement_type == AgreementType::Escrow,
        EscrowError::UnsupportedAgreementType
    );

    let agreement_key = ctx.accounts.agreement.key();
    create_vault(&ctx, agreement_key)?;

    let now = Clock::get()?.unix_timestamp;
    let vault = ctx.accounts.vault.key();
    let mint = ctx.accounts.mint.key();
    let agreement = &mut ctx.accounts.agreement;

    agreement.schema_version = AGREEMENT_SCHEMA_VERSION;
    agreement.bump = ctx.bumps.agreement;
    agreement.vault_authority_bump = ctx.bumps.vault_authority;
    agreement.vault_bump = ctx.bumps.vault;
    agreement.creator = creator;
    agreement.counterparty = counterparty;
    agreement.agreement_id = agreement_id;
    agreement.agreement_type = agreement_type;
    agreement.mint = mint;
    agreement.vault = vault;
    agreement.amount = amount;
    agreement.terms_hash = terms_hash;
    agreement.state = AgreementState::Open;
    agreement.created_at = now;
    agreement.funded_at = 0;
    agreement.completed_at = 0;
    agreement.settled_at = 0;
    agreement.reserved = [0; 64];

    emit_cpi!(AgreementCreated {
        agreement: agreement_key,
        agreement_id,
        creator,
        counterparty,
        agreement_type,
        mint,
        vault,
        amount,
        terms_hash,
        new_state: AgreementState::Open,
        timestamp: now,
    });

    Ok(())
}

/// Creates the vault as a token account owned by the per-agreement vault
/// authority.
///
/// Anchor's `init` + `token::` constraints would express this in three lines,
/// but their codegen references `anchor_spl::token_2022`, whose dependency tree
/// pins a different `solana-program` than this workspace deploys with. Doing it
/// by hand keeps the classic-token-only dependency set — at the cost of
/// re-implementing the one subtlety `init` handles for free: an account that
/// already holds lamports cannot be created, only allocated and assigned.
/// Without that branch, anyone could permanently block an agreement by sending
/// one lamport to its vault address before the creator got there.
fn create_vault(ctx: &Context<InitializeAgreement>, agreement_key: Pubkey) -> Result<()> {
    let vault = ctx.accounts.vault.to_account_info();
    require!(vault.data_is_empty(), EscrowError::VaultAlreadyInitialized);

    let space = token::spl_token::state::Account::LEN;
    let rent_exempt = Rent::get()?.minimum_balance(space);
    let signer_seeds: &[&[&[u8]]] =
        &[&[VAULT_TOKEN_SEED, agreement_key.as_ref(), &[ctx.bumps.vault]]];
    let system_program = ctx.accounts.system_program.to_account_info();

    let existing = vault.lamports();
    if existing == 0 {
        create_account(
            CpiContext::new_with_signer(
                system_program,
                CreateAccount {
                    from: ctx.accounts.creator.to_account_info(),
                    to: vault.clone(),
                },
                signer_seeds,
            ),
            rent_exempt,
            space as u64,
            &ctx.accounts.token_program.key(),
        )?;
    } else {
        let shortfall = rent_exempt.saturating_sub(existing);
        if shortfall > 0 {
            transfer(
                CpiContext::new(
                    system_program.clone(),
                    Transfer {
                        from: ctx.accounts.creator.to_account_info(),
                        to: vault.clone(),
                    },
                ),
                shortfall,
            )?;
        }
        allocate(
            CpiContext::new_with_signer(
                system_program.clone(),
                Allocate {
                    account_to_allocate: vault.clone(),
                },
                signer_seeds,
            ),
            space as u64,
        )?;
        assign(
            CpiContext::new_with_signer(
                system_program,
                Assign {
                    account_to_assign: vault.clone(),
                },
                signer_seeds,
            ),
            &ctx.accounts.token_program.key(),
        )?;
    }

    token::initialize_account3(CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        InitializeAccount3 {
            account: vault,
            mint: ctx.accounts.mint.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        },
    ))
}
