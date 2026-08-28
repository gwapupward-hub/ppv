use anchor_lang::bpf_upgradeable_state::ProgramData;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{bpf_loader_upgradeable, program::invoke_signed};

pub mod errors;
pub mod events;
pub mod state;

use errors::GovernanceError;
use events::*;
use state::*;

pub const GOVERNANCE_SEED: &[u8] = b"governance";
pub const VAULT_SEED: &[u8] = b"vault";
pub const PROPOSAL_SEED: &[u8] = b"proposal";

// Build-only placeholder. The permanent governance program keypair must be
// operator-controlled and synchronized before any devnet deployment.
declare_id!("HMMsMHi749qo5sBQY49Ttu3KKNQ7XPhK5nZAGYPTygyr");

#[program]
pub mod ppv_governance {
    use super::*;

    pub fn initialize_governance(
        ctx: Context<InitializeGovernance>,
        members: Vec<Pubkey>,
        threshold: u8,
        min_delay_slots: u64,
        proposal_lifetime_slots: u64,
        treasury: Pubkey,
    ) -> Result<()> {
        let fixed_members = Governance::validate_config(
            &members,
            threshold,
            min_delay_slots,
            proposal_lifetime_slots,
            treasury,
        )?;

        let governance = &mut ctx.accounts.governance;
        governance.schema_version = GOVERNANCE_SCHEMA_VERSION;
        governance.bump = ctx.bumps.governance;
        governance.vault_bump = ctx.bumps.vault;
        governance.threshold = threshold;
        governance.member_count = members.len() as u8;
        governance.members = fixed_members;
        governance.next_proposal_id = 0;
        governance.epoch = 0;
        governance.min_delay_slots = min_delay_slots;
        governance.proposal_lifetime_slots = proposal_lifetime_slots;
        governance.treasury = treasury;
        governance.reserved = [0; 64];

        let vault = &mut ctx.accounts.vault;
        vault.bump = ctx.bumps.vault;
        vault.governance = governance.key();
        vault.reserved = [0; 32];

        emit_cpi!(GovernanceInitialized {
            governance: governance.key(),
            vault: vault.key(),
            member_count: governance.member_count,
            threshold,
            min_delay_slots,
            proposal_lifetime_slots,
            treasury,
        });

        Ok(())
    }

