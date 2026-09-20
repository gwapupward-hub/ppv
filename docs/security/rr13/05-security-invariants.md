# Security invariant matrix

46 documented invariants, extracted from `docs/invariants.md` at the review
commit: 27 custody/state, 6 events/receipts, 3 Commerce, and the 10
property-tested `PPV-P1…PPV-P10`.

## Verification levels

| Level | Meaning |
| --- | --- |
| **UNIT VERIFIED** | `cargo test` host tests over pure state logic |
| **LOCAL VALIDATOR VERIFIED** | executed against a real validator (`tests/escrow.ts`, `tests/integration/`) |
| **PROPERTY VERIFIED** | asserted after *every* action of *every* generated sequence |
| **LIVE DEVNET VERIFIED** | proven against the deployed program, RR-6 evidence |
| **MUTATION QUALIFIED** | breaking the guard is proven to fail a test |
| **NOT VERIFIED** | no test exercises it |

A happy-path test alone never counts as covered. Every row below that claims
coverage has at least one negative or tamper case behind it.

## Summary

| Bucket | Count |
| --- | --- |
| Fully covered | **30** |
| Partially covered | **16** |
| Uncovered | **0** |

"Fully covered" means unit **and** local-validator **and** property **and** live
devnet, at the tiers the invariant admits. "Partially covered" means a tier the
risk warrants is absent — in every case here, the property tier, the mutation
tier, or both.

## Custody and state (27)

| # | Invariant | Implementation | Unit | Local val. | Property | Live devnet | Tamper/mutation | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | A `Settled` agreement cannot settle again | `require_settleable` demands `Completed` | ✓ | ✓ | P3 | ✓ | `terminal` | FULL |
| 2 | A terminal state never returns to an active one | `Settled`/`Refunded`/`Cancelled` accepted by no instruction | ✓ | ✓ | P2 | ✓ | `terminal` | FULL |
| 3 | Only the buyer can fund | `require_fundable` | ✓ | ✓ | ✓ | ✓ | `authorization` | FULL |
| 4 | Only the seller can mark complete | `require_completable` | ✓ | ✓ | ✓ | ✓ | `authorization` | FULL |
| 5 | Settlement pays only the seller | `seller_token_account.owner` constraint | ✓ | ✓ | P4 | ✓ | `destination` | FULL |
| 6 | Funding debits only the buyer | `funder_token_account.owner` constraint | ✓ | ✓ | ✓ | ✓ | `custody` | FULL |
| 7 | The mint cannot change after init | `has_one = mint` + `transfer_checked` | ✓ | ✓ | P7 | ✓ | `custody` | FULL |
| 8 | An id cannot name another creator's agreement | creator in agreement seeds | ✓ | ✓ | P9 | ✓ | `identity` | FULL |
| 9 | Every outflow corresponds to an authorized transition | vault authority signs only in `pay_out_of_vault` | ✓ | ✓ | P1 | ✓ | `custody` | FULL |
| 9a | No normal settlement while disputed | `settle` demands `Completed` | ✓ | ✓ | P10 | ✓ | `state-machine` | FULL |
| 9b | A dispute resolves only in the other party's favour | `CannotConcedeToSelf` | ✓ | ✓ | ✓ | ✓ | `state-machine` | FULL |
| 9c | A refund reaches only the buyer, seller-given | destination owner + seller signer | ✓ | ✓ | ✓ | ✓ | `destination` | FULL |
| 9d | Cancellation cannot strand escrowed money | `Open`-only, no token accounts | ✓ | ✓ | ✓ | ✓ | `state-machine` | FULL |
| 10 | Custody state is never mistaken for protocol state | state written after CPI + delta assertion | ✓ | ✓ | P1 | ✓ | `custody` | FULL |
| 11 | A vault is reachable only through its agreement | agreement in vault + authority seeds | ✓ | ✓ | P5 | ✓ | `identity` | FULL |
| 12 | An unimplemented agreement type cannot exist | type allowlist at init | ✓ | ✓ | — | ✓ | — | **PARTIAL** |
| 12a | A proof of one agreement is unusable for another | agreement in proof seeds; `ProofAgreementMismatch` | ✓ | ✓ | — | ✓ | — | **PARTIAL** |
| 12b | Proof indices are dense, ordered, protocol-assigned | seed is `agreement.proof_count` | ✓ | ✓ | — | ✓ | — | **PARTIAL** |
| 12c | Anchoring evidence moves nothing | `submit_proof` writes proof + counter only | ✓ | ✓ | — | ✓ | — | **PARTIAL** |
| 12d | A party cannot decide its own evidence | `CannotDecideOwnProof` | ✓ | ✓ | — | ✓ | — | **PARTIAL** |
| 12e | A decision is final | `require_decidable` demands `Submitted` | ✓ | ✓ | — | ✓ | — | **PARTIAL** |
| 12f | Settlement cites only approved evidence of this agreement | `proof.agreement` + `is_approved()` | ✓ | ✓ | — | ✓ | — | **PARTIAL** |
| 12g | One agreement's milestone cannot affect another | agreement in milestone seeds | ✓ | ✓ | ✓ | ✓ | `milestone` | FULL |
| 12h | A schedule cannot promise more than the escrow holds | `record_milestone` cap + `fund` equality | ✓ | ✓ | ✓ | ✓ | `milestone-overpay` | FULL |
| 12i | Total paid out never exceeds what was escrowed | `record_payout` caps at `amount` | ✓ | ✓ | P1 | ✓ | `milestone-overpay` | FULL |
| 12j | A bounty's payee is assigned once, by the sponsor | `require_counterparty_assignable` | ✓ | ✓ | ✓ | ✓ | `bounty-winner-replacement` | FULL |
| 12k | Nothing completes/settles/refunds before a payee exists | `has_counterparty()` in every such guard | ✓ | ✓ | ✓ | ✓ | `authorization` | FULL |

