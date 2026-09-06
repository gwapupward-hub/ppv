# PPV Invariants

Each invariant names where it is enforced and where it is tested. An invariant
with no test is an intention.

`agreement.rs` refers to `programs/ppv_escrow/src/state/agreement.rs`;
`tests/escrow.ts` is the local-validator adversarial suite.

## Custody and state

| # | Invariant | Enforced by | Tested by |
| --- | --- | --- | --- |
| 1 | A `Settled` agreement cannot settle again. | `require_settleable` demands `Completed`; `record_settled` is the only writer of `Settled`. | `double_settlement_is_impossible`, "cannot run twice" |
| 2 | A terminal state never returns to an active one. | `Settled`, `Refunded` and `Cancelled` are terminal, and no instruction accepts them. | `every_ending_is_final`, "closes every ending for good" |
| 3 | Only the buyer can fund. | `require_keys_eq!(signer, creator)` in `require_fundable`. | `only_the_buyer_can_fund`, "refuses anyone but the buyer" |
| 4 | Only the seller can mark work complete. | `require_keys_eq!(signer, counterparty)` in `require_completable`. | `completion_requires_funding_and_the_seller`, "refuses the buyer and any outsider" |
| 5 | Settlement pays only the seller. | `seller_token_account.owner == agreement.counterparty` constraint. | "cannot be redirected away from the seller" |
| 6 | Funding debits only the buyer. | `funder_token_account.owner == buyer.key()` constraint, and the buyer signs the transfer. | "refuses a substituted mint, vault, or funding source" |
| 7 | The mint cannot change after initialization. | `has_one = mint` on every custody instruction; `transfer_checked` re-validates inside the token program. | "refuses a substituted mint…" (both funding and settlement) |
| 8 | An agreement id cannot name another creator's agreement. | The creator is in the agreement PDA seeds. | "gives two creators independent namespaces", `escrow-pdas.test.ts` |
| 9 | Every token movement out of escrow corresponds to an authorized transition. | The vault authority is a PDA that signs only inside `settle`, after `require_settleable`. | "refuses a substituted vault, vault authority, or mint", cross-agreement isolation |
| 10 | Custody state is never mistaken for protocol state. | State is written only after the CPI, and the vault balance delta is asserted to equal `amount`. | "does not treat a direct token transfer as funding", "leaves a donated surplus untouched" |
| 11 | An agreement's vault is reachable only through that agreement. | Vault and vault authority seeds both contain the agreement address. | cross-agreement isolation |
| 9a | Normal settlement is impossible while disputed. | Not a separate check: `settle` demands `Completed`, and `Disputed` is not it. | `a_dispute_halts_settlement`, "halts settlement the moment a dispute is opened" |
| 9b | A dispute can only be resolved in the other party's favour. | `require_resolvable` rejects a signer that is also the beneficiary. | `resolution_gives_the_money_to_the_other_party`, "refuses anyone taking the money for themselves" |
| 9c | A refund reaches only the buyer, and only the seller may give it. | Destination owner constraint plus a seller-only signer. | `a_refund_is_the_sellers_to_give`, "refuses a buyer taking its own refund" |
| 9d | Cancellation cannot strand escrowed money. | `cancel` is `Open`-only and takes no token accounts. | `cancellation_is_only_for_an_agreement_nobody_funded`, "refuses cancellation … once money is escrowed" |
| 12g | A milestone from one agreement cannot affect another. | The agreement is in the milestone PDA seeds, and every guard re-checks `milestone.agreement`. | `a_tranche_of_another_agreement_is_unusable_here`, "refuses another agreement's tranche" |
| 12h | A schedule can never promise more than the escrow holds, and a milestone contract cannot be funded until it is fully scheduled. | `record_milestone` caps the running total; `fund` requires `milestone_total == amount`. | `a_schedule_cannot_promise_more_than_the_escrow_holds`, "refuses funding a contract whose schedule does not add up" |
| 12i | Total paid out can never exceed what was escrowed. | `record_payout` caps `settled_total` at `amount`; every payout path pays `remaining()`. | `a_refund_midway_returns_only_what_is_left`, "refunds only what no tranche has earned" |
| 12 | An agreement whose semantics are unimplemented cannot exist. | `agreement_type == Escrow` required at initialization. | "rejects an agreement type the kernel does not implement" |
| 12a | A proof from one agreement cannot be presented for another. | The agreement is in the proof PDA seeds, so the same index under another agreement is another address. | "keeps one agreement's evidence unusable by another", `escrow-pdas.test.ts` |
| 12b | Proof indices are dense, ordered, and assigned by the protocol. | The seed is the agreement's own `proof_count`; a client-chosen index is a seeds failure. | "numbers proofs densely, and refuses a client-chosen index" |
| 12d | A party cannot decide its own evidence. | `require_decidable` rejects the submitter, who is otherwise an authorized party. | `the_other_party_decides_and_the_submitter_cannot`, "refuses a party deciding its own evidence" |
| 12e | A decision is final. | `require_decidable` demands `Submitted`. | `a_decision_is_final`, "makes a decision final" |
| 12f | Settlement can only cite approved evidence of this agreement. | `settle` checks `proof.agreement` and `is_approved()` before any custody moves. | "refuses settlement citing evidence that was not approved", "…another agreement's evidence" |
| 12c | Anchoring evidence changes no state and moves no custody. | `submit_proof` writes only the proof account and the counter. | "anchors evidence to the agreement without moving it" |