    pub fn create_upgrade_proposal(
        ctx: Context<CreateProposal>,
        proposal_id: u64,
        program: Pubkey,
        buffer: Pubkey,
    ) -> Result<()> {
        require_keys_neq!(
            program,
            Pubkey::default(),
            GovernanceError::WrongTargetProgram
        );
        require_keys_neq!(buffer, Pubkey::default(), GovernanceError::WrongBuffer);
        require_keys_neq!(program, buffer, GovernanceError::WrongBuffer);

        let proposer = ctx.accounts.proposer.key();
        let governance = &mut ctx.accounts.governance;
        require!(
            governance.member_index(proposer).is_some(),
            GovernanceError::UnauthorizedMember
        );
        require_eq!(
            proposal_id,
            governance.next_proposal_id,
            GovernanceError::InvalidProposalId
        );

        let current_slot = Clock::get()?.slot;
        let (execute_after_slot, expires_at_slot) = governance.proposal_deadlines(current_slot)?;
        governance.next_proposal_id = governance
            .next_proposal_id
            .checked_add(1)
            .ok_or(GovernanceError::ArithmeticOverflow)?;

        initialize_proposal(
            &mut ctx.accounts.proposal,
            ctx.bumps.proposal,
            governance,
            proposer,
            proposal_id,
            current_slot,
            execute_after_slot,
            expires_at_slot,
            ProposalAction::Upgrade { program, buffer },
        );

        emit_cpi!(ProposalCreated {
            governance: governance.key(),
            proposal: ctx.accounts.proposal.key(),
            proposal_id,
            proposer,
            action_kind: 0,
            governance_epoch: governance.epoch,
            execute_after_slot,
            expires_at_slot,
        });

        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_reconfiguration_proposal(
        ctx: Context<CreateProposal>,
        proposal_id: u64,
        members: Vec<Pubkey>,
        threshold: u8,
        min_delay_slots: u64,
        proposal_lifetime_slots: u64,
        treasury: Pubkey,
    ) -> Result<()> {
        let fixed_members = Governance::validate_config(
            &members,
            threshold,
            min_delay_slots,
            proposal_lifetime_slots,
            treasury,
        )?;

        let proposer = ctx.accounts.proposer.key();
        let governance = &mut ctx.accounts.governance;
        require!(
            governance.member_index(proposer).is_some(),
            GovernanceError::UnauthorizedMember
        );
        require_eq!(
            proposal_id,
            governance.next_proposal_id,
            GovernanceError::InvalidProposalId
        );

        let current_slot = Clock::get()?.slot;
        let (execute_after_slot, expires_at_slot) = governance.proposal_deadlines(current_slot)?;
        governance.next_proposal_id = governance
            .next_proposal_id
            .checked_add(1)
            .ok_or(GovernanceError::ArithmeticOverflow)?;

        initialize_proposal(
            &mut ctx.accounts.proposal,
            ctx.bumps.proposal,
            governance,
            proposer,
            proposal_id,
            current_slot,
            execute_after_slot,
            expires_at_slot,
            ProposalAction::Reconfigure {
                member_count: members.len() as u8,
                members: fixed_members,
                threshold,
                min_delay_slots,
                proposal_lifetime_slots,
                treasury,
            },
        );

        emit_cpi!(ProposalCreated {
            governance: governance.key(),
            proposal: ctx.accounts.proposal.key(),
            proposal_id,
            proposer,
            action_kind: 1,
            governance_epoch: governance.epoch,
            execute_after_slot,
            expires_at_slot,
        });

        Ok(())
    }

    pub fn approve_proposal(ctx: Context<ApproveProposal>) -> Result<()> {
        let current_slot = Clock::get()?.slot;
        let member = ctx.accounts.member.key();
        let governance = &ctx.accounts.governance;
        let member_index = governance
            .member_index(member)
            .ok_or(GovernanceError::UnauthorizedMember)?;

        let proposal = &mut ctx.accounts.proposal;
        proposal.assert_active(governance, current_slot)?;
        proposal.approve(member_index)?;

        emit_cpi!(ProposalApproved {
            governance: governance.key(),
            proposal: proposal.key(),
            proposal_id: proposal.proposal_id,
            member,
            approval_count: proposal.approval_count,
            threshold: governance.threshold,
        });

        Ok(())
    }

    pub fn cancel_proposal(ctx: Context<CancelProposal>) -> Result<()> {
        let current_slot = Clock::get()?.slot;
        let governance = &ctx.accounts.governance;
        let proposal = &mut ctx.accounts.proposal;
        proposal.assert_active(governance, current_slot)?;
        require_keys_eq!(
            proposal.proposer,
            ctx.accounts.proposer.key(),
            GovernanceError::UnauthorizedCancellation
        );
        proposal.cancelled = true;

        emit_cpi!(ProposalCancelled {
            governance: governance.key(),
            proposal: proposal.key(),
            proposal_id: proposal.proposal_id,
            proposer: proposal.proposer,
        });

        Ok(())
    }

    pub fn execute_reconfiguration(ctx: Context<ExecuteReconfiguration>) -> Result<()> {
        let current_slot = Clock::get()?.slot;
        let governance = &mut ctx.accounts.governance;
        let proposal = &mut ctx.accounts.proposal;
        proposal.assert_executable(governance, current_slot)?;

        let ProposalAction::Reconfigure {
            member_count,
            members,
            threshold,
            min_delay_slots,
            proposal_lifetime_slots,
            treasury,
        } = proposal.action
        else {
            return err!(GovernanceError::WrongProposalAction);
        };

        let validated = Governance::validate_config(
            &members[..usize::from(member_count)],
            threshold,
            min_delay_slots,
            proposal_lifetime_slots,
            treasury,
        )?;
        require!(validated == members, GovernanceError::DuplicateMember);

        proposal.executed = true;
        governance.apply_config(
            member_count,
            members,
            threshold,
            min_delay_slots,
            proposal_lifetime_slots,
            treasury,
        );
        governance.epoch = governance
            .epoch
            .checked_add(1)
            .ok_or(GovernanceError::ArithmeticOverflow)?;

        emit_cpi!(GovernanceReconfigured {
            governance: governance.key(),
            proposal: proposal.key(),
            proposal_id: proposal.proposal_id,
            new_epoch: governance.epoch,
            member_count,
            threshold,
            min_delay_slots,
            proposal_lifetime_slots,
            treasury,
        });

        Ok(())
    }

    pub fn execute_upgrade(ctx: Context<ExecuteUpgrade>) -> Result<()> {
        let current_slot = Clock::get()?.slot;
        let governance = &ctx.accounts.governance;
        let proposal = &mut ctx.accounts.proposal;
        proposal.assert_executable(governance, current_slot)?;

        let ProposalAction::Upgrade { program, buffer } = proposal.action else {
            return err!(GovernanceError::WrongProposalAction);
        };

        require_keys_eq!(
            ctx.accounts.target_program.key(),
            program,
            GovernanceError::WrongTargetProgram
        );
        require_keys_eq!(ctx.accounts.buffer.key(), buffer, GovernanceError::WrongBuffer);
        require_keys_eq!(
            ctx.accounts.spill.key(),
            governance.treasury,
            GovernanceError::WrongSpillDestination
        );
        require_keys_eq!(
            ctx.accounts.vault.governance,
            governance.key(),
            GovernanceError::WrongVault
        );

        let loader_id = bpf_loader_upgradeable::id();
        require_keys_eq!(
            *ctx.accounts.target_program.owner,
            loader_id,
            GovernanceError::WrongLoaderOwner
        );
        require_keys_eq!(
            *ctx.accounts.program_data.owner,
            loader_id,
            GovernanceError::WrongLoaderOwner
        );
        require_keys_eq!(
            *ctx.accounts.buffer.owner,
            loader_id,
            GovernanceError::WrongLoaderOwner
        );

        let expected_program_data = Pubkey::find_program_address(&[program.as_ref()], &loader_id).0;
        require_keys_eq!(
            ctx.accounts.program_data.key(),
            expected_program_data,
            GovernanceError::WrongProgramData
        );

        let instruction = bpf_loader_upgradeable::upgrade(
            &program,
            &buffer,
            &ctx.accounts.vault.key(),
            &ctx.accounts.spill.key(),
        );

        let governance_key = governance.key();
        let vault_bump = [governance.vault_bump];
        let signer_seeds: &[&[u8]] = &[VAULT_SEED, governance_key.as_ref(), &vault_bump];

        invoke_signed(
            &instruction,
            &[
                ctx.accounts.program_data.to_account_info(),
                ctx.accounts.target_program.to_account_info(),
                ctx.accounts.buffer.to_account_info(),
                ctx.accounts.spill.to_account_info(),
                ctx.accounts.rent.to_account_info(),
                ctx.accounts.clock.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.loader_program.to_account_info(),
            ],
            &[signer_seeds],
        )?;

        proposal.executed = true;

        emit_cpi!(ProgramUpgradeExecuted {
            governance: governance.key(),
            vault: ctx.accounts.vault.key(),
            proposal: proposal.key(),
            proposal_id: proposal.proposal_id,
            program,
            buffer,
            executor: ctx.accounts.executor.key(),
        });

        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
fn initialize_proposal(
    proposal: &mut Account<Proposal>,
    bump: u8,
    governance: &Account<Governance>,
    proposer: Pubkey,
    proposal_id: u64,
    created_slot: u64,
    execute_after_slot: u64,
    expires_at_slot: u64,
    action: ProposalAction,
) {
    proposal.bump = bump;
    proposal.governance = governance.key();
    proposal.proposer = proposer;
    proposal.proposal_id = proposal_id;
    proposal.governance_epoch = governance.epoch;
    proposal.created_slot = created_slot;
    proposal.execute_after_slot = execute_after_slot;
    proposal.expires_at_slot = expires_at_slot;
    proposal.approvals = 0;
    proposal.approval_count = 0;
    proposal.executed = false;
    proposal.cancelled = false;
    proposal.action = action;
    proposal.reserved = [0; 32];
}

#[event_cpi]
#[derive(Accounts)]
pub struct InitializeGovernance<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ GovernanceError::WrongProgramData
    )]
    pub program: Program<'info, crate::program::PpvGovernance>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(payer.key())
            @ GovernanceError::UnauthorizedBootstrap
    )]
    pub program_data: Account<'info, ProgramData>,
    #[account(
        init,
        payer = payer,
        space = 8 + Governance::INIT_SPACE,
        seeds = [GOVERNANCE_SEED],
        bump
    )]
    pub governance: Account<'info, Governance>,
    #[account(
        init,
        payer = payer,
        space = 8 + GovernanceVault::INIT_SPACE,
        seeds = [VAULT_SEED, governance.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, GovernanceVault>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(proposal_id: u64)]