## Events and receipts (6)

| # | Invariant | Implementation | Verified at | Status |
| --- | --- | --- | --- | --- |
| 13 | An event reflects committed state, never an attempt | `emit_cpi!` runs last | unit, local validator, live | **PARTIAL** (no property tier) |
| 14 | An event names the transition it caused | `previous_state` / `new_state` on every event | unit, local validator, live | **PARTIAL** |
| 15 | A receipt corresponds to an actual transition | receipts project committed events only | local validator | **PARTIAL** |
| 16 | Replay produces identical receipt history | id = hash(program, sig, ix, inner, action) | local validator, live | **PARTIAL** |
| 17 | A history that does not chain is refused | `reconstructAgreementLifecycle` | local validator, live | **PARTIAL** |
| 18 | An event is identified by (program id, discriminator) | `decodeEventForProgram` | local validator, live | **PARTIAL** |

RR-6 closed the live tier for all nine lifecycle families, with
duplicate-delivery idempotence and reversed-delivery convergence.

## `ppv_commerce` (3)

| # | Invariant | Verified at | Status |
| --- | --- | --- | --- |
| 19 | Accepted terms cannot silently mutate; a revision increments the version and clears both signatures | host unit | **PARTIAL** (no live devnet record) |
| 20 | A signature binds the exact version and hashes the signer saw | host unit | **PARTIAL** |
| 21 | Evidence accounts cannot be closed; revocation adds history | host unit | **PARTIAL** |

## Property-tested invariants `PPV-P1…PPV-P10` (10)

All ten are asserted after **every attempted action** of **every generated
sequence**, valid and invalid, and all ten are mutation-qualified as a suite by
`scripts/mutation-qualify-property.sh`. All ten are **FULL** — within the
model's action space.

| Id | Property |
| --- | --- |
| PPV-P1 | Custody is conserved across the controlled token population |
| PPV-P2 | Terminal finality — `Settled`/`Cancelled` are absorbing |
| PPV-P3 | At most one canonical settlement; the seller is never paid twice |
| PPV-P4 | A settlement may increase only a seller-owned account |
| PPV-P5 | Assets never leave via a substituted vault or authority |
| PPV-P6 | `creator`/`counterparty` are fixed (Bounty's single assignment excepted) |
| PPV-P7 | `agreement.mint` is immutable |
| PPV-P8 | A failed action leaves every observable byte-identical |
| PPV-P9 | Correctly formed accounts in the wrong relationship are refused |
| PPV-P10 | Only legal state edges occur |

**The model's action space excludes the proof lifecycle.**
`tests/invariants/actions.ts` generates thirteen action kinds — `fund`,
`complete`, `settle`, `cancel`, `refund`, `dispute`, `resolve`,
`createMilestone`, `submitMilestone`, `approveMilestone`, `rejectMilestone`,
`settleMilestone`, `selectWinner` — and **no proof action**. So PPV-P1…P10 say
nothing about `submit_proof`, `approve_proof`, `reject_proof`, proof-backed
settlement, or the `ppv_core` CPI. That is the single largest coverage gap and
is detailed in [06-test-and-evidence-map](06-test-and-evidence-map.md).