## Events and receipts

| # | Invariant | Enforced by | Tested by |
| --- | --- | --- | --- |
| 13 | An event reflects committed state, never an attempt. | `emit_cpi!` runs last, after the CPI and the state write; a failed instruction commits nothing. | "emits nothing when it fails" |
| 14 | An event names the transition it caused. | Every event carries `previous_state` and `new_state`. | event assertions across `tests/escrow.ts`, `escrow-events.test.ts` |
| 15 | A receipt corresponds to an actual protocol transition. | Receipts are projections of committed events plus chain coordinates; nothing else can produce one. | `escrow-receipts.test.ts` |
| 16 | Replay produces identical receipt history. | Receipt ids are a hash of (program id, signature, instruction index, inner index, action). | "a receipt is a pure function…", "out-of-order and duplicated delivery…" |
| 17 | A reconstructed history that does not chain is refused. | `reconstructAgreementLifecycle` verifies each step starts where the previous ended and that settlement matches funding. | "a history that does not chain is refused", "a settlement that disagrees with custody is refused" |
| 17d | A reconstructed milestone schedule must add up to what was funded, and no tranche step may name a tranche that was never created. | `reconstructAgreementLifecycle` checks both. | "a schedule that does not add up to the escrow is refused", "a milestone step for a tranche that was never created is refused" |
| 17c | A reconstructed agreement cannot be both settled and refunded, and a refund must return what was funded. | `reconstructAgreementLifecycle` checks both. | "an agreement cannot be both settled and refunded", "a refund must return exactly what was funded" |
| 17b | A reconstructed settlement cannot cite evidence the history never approved. | `reconstructAgreementLifecycle` resolves the cited proof and its decision. | "a settlement can only cite evidence this history approved" |
| 17a | A fact that is not a transition cannot be read as one. | Receipts carry `kind`; annotations are placed into the history but excluded from the chain walk. | "evidence is recorded as an annotation, not as a transition", "a proof lands in the history where it happened" |
| 18 | An event is identified by (program id, discriminator), never the discriminator alone. | `decodeEventForProgram` selects the decoder from the emitting program. | "an escrow event is never mistaken for a commerce event of the same name" |

## Negotiation (`ppv_commerce`, unchanged by this phase)

| # | Invariant |
| --- | --- |
| 19 | Accepted terms cannot silently mutate; a revision increments the version and clears both signatures. |
| 20 | A signature binds the exact version and hashes the signer saw. |
| 21 | Evidence accounts cannot be closed; revocation adds history rather than erasing it. |

## Invariants deferred with their phases


Each arrives with the instruction that makes it reachable, and with the negative
test that proves it holds. Listing an invariant before its state exists would
document a check nothing performs.