pub struct CreateProposal<'info> {
    #[account(mut)]
    pub proposer: Signer<'info>,
    #[account(
        mut,
        seeds = [GOVERNANCE_SEED],
        bump = governance.bump
    )]
    pub governance: Account<'info, Governance>,
    #[account(
        init,
        payer = proposer,
        space = 8 + Proposal::INIT_SPACE,
        seeds = [PROPOSAL_SEED, governance.key().as_ref(), &proposal_id.to_le_bytes()],
        bump
    )]
    pub proposal: Account<'info, Proposal>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct ApproveProposal<'info> {
    pub member: Signer<'info>,
    #[account(seeds = [GOVERNANCE_SEED], bump = governance.bump)]
    pub governance: Account<'info, Governance>,
    #[account(
        mut,
        has_one = governance,
        seeds = [
            PROPOSAL_SEED,
            governance.key().as_ref(),
            &proposal.proposal_id.to_le_bytes()
        ],
        bump = proposal.bump
    )]
    pub proposal: Account<'info, Proposal>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct CancelProposal<'info> {
    pub proposer: Signer<'info>,
    #[account(seeds = [GOVERNANCE_SEED], bump = governance.bump)]
    pub governance: Account<'info, Governance>,
    #[account(
        mut,
        has_one = governance,
        seeds = [
            PROPOSAL_SEED,
            governance.key().as_ref(),
            &proposal.proposal_id.to_le_bytes()
        ],
        bump = proposal.bump
    )]
    pub proposal: Account<'info, Proposal>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct ExecuteReconfiguration<'info> {
    /// Execution is permissionless once threshold and delay are satisfied.
    pub executor: Signer<'info>,
    #[account(mut, seeds = [GOVERNANCE_SEED], bump = governance.bump)]
    pub governance: Account<'info, Governance>,
    #[account(
        mut,
        has_one = governance,
        seeds = [
            PROPOSAL_SEED,
            governance.key().as_ref(),
            &proposal.proposal_id.to_le_bytes()
        ],
        bump = proposal.bump
    )]
    pub proposal: Account<'info, Proposal>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct ExecuteUpgrade<'info> {
    /// Execution is permissionless once threshold and delay are satisfied.
    pub executor: Signer<'info>,
    #[account(seeds = [GOVERNANCE_SEED], bump = governance.bump)]
    pub governance: Account<'info, Governance>,
    #[account(
        seeds = [VAULT_SEED, governance.key().as_ref()],
        bump = governance.vault_bump
    )]
    pub vault: Account<'info, GovernanceVault>,
    #[account(
        mut,
        has_one = governance,
        seeds = [
            PROPOSAL_SEED,
            governance.key().as_ref(),
            &proposal.proposal_id.to_le_bytes()
        ],
        bump = proposal.bump
    )]
    pub proposal: Account<'info, Proposal>,
    /// CHECK: key and loader ownership are checked against the approved proposal.
    #[account(mut)]
    pub target_program: UncheckedAccount<'info>,
    /// CHECK: PDA and loader ownership are verified before CPI.
    #[account(mut)]
    pub program_data: UncheckedAccount<'info>,
    /// CHECK: key and loader ownership are checked against the approved proposal;
    /// the upgradeable loader independently enforces that its authority is vault.
    #[account(mut)]
    pub buffer: UncheckedAccount<'info>,
    /// CHECK: constrained to the configured treasury before CPI.
    #[account(mut)]
    pub spill: UncheckedAccount<'info>,
    /// CHECK: fixed sysvar address.
    #[account(address = anchor_lang::solana_program::sysvar::rent::id())]
    pub rent: UncheckedAccount<'info>,
    /// CHECK: fixed sysvar address.
    #[account(address = anchor_lang::solana_program::sysvar::clock::id())]
    pub clock: UncheckedAccount<'info>,
    /// CHECK: fixed upgradeable-loader program id.
    #[account(address = bpf_loader_upgradeable::id())]
    pub loader_program: UncheckedAccount<'info>,
}
