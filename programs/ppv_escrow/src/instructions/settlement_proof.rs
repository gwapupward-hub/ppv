use anchor_lang::prelude::*;

use crate::errors::EscrowError;
use crate::state::{CoreCommitment, Proof};

/// The evidence check both settlement paths run, in one place.
///
/// `settle` and `settle_milestone` differ in what they pay and when they may be
/// called. They do not differ in what makes a citation valid, and RR13-001 is
/// what happens when that agreement is expressed twice: the two paths carried
/// the same two-line check, and the same missing third one. One function, so
/// the next rule cannot land in one of them.
///
/// A citation is optional. When there is none, there is nothing to validate and
/// nothing to pass — and passing a core record anyway is refused rather than
/// ignored, so no account reaches this program's custody path without a stated
/// reason to be there.
///
/// Returns the cited proof's address, which the caller records on the agreement
/// and names in its event, so the payment and its justification stay one record.
pub fn require_cited_proof<'info>(
    settlement_proof: &Option<Account<'info, Proof>>,
    core_proof: &Option<UncheckedAccount<'info>>,
    agreement_key: &Pubkey,
) -> Result<Option<Pubkey>> {
    match (settlement_proof, core_proof) {
        (None, None) => Ok(None),
        // Citing nothing while presenting a core record is not a harmless
        // extra account: it is a caller asking this program to touch an
        // account it has no rule for.
        (None, Some(_)) => err!(EscrowError::UnexpectedCoreProof),
        // The failure RR13-001 describes, refused structurally: evidence
        // cannot be cited without the commitment it stands on.
        (Some(_), None) => err!(EscrowError::CoreProofRequired),
        (Some(proof), Some(core)) => {
            require_keys_eq!(
                proof.agreement,
                *agreement_key,
                EscrowError::ProofAgreementMismatch
            );
            require!(proof.is_approved(), EscrowError::ProofNotApproved);
            proof.require_live_core_commitment(&load_core_commitment(core)?)?;
            Ok(Some(proof.key()))
        }
    }
}

/// Reads the linked `ppv_core::ProofRecord` without trusting a byte of it.
///
/// This program does not otherwise deserialize another program's account —
/// `submit_proof` deliberately leaves the core record unchecked as to type,
/// because it does not yet exist and its layout is `ppv_core`'s business. Here
/// the layout is unavoidable: the status is the fact custody turns on, and
/// there is no way to learn it except from `ppv_core`'s own bytes.
///
/// So it is read the way `Account<'info, T>` would read it, and the two checks
/// that make that safe are made explicitly rather than inherited:
///
///   * **owner** — `ppv_core::ID`, checked first. Without it, any program could
///     hand over an account whose bytes happen to spell `Active`.
///   * **discriminator** — `ProofRecord::try_deserialize` refuses anything that
///     is not a `ProofRecord`, so another `ppv_core` account type of a
///     compatible size cannot stand in for one.
///
/// It is written out rather than expressed as `Account<'info, ProofRecord>`
/// because that type would pull `ppv_core`'s IDL types into this program's IDL
/// build, which is a build-surface change this remediation has no reason to
/// make. The guarantees are the same ones; they are simply stated here.
fn load_core_commitment(account: &UncheckedAccount<'_>) -> Result<CoreCommitment> {
    let info = account.to_account_info();
    require_keys_eq!(*info.owner, ppv_core::ID, EscrowError::CoreProofMismatch);

    let data = info.try_borrow_data()?;
    let record = ppv_core::state::ProofRecord::try_deserialize(&mut &data[..])
        .map_err(|_| error!(EscrowError::CoreProofMismatch))?;

    Ok(CoreCommitment {
        key: info.key(),
        owner: *info.owner,
        authority: record.authority,
        status: record.status,
    })
}
