use anchor_lang::prelude::*;
// Imported by short name, not written inline as `ppv_core::program::PpvCore`.
// Anchor's IDL account-resolution codegen takes the *last* path segment of a
// `Program<'info, T>` and emits a bare `T::id()`, so a fully-qualified path
// compiles everywhere except the IDL build — which is the one build this
// program cannot skip. See anchor-syn 0.30.1 `idl/accounts.rs::get_address`.
use ppv_core::program::PpvCore;

use crate::constants::{AGREEMENT_SEED, PROOF_SEED};
use crate::errors::EscrowError;
use crate::events::ProofSubmitted;
use crate::state::{core_proof_id, EscrowAgreement, Proof, ProofStatus, PROOF_SCHEMA_VERSION};

/// Anchoring evidence, across the one program boundary PPV has.
///
/// The commitment is minted in `ppv_core`, which owns the protocol's only proof
/// primitive; this program records what the agreement decided about it. Four
/// questions govern the call, and they are answered here rather than assumed:
///
/// 1. **Which program is called?** `ppv_core::ID`, enforced by the type
///    `Program<'info, PpvCore>`. Not a constant compared in the handler, and
///    never an `UncheckedAccount` the client fills in — that would let a caller
///    choose the executable that ends up owning PPV's proof records.
/// 2. **Which privilege crosses?** The submitter's signature, which already
///    exists on the outer transaction. It is forwarded, not manufactured: this
///    program signs for no PDA here, so `ppv_core` records the human who
///    actually committed rather than an escrow-owned authority.
/// 3. **Which address may the record occupy?** Exactly one, derived below from
///    the agreement and the proof index under `ppv_core`'s id. The client picks
///    nothing.
/// 4. **What happens if `ppv_core` refuses?** The whole transaction unwinds,
///    including the `proof_count` increment and this account. There is no state
///    in which escrow believes a commitment exists that `ppv_core` never wrote.
#[event_cpi]
#[derive(Accounts)]
pub struct SubmitProof<'info> {
    #[account(mut)]
    pub submitter: Signer<'info>,
    #[account(
        mut,
        seeds = [
            AGREEMENT_SEED,
            agreement.creator.as_ref(),
            &agreement.agreement_id.to_le_bytes()
        ],
        bump = agreement.bump,
    )]
    pub agreement: Account<'info, EscrowAgreement>,
    /// The index comes from the agreement's own counter rather than from the
    /// caller, so proof indices are dense and ordered, and two clients racing
    /// to submit cannot silently overwrite or skip one: the loser's
    /// transaction fails on an account that already exists.
    #[account(
        init,
        payer = submitter,
        space = 8 + Proof::INIT_SPACE,
        seeds = [
            PROOF_SEED,
            agreement.key().as_ref(),
            &agreement.proof_count.to_le_bytes()
        ],
        bump
    )]
    pub proof: Account<'info, Proof>,
    /// CHECK: created by `ppv_core` during the CPI, at an address this program
    /// re-derives and asserts before calling. Left unchecked as to type because
    /// it does not exist yet; `ppv_core` owns its layout, and this program
    /// never deserializes another program's account.
    #[account(mut)]
    pub core_proof: UncheckedAccount<'info>,
    /// CHECK: `ppv_core`'s own event-authority PDA, required by its
    /// `#[event_cpi]` accounts. Constrained here as well as there so a wrong
    /// account fails locally, with an error naming this program.
    #[account(
        seeds = [b"__event_authority"],
        bump,
        seeds::program = ppv_core::ID
    )]
    pub core_event_authority: UncheckedAccount<'info>,
    /// The CPI target, pinned by type. This is the line that makes the boundary
    /// safe: without it, "the proof registry" would be whatever program the
    /// client passed.
    pub ppv_core_program: Program<'info, PpvCore>,
    pub system_program: Program<'info, System>,
}

pub fn handle_submit_proof(
    ctx: Context<SubmitProof>,
    content_hash: [u8; 32],
    metadata_hash: [u8; 32],
) -> Result<()> {
    let submitter = ctx.accounts.submitter.key();
    ctx.accounts
        .agreement
        .require_proof_submittable(&submitter)?;
    // Escrow enforces its own rule on the hash even though `ppv_core` enforces
    // the same one. A callee that trusted its caller's validation would inherit
    // every bug of every program that ever calls it, and a caller that trusted
    // its callee's would report success for a transaction that failed.
    require!(
        content_hash.iter().any(|byte| *byte != 0),
        EscrowError::InvalidContentHash
    );

    let now = Clock::get()?.unix_timestamp;
    let agreement_key = ctx.accounts.agreement.key();
    let proof_index = ctx.accounts.agreement.record_proof()?;

    // The address `ppv_core` must use, derived from facts already on chain.
    // Asserted before the CPI, so a mismatch costs an error rather than a
    // proof record filed under an address nothing points at.
    let core_proof_id = core_proof_id(&agreement_key, proof_index);
    let expected_core_proof = Pubkey::find_program_address(
        &[
            ppv_core::PROOF_SEED,
            submitter.as_ref(),
            core_proof_id.as_ref(),
        ],
        &ppv_core::ID,
    )
    .0;
    require_keys_eq!(
        ctx.accounts.core_proof.key(),
        expected_core_proof,
        EscrowError::CoreProofMismatch
    );

    // No `with_signer`. The submitter's signature came in on the outer
    // transaction and propagates through the CPI, so the `authority` on the
    // core record is the wallet that actually made the commitment. Signing as
    // an escrow PDA instead would file every party's evidence under this
    // program, and `revoke_proof` would then be unreachable by its author.
    ppv_core::cpi::create_proof(
        CpiContext::new(
            ctx.accounts.ppv_core_program.to_account_info(),
            ppv_core::cpi::accounts::CreateProof {
                authority: ctx.accounts.submitter.to_account_info(),
                proof: ctx.accounts.core_proof.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                event_authority: ctx.accounts.core_event_authority.to_account_info(),
                program: ctx.accounts.ppv_core_program.to_account_info(),
            },
        ),
        core_proof_id,
        content_hash,
        metadata_hash,
        ppv_core::state::ProofKind::Deliverable,
    )?;

    let proof = &mut ctx.accounts.proof;
    proof.schema_version = PROOF_SCHEMA_VERSION;
    proof.bump = ctx.bumps.proof;
    proof.agreement = agreement_key;
    proof.core_proof = expected_core_proof;
    proof.submitter = submitter;
    proof.proof_index = proof_index;
    proof.status = ProofStatus::Submitted;
    proof.created_at = now;
    proof.decided_at = 0;
    proof.decided_by = Pubkey::default();
    proof.reserved = [0; 32];

    let proof_key = proof.key();
    let agreement = &ctx.accounts.agreement;

    emit_cpi!(ProofSubmitted {
        agreement: agreement_key,
        proof: proof_key,
        core_proof: expected_core_proof,
        creator: agreement.creator,
        counterparty: agreement.counterparty,
        submitter,
        proof_index,
        content_hash,
        metadata_hash,
        agreement_state: agreement.state,
        timestamp: now,
    });

    Ok(())
}
