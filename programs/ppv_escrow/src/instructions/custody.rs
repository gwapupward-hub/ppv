use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::constants::VAULT_AUTHORITY_SEED;
use crate::errors::EscrowError;

/// The one way money leaves a PPV vault.
///
/// Settlement, refund, and dispute resolution differ in who may call them and
/// from which state — never in how custody moves. Routing all three through one
/// function means the PDA signing, the exact-amount rule, and the
/// balance-delta assertion cannot drift apart between paths, and a reviewer
/// checking "can this be redirected or double-spent" has one place to look.
///
/// The caller is responsible for having already established *who* may do this
/// and *whether it is legal now*. This function only moves the money and proves
/// that it moved.
#[allow(clippy::too_many_arguments)]
pub fn pay_out_of_vault<'info>(
    token_program: &Program<'info, Token>,
    vault: &mut Account<'info, TokenAccount>,
    vault_authority: &UncheckedAccount<'info>,
    mint: &Account<'info, Mint>,
    destination: &mut Account<'info, TokenAccount>,
    agreement_key: &Pubkey,
    vault_authority_bump: u8,
    amount: u64,
) -> Result<()> {
    let vault_before = vault.amount;
    let destination_before = destination.amount;

    let signer_seeds: &[&[&[u8]]] = &[&[
        VAULT_AUTHORITY_SEED,
        agreement_key.as_ref(),
        &[vault_authority_bump],
    ]];

    token::transfer_checked(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            TransferChecked {
                from: vault.to_account_info(),
                mint: mint.to_account_info(),
                to: destination.to_account_info(),
                authority: vault_authority.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
        mint.decimals,
    )?;

    // Assert both sides of the movement. An event describing this payment must
    // describe a transfer that actually happened, at the amount the agreement
    // fixed — not the amount the instruction asked for.
    vault.reload()?;
    destination.reload()?;
    let debited = vault_before
        .checked_sub(vault.amount)
        .ok_or(EscrowError::CustodyMismatch)?;
    let credited = destination
        .amount
        .checked_sub(destination_before)
        .ok_or(EscrowError::CustodyMismatch)?;
    require_eq!(debited, amount, EscrowError::CustodyMismatch);
    require_eq!(credited, amount, EscrowError::CustodyMismatch);

    Ok(())
}
