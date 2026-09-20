# Trust boundaries

## Actors

| Actor | Authority | Bound by |
| --- | --- | --- |
| Buyer / creator | funds, cancels, creates milestones, decides milestones, opens disputes, concedes, settles | `agreement.creator`, fixed at initialization |
| Seller / counterparty | marks complete, submits milestones, refunds, opens disputes, concedes, settles | `agreement.counterparty`, fixed at initialization — except a Bounty, assignable exactly once |
| Proof submitter | anchors evidence | must be a party, agreement must be live |
| Proof decider | approves/rejects evidence | must be a party **and not the submitter** |
| Vault authority | moves tokens out of the vault | PDA `["vault", agreement]`; signs only inside `pay_out_of_vault` |
| Upgrade authority | replaces program bytecode | Squads V4 2-of-3 vault, per program |
| Outsider | nothing | every guard is an allowlist, never a denylist |

There is **no arbiter, no admin, no pause authority and no protocol owner** in
`ppv_escrow`. No instruction grants any address privileges over an agreement it
is not a party to.

## The custody boundary

Exactly one function moves value out of a vault:
`programs/ppv_escrow/src/instructions/custody.rs::pay_out_of_vault`.

Settlement, milestone settlement, refund and dispute resolution differ in *who
may call* and *from which state* — never in *how custody moves*. All four route
through this one function, so the PDA signing, the exact-amount rule, and the
balance-delta assertion cannot drift apart between paths.

`pay_out_of_vault` does three things a reviewer should confirm:

1. Signs as `["vault", agreement, bump]` — an authority derived from this
   agreement and no other.
2. Calls `transfer_checked`, so the token program re-validates mint and
   decimals.
3. Reloads both accounts afterward and requires
   `debited == amount && credited == amount`, else `CustodyMismatch`.

An event describing a payment therefore describes a transfer that actually
happened, at the amount the agreement fixed.

## No on-chain Commerce ↔ Escrow binding

**This is the most important disclosure in this package.**

`ppv_commerce` proves that parties agreed to terms. `ppv_escrow` holds value
against an `agreement_id` and a `terms_hash`. **Nothing on chain connects the
two.** There is no CPI, no stored program ID, no cross-program PDA, and no
account field in either program that references the other.

Consequences an auditor must reason about:

* An escrow agreement's `terms_hash` is an opaque 32 bytes to the program. It
  is never compared against a Commerce agreement.
* Any binding between a negotiated Commerce agreement and an escrowed
  `EscrowAgreement` is **off-chain convention only**, maintained by clients and
  indexers.
* A client that escrows against the wrong terms produces a well-formed,
  fully-valid escrow agreement. The kernel cannot detect it.

This is recorded as **RR-4** in `docs/security/ppv-escrow-residual-risk.md` and
is a deliberate architectural position, not an oversight. Do not invent such a
binding when reviewing; the deployed architecture does not provide one.

## Token program trust

Every custody account is typed `Program<'info, Token>` and
`Account<'info, TokenAccount>` — **classic SPL Token only**.

Token-2022 is **outside the current security claim**. It is not partially
supported; a Token-2022 mint is rejected at the type boundary. Two reasons, both
recorded in `Cargo.toml`:

* Transfer-fee and transfer-hook extensions need their own accounting rules. A
  fee-on-transfer mint silently breaks "the vault received exactly the agreed
  amount".
* `spl-token-2022 v3` pulls `solana-zk-token-sdk`, which pins
  `solana-program =1.18.26`; this workspace pins `1.18.17`. The two cannot both
  hold.

The same constraint is why the vault is created by an explicit CPI in
`initialize_agreement` rather than Anchor's `init` + `token::` constraints,
whose codegen names `anchor_spl::token_2022` unconditionally.

## Governance boundary

| | Core / Commerce | Escrow custody |
| --- | --- | --- |
| Squads multisig | — | `GEE6nE9xN4GsHGo8QHvyqNLH7eM7yLBrtFtfsmH9ip46` |
| Vault (upgrade authority) | `B6tcsTrMCKTZV5vi3rRCnA3FMPeeWACSHuuTSz5XQgnX` | `FD2spnsMVgsuddPSRWAe3ee4DMbgDx5ivpvVfvKcNrLE` |
| Threshold | 2-of-3 | 2-of-3 |
| Permissions | — | Initiate + Vote + Execute (mask 7) |
| Time lock | — | 0 |

**Disclosed exception:** exactly **one** signer,
`BJmFM4k7Q32CiCYSdoYkAhXdD5Sk3BegMh2cbEAsgSwJ`, is a member of both the Escrow
custody multisig and Core/Commerce governance.

This is tolerable only because one shared signer cannot reach a 2-of-3
threshold alone. A second shared signer would end that property. The exception
is **scoped to devnet** (`sharedSignerExceptionScope: "devnet"`), is never a
default — the verifier refuses this member set unless `--allow-shared-signers`
is passed — and is asserted as data rather than described in prose so the count
can be checked. See `scripts/test/custody-gate.test.mjs`.
