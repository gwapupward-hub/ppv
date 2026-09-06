//! PPV escrow kernel — Phase 1.
//!
//! Four instructions and one lifecycle:
//!
//! ```text
//! Open --fund()--> Funded --mark_completed()--> Completed --settle()--> Settled
//! ```
//!
//! Every instruction answers both protocol questions before it does anything:
//! *who* may perform this action, and *is the action legal in the current
//! state*. Authorization alone is not sufficient, and neither is state.
//!
//! Custody lives in a per-agreement vault under a per-agreement authority.
//! There is no global vault authority, so compromising one agreement's
//! derivation reaches exactly one agreement's funds.

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

pub use constants::*;
pub use instructions::*;
pub use state::{AgreementState, AgreementType};

// Build-only placeholder. Run `anchor keys sync` with controlled program
// keypairs before deployment and commit the resulting deployment manifest.
declare_id!("7BECot7zFqH2oCxTu9uLmmwvzQSBtxWro47jMa2MqUdR");

#[program]
pub mod ppv_escrow {
    use super::*;

    /// Creates the agreement and its vault. Custody state starts empty and
    /// protocol state starts `Open`; neither is inferred from the other.
    pub fn initialize_agreement(
        ctx: Context<InitializeAgreement>,
        agreement_id: u64,
        counterparty: Pubkey,
        agreement_type: AgreementType,
        amount: u64,
        terms_hash: [u8; 32],
    ) -> Result<()> {
        instructions::initialize_agreement::handle_initialize_agreement(
            ctx,
            agreement_id,
            counterparty,
            agreement_type,
            amount,
            terms_hash,
        )
    }

    /// Buyer-only, `Open`-only. Moves exactly `agreement.amount` into the
    /// canonical vault, then records the transition.
    pub fn fund(ctx: Context<Fund>) -> Result<()> {
        instructions::fund::handle_fund(ctx)
    }

    /// Seller-only, `Funded`-only. Moves no money.
    pub fn mark_completed(ctx: Context<MarkCompleted>) -> Result<()> {
        instructions::mark_completed::handle_mark_completed(ctx)
    }

    /// Party-triggered, `Completed`-only, seller-destined. `Settled` is
    /// terminal, which is what makes a second settlement impossible.
    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        instructions::settle::handle_settle(ctx)
    }
}
