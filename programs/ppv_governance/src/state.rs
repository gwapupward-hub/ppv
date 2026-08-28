use crate::errors::GovernanceError;
use anchor_lang::prelude::*;

pub const GOVERNANCE_SCHEMA_VERSION: u8 = 1;
pub const MIN_MEMBERS: usize = 2;
pub const MAX_MEMBERS: usize = 8;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum ProposalAction {
    Upgrade {
        program: Pubkey,
        buffer: Pubkey,
    },
    Reconfigure {
        member_count: u8,
        members: [Pubkey; MAX_MEMBERS],
        threshold: u8,
        min_delay_slots: u64,
        proposal_lifetime_slots: u64,
        treasury: Pubkey,
    },
}

#[account]
#[derive(InitSpace)]
pub struct Governance {
    pub schema_version: u8,
    pub bump: u8,
    pub vault_bump: u8,
    pub threshold: u8,
    pub member_count: u8,
    pub members: [Pubkey; MAX_MEMBERS],
    pub next_proposal_id: u64,
    /// Incremented after every successful reconfiguration. Pending proposals
    /// from an older epoch immediately become non-executable.
    pub epoch: u64,
    pub min_delay_slots: u64,
    pub proposal_lifetime_slots: u64,
    /// Receives reclaimed lamports from consumed upgrade buffers.
    pub treasury: Pubkey,
    pub reserved: [u8; 64],
}

impl Governance {
    pub fn validate_config(
        members: &[Pubkey],
        threshold: u8,
        min_delay_slots: u64,
        proposal_lifetime_slots: u64,
        treasury: Pubkey,
    ) -> Result<[Pubkey; MAX_MEMBERS]> {
        require!(
            (MIN_MEMBERS..=MAX_MEMBERS).contains(&members.len()),
            GovernanceError::InvalidMemberCount
        );
        require!(
            threshold >= 2 && usize::from(threshold) <= members.len(),
            GovernanceError::InvalidThreshold
        );
        require!(
            proposal_lifetime_slots > min_delay_slots,
            GovernanceError::InvalidProposalLifetime
        );
        require_keys_neq!(
            treasury,
            Pubkey::default(),
            GovernanceError::InvalidTreasury
        );

        let mut fixed = [Pubkey::default(); MAX_MEMBERS];
        for (index, member) in members.iter().enumerate() {
            require_keys_neq!(*member, Pubkey::default(), GovernanceError::DefaultMember);
            for existing in fixed.iter().take(index) {
                require_keys_neq!(*existing, *member, GovernanceError::DuplicateMember);
            }
            fixed[index] = *member;
        }

        Ok(fixed)
    }

    pub fn member_index(&self, member: Pubkey) -> Option<usize> {
        self.members
            .iter()
            .take(usize::from(self.member_count))
            .position(|candidate| *candidate == member)
    }

    pub fn proposal_deadlines(&self, current_slot: u64) -> Result<(u64, u64)> {
        let execute_after_slot = current_slot
            .checked_add(self.min_delay_slots)
            .ok_or(GovernanceError::ArithmeticOverflow)?;
        let expires_at_slot = current_slot
            .checked_add(self.proposal_lifetime_slots)
            .ok_or(GovernanceError::ArithmeticOverflow)?;
        Ok((execute_after_slot, expires_at_slot))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn apply_config(
        &mut self,
        member_count: u8,
        members: [Pubkey; MAX_MEMBERS],
        threshold: u8,
        min_delay_slots: u64,
        proposal_lifetime_slots: u64,
        treasury: Pubkey,
    ) {
        self.member_count = member_count;
        self.members = members;
        self.threshold = threshold;
        self.min_delay_slots = min_delay_slots;
        self.proposal_lifetime_slots = proposal_lifetime_slots;
        self.treasury = treasury;
    }
}

#[account]
#[derive(InitSpace)]
pub struct GovernanceVault {
    pub bump: u8,
    pub governance: Pubkey,
    pub reserved: [u8; 32],
}

#[account]
#[derive(InitSpace)]
pub struct Proposal {
    pub bump: u8,
    pub governance: Pubkey,
    pub proposer: Pubkey,
    pub proposal_id: u64,
    pub governance_epoch: u64,
    pub created_slot: u64,
    pub execute_after_slot: u64,
    pub expires_at_slot: u64,
    /// One bit per governance member; MAX_MEMBERS is intentionally <= 8.
    pub approvals: u16,
    pub approval_count: u8,
    pub executed: bool,
    pub cancelled: bool,
    pub action: ProposalAction,
    pub reserved: [u8; 32],
}

impl Proposal {
    pub fn assert_active(&self, governance: &Governance, current_slot: u64) -> Result<()> {
        require!(
            !self.executed && !self.cancelled,
            GovernanceError::ProposalNotActive
        );
        require_eq!(
            self.governance_epoch,
            governance.epoch,
            GovernanceError::StaleGovernanceEpoch
        );
        require!(
            current_slot <= self.expires_at_slot,
            GovernanceError::ProposalExpired
        );
        Ok(())
    }

