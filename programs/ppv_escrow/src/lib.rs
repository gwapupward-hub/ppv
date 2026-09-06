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
pub use state::{AgreementState, AgreementType, DisputeOutcome, MilestoneState, ProofStatus};

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

    /// Adds a tranche to a milestone contract's schedule. Buyer-only and
    /// `Open`-only: the plan is fixed before the money arrives, so the buyer
    /// funds a schedule it has seen in full and the seller knows every tranche
    /// is covered.
    pub fn create_milestone(
        ctx: Context<CreateMilestone>,
        amount: u64,
        terms_hash: [u8; 32],
    ) -> Result<()> {
        instructions::milestone::handle_create_milestone(ctx, amount, terms_hash)
    }

    /// Seller-only. Says a tranche of work is done; moves no money.
    pub fn submit_milestone(ctx: Context<UpdateMilestone>) -> Result<()> {
        instructions::milestone::handle_submit_milestone(ctx)
    }

    /// Buyer-only. Accepts a submitted tranche; moves no money.
    pub fn approve_milestone(ctx: Context<UpdateMilestone>) -> Result<()> {
        instructions::milestone::handle_approve_milestone(ctx)
    }

    /// Buyer-only. Sends a submitted tranche back to `Pending` so the seller
    /// can try again.
    pub fn reject_milestone(ctx: Context<UpdateMilestone>) -> Result<()> {
        instructions::milestone::handle_reject_milestone(ctx)
    }

    /// Releases one approved tranche to the seller. The agreement itself
    /// settles when the last one is paid.
    pub fn settle_milestone(ctx: Context<SettleMilestone>) -> Result<()> {
        instructions::milestone::handle_settle_milestone(ctx)
    }

    /// Abandons an agreement nobody funded. Creator-only, `Open`-only, and it
    /// takes no token accounts because there is nothing to move.
    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        instructions::cancel::handle_cancel(ctx)
    }

    /// Halts the normal settlement path. Either party, over money already
    /// escrowed. Moves nothing; `settle` becomes impossible because it demands
    /// `Completed` and this is not it.
    pub fn open_dispute(ctx: Context<OpenDispute>, reason_hash: [u8; 32]) -> Result<()> {
        instructions::open_dispute::handle_open_dispute(ctx, reason_hash)
    }

    /// Ends a dispute by concession: the signer surrenders its own claim and
    /// the money goes to the other party. No arbiter is consulted because none
    /// is trusted.
    pub fn resolve_dispute(ctx: Context<ResolveDispute>) -> Result<()> {
        instructions::resolve_dispute::handle_resolve_dispute(ctx)
    }

    /// Returns escrowed money to the buyer on the seller's own signature.
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        instructions::refund::handle_refund(ctx)
    }

    /// Records that the other party accepted a piece of evidence. Moves no
    /// money: an approval is a decision about a fact, and settlement remains a
    /// separate instruction with its own gate.
    pub fn approve_proof(ctx: Context<DecideProof>) -> Result<()> {
        instructions::decide_proof::handle_approve_proof(ctx)
    }

    /// Records that the other party refused a piece of evidence. Moves no
    /// money and does not end the agreement — the submitter may anchor more.
    pub fn reject_proof(ctx: Context<DecideProof>) -> Result<()> {
        instructions::decide_proof::handle_reject_proof(ctx)
    }

    /// Anchors a hash of evidence to this agreement. Either party may submit
    /// while the agreement is live. It moves no money and changes no state:
    /// a proof is a fact, and what follows from it is decided separately.
    pub fn submit_proof(
        ctx: Context<SubmitProof>,
        content_hash: [u8; 32],
        metadata_hash: [u8; 32],
    ) -> Result<()> {
        instructions::submit_proof::handle_submit_proof(ctx, content_hash, metadata_hash)
    }
}
