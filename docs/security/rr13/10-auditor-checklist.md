# Auditor checklist

Ordered by expected value. Items 1–6 are where an independent reviewer is
better placed than the team.

## 1. Dependency advisory status — the team could not check this

Network egress in the preparation environment was scoped to the project
repository. Verify against primary sources, at review time:

`solana-program 1.18.17` · `anchor-lang 0.30.1` · `anchor-spl 0.30.1` ·
`spl-token 4.0.3` · `borsh 0.9.3` · `@solana/web3.js 1.95.8` ·
`@solana/spl-token 0.4.9` · `@sqds/multisig 2.1.4` · Rust 1.85.1 host /
1.75.0 SBF.

Check RustSec, the Anchor and Agave security feeds, and SIMD records for
feature activations that change runtime behaviour since 1.18.17.

## 2. The `ppv_core` CPI boundary under adversarial substitution

The single cross-program call in the protocol, and the least
independently-attacked surface. `submit_proof.rs`. Confirm each defence
actually holds rather than merely being present:

- [ ] `Program<'info, PpvCore>` cannot be satisfied by a non-`ppv_core` executable.
- [ ] `core_proof` address derivation is asserted **before** the CPI and cannot be pre-created at that address by an attacker in a way that changes the outcome.
- [ ] No `with_signer`: escrow signs for no PDA here, so `ppv_core` records the human.
- [ ] `core_event_authority` seeds are computed under `ppv_core::ID`, not escrow's.
- [ ] A `ppv_core` refusal unwinds the `proof_count` increment and the escrow `Proof` account.
- [ ] `Proof.core_proof` cannot be made to name another agreement's core record.
- [ ] A proof naming itself as its own `coreProof` is refused.

## 3. Proof-backed settlement

The path by which evidence becomes money, and the one custody path that is
neither property-tested nor mutation-qualified.

- [ ] `settle` / `settle_milestone`: can a `settlement_proof` from another agreement be accepted? (`proof.agreement` is checked — confirm no bypass.)
- [ ] Can a `Rejected` or `Submitted` proof be cited? (`is_approved()`.)
- [ ] `CannotDecideOwnProof` — can the submitter decide via an intermediary, a second account, or by being both parties?
- [ ] `ProofAlreadyDecided` — is a decision genuinely final under reordering?
- [ ] Optional-account handling: does omitting `settlement_proof` differ from passing a malformed one?

## 4. Cross-feature interaction

Each feature is covered in isolation; combinations are thinner.

- [ ] proof × milestone: a proof cited for a tranche of a different milestone.
- [ ] proof × dispute: proof decisions while `Disputed` (`is_live()` includes it).
- [ ] dispute × milestone: `resolve_dispute` pays `remaining()` from a partly-settled milestone contract — confirm accounting. (Regression exists: `tests/invariants/regression/milestone-dispute-settlement.ts`.)
- [ ] bounty × dispute: dispute before a winner is named.
- [ ] Concurrency: RR-5 states true concurrency is not simulated.

## 5. Re-derive the state machine independently

`LEGAL_EDGES` in `tests/invariants/model.ts` carries eleven edges. Derive the
reachable graph from the program source alone and compare. Specifically:

- [ ] Can a MilestoneContract reach `Completed`? (`mark_completed` refuses it — confirm no other writer.)
- [ ] Is `record_milestone_settled` the only path from `Funded` to `Settled`?
- [ ] Are `Settled`, `Refunded`, `Cancelled` genuinely absorbing against all 17 instructions?

## 6. Custody arithmetic

- [ ] `settled_total` can never exceed `amount` across any interleaving.
- [ ] `milestone_total == amount` at funding, and every tranche settles at most once ⇒ total paid == amount.
- [ ] `remaining()` uses `saturating_sub` — confirm saturation is unreachable rather than merely safe.
- [ ] `pay_out_of_vault`'s delta assertion under a hostile token program (note: `Program<Token>` pins it, so this is a defence-in-depth question).

## 7. Confirm the disclosed positions are as described

- [ ] No on-chain Commerce↔Escrow binding exists (grep both programs for any reference).
- [ ] Token-2022 is rejected, not partially handled.
- [ ] Exactly one shared governance signer, and `overlap < threshold`.
- [ ] No close/realloc instruction; no revival path.
- [ ] No `remaining_accounts` anywhere.
- [ ] No `unsafe` / `unwrap` / `panic!` outside `#[cfg(test)]`.

## 8. Documentation accuracy

The team's own internal review found stale claims in the security
documentation — see [finding-register](finding-register.md) F-01 … F-05. All
five are **resolved**, and each now carries a guard that fails if the claim
drifts again: `scripts/test/escrow-current-state-docs.test.mjs` (widened to
scan `scripts/**/*.mjs` and `**/*.sh`), two new drift tests in
`scripts/test/attack-matrix.test.mjs`, and
`scripts/test/coverage-docs.test.mjs`.

Worth spending a little scepticism here anyway, because this class of defect
is what the guards were written *after*:

- [ ] Pick two attack-matrix rows and confirm the cited test asserts what the row claims — not merely that the test exists.
- [ ] Re-derive `docs/property-testing.md`'s covered column from `ActionKind` yourself and confirm it matches.
- [ ] Confirm the guards' tamper cases fail for the right reason, by restoring one stale sentence locally and watching which test goes red.

## 9. Governance

- [ ] Squads 2-of-3 decodes from chain as declared (RR-7 is closed for the custody multisig; Core/Commerce remains narrowed).
- [ ] The upgrade authority on chain equals `FD2spnsMVgsuddPSRWAe3ee4DMbgDx5ivpvVfvKcNrLE`.
- [ ] Devnet shared-signer exception cannot generalize to a mainnet path.

## 10. Transaction lifecycle

Already covered by `scripts/test/transaction-lifecycle.test.mjs`; confirm the
tests assert what they claim, particularly that an infrastructure failure can
never be recorded as a protocol refusal, and that a landed `err == null` where
refusal was expected is classified a CustodyDefect.
