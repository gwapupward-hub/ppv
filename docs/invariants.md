# PPV Invariants

Each invariant names where it is enforced and where it is tested. An invariant
with no test is an intention.

`agreement.rs` refers to `programs/ppv_escrow/src/state/agreement.rs`;
`tests/escrow.ts` is the local-validator adversarial suite.

## Custody and state

| # | Invariant | Enforced by | Tested by |
| --- | --- | --- | --- |
| 1 | A `Settled` agreement cannot settle again. | `require_settleable` demands `Completed`; `record_settled` is the only writer of `Settled`. | `double_settlement_is_impossible`, "cannot run twice" |
| 2 | A terminal state never returns to an active one. | Only `Settled` is terminal, and no instruction accepts it. | `a_settled_agreement_cannot_reopen` |
| 3 | Only the buyer can fund. | `require_keys_eq!(signer, creator)` in `require_fundable`. | `only_the_buyer_can_fund`, "refuses anyone but the buyer" |
| 4 | Only the seller can mark work complete. | `require_keys_eq!(signer, counterparty)` in `require_completable`. | `completion_requires_funding_and_the_seller`, "refuses the buyer and any outsider" |
| 5 | Settlement pays only the seller. | `seller_token_account.owner == agreement.counterparty` constraint. | "cannot be redirected away from the seller" |
| 6 | Funding debits only the buyer. | `funder_token_account.owner == buyer.key()` constraint, and the buyer signs the transfer. | "refuses a substituted mint, vault, or funding source" |
| 7 | The mint cannot change after initialization. | `has_one = mint` on every custody instruction; `transfer_checked` re-validates inside the token program. | "refuses a substituted mint…" (both funding and settlement) |
| 8 | An agreement id cannot name another creator's agreement. | The creator is in the agreement PDA seeds. | "gives two creators independent namespaces", `escrow-pdas.test.ts` |
| 9 | Every token movement out of escrow corresponds to an authorized transition. | The vault authority is a PDA that signs only inside `settle`, after `require_settleable`. | "refuses a substituted vault, vault authority, or mint", cross-agreement isolation |
| 10 | Custody state is never mistaken for protocol state. | State is written only after the CPI, and the vault balance delta is asserted to equal `amount`. | "does not treat a direct token transfer as funding", "leaves a donated surplus untouched" |
| 11 | An agreement's vault is reachable only through that agreement. | Vault and vault authority seeds both contain the agreement address. | cross-agreement isolation |
| 12 | An agreement whose semantics are unimplemented cannot exist. | `agreement_type == Escrow` required at initialization. | "rejects an agreement type the kernel does not implement" |
| 12a | A proof from one agreement cannot be presented for another. | The agreement is in the proof PDA seeds, so the same index under another agreement is another address. | "keeps one agreement's evidence unusable by another", `escrow-pdas.test.ts` |
| 12b | Proof indices are dense, ordered, and assigned by the protocol. | The seed is the agreement's own `proof_count`; a client-chosen index is a seeds failure. | "numbers proofs densely, and refuses a client-chosen index" |
| 12c | Anchoring evidence changes no state and moves no custody. | `submit_proof` writes only the proof account and the counter. | "anchors evidence to the agreement without moving it" |

## Events and receipts

| # | Invariant | Enforced by | Tested by |
| --- | --- | --- | --- |
| 13 | An event reflects committed state, never an attempt. | `emit_cpi!` runs last, after the CPI and the state write; a failed instruction commits nothing. | "emits nothing when it fails" |
| 14 | An event names the transition it caused. | Every event carries `previous_state` and `new_state`. | event assertions across `tests/escrow.ts`, `escrow-events.test.ts` |
| 15 | A receipt corresponds to an actual protocol transition. | Receipts are projections of committed events plus chain coordinates; nothing else can produce one. | `escrow-receipts.test.ts` |
| 16 | Replay produces identical receipt history. | Receipt ids are a hash of (program id, signature, instruction index, inner index, action). | "a receipt is a pure function…", "out-of-order and duplicated delivery…" |
| 17 | A reconstructed history that does not chain is refused. | `reconstructAgreementLifecycle` verifies each step starts where the previous ended and that settlement matches funding. | "a history that does not chain is refused", "a settlement that disagrees with custody is refused" |
| 17a | A fact that is not a transition cannot be read as one. | Receipts carry `kind`; annotations are placed into the history but excluded from the chain walk. | "evidence is recorded as an annotation, not as a transition", "a proof lands in the history where it happened" |
| 18 | An event is identified by (program id, discriminator), never the discriminator alone. | `decodeEventForProgram` selects the decoder from the emitting program. | "an escrow event is never mistaken for a commerce event of the same name" |

## Negotiation (`ppv_commerce`, unchanged by this phase)

| # | Invariant |
| --- | --- |
| 19 | Accepted terms cannot silently mutate; a revision increments the version and clears both signatures. |
| 20 | A signature binds the exact version and hashes the signer saw. |
| 21 | Evidence accounts cannot be closed; revocation adds history rather than erasing it. |

## Invariants deferred with their phases

- Normal settlement cannot occur while `Disputed` — Phase 5, when `Disputed`
  exists. Until then, no instruction can produce that state at all.
- A milestone from one agreement cannot affect another — Phase 6.

Each arrives with the instruction that makes it reachable, and with the negative
test that proves it holds. Listing an invariant before its state exists would
document a check nothing performs.