    pub fn assert_executable(&self, governance: &Governance, current_slot: u64) -> Result<()> {
        self.assert_active(governance, current_slot)?;
        require!(
            self.approval_count >= governance.threshold,
            GovernanceError::ThresholdNotMet
        );
        require!(
            current_slot >= self.execute_after_slot,
            GovernanceError::TimelockNotElapsed
        );
        Ok(())
    }

    pub fn approve(&mut self, member_index: usize) -> Result<()> {
        let mask = 1u16
            .checked_shl(member_index as u32)
            .ok_or(GovernanceError::ArithmeticOverflow)?;
        require!(self.approvals & mask == 0, GovernanceError::AlreadyApproved);
        self.approvals |= mask;
        self.approval_count = self
            .approval_count
            .checked_add(1)
            .ok_or(GovernanceError::ArithmeticOverflow)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> Governance {
        let a = Pubkey::new_unique();
        let b = Pubkey::new_unique();
        let members = Governance::validate_config(&[a, b], 2, 5, 50, Pubkey::new_unique()).unwrap();
        Governance {
            schema_version: GOVERNANCE_SCHEMA_VERSION,
            bump: 1,
            vault_bump: 2,
            threshold: 2,
            member_count: 2,
            members,
            next_proposal_id: 0,
            epoch: 0,
            min_delay_slots: 5,
            proposal_lifetime_slots: 50,
            treasury: Pubkey::new_unique(),
            reserved: [0; 64],
        }
    }

    #[test]
    fn rejects_single_key_governance() {
        let member = Pubkey::new_unique();
        assert!(Governance::validate_config(&[member], 1, 0, 10, Pubkey::new_unique()).is_err());
    }

    #[test]
    fn rejects_duplicate_members() {
        let member = Pubkey::new_unique();
        assert!(
            Governance::validate_config(&[member, member], 2, 0, 10, Pubkey::new_unique()).is_err()
        );
    }

    #[test]
    fn duplicate_approval_is_rejected() {
        let governance = config();
        let mut proposal = Proposal {
            bump: 1,
            governance: Pubkey::new_unique(),
            proposer: governance.members[0],
            proposal_id: 0,
            governance_epoch: governance.epoch,
            created_slot: 10,
            execute_after_slot: 15,
            expires_at_slot: 60,
            approvals: 0,
            approval_count: 0,
            executed: false,
            cancelled: false,
            action: ProposalAction::Upgrade {
                program: Pubkey::new_unique(),
                buffer: Pubkey::new_unique(),
            },
            reserved: [0; 32],
        };
        proposal.approve(0).unwrap();
        assert!(proposal.approve(0).is_err());
        assert_eq!(proposal.approval_count, 1);
    }

    #[test]
    fn reconfiguration_epoch_invalidates_old_proposals() {
        let mut governance = config();
        let proposal = Proposal {
            bump: 1,
            governance: Pubkey::new_unique(),
            proposer: governance.members[0],
            proposal_id: 0,
            governance_epoch: governance.epoch,
            created_slot: 10,
            execute_after_slot: 15,
            expires_at_slot: 60,
            approvals: 0b11,
            approval_count: 2,
            executed: false,
            cancelled: false,
            action: ProposalAction::Upgrade {
                program: Pubkey::new_unique(),
                buffer: Pubkey::new_unique(),
            },
            reserved: [0; 32],
        };
        governance.epoch += 1;
        assert!(proposal.assert_executable(&governance, 20).is_err());
    }
}
