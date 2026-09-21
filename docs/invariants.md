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
| 12j | A bounty's payee can be assigned once and never reassigned, and only by the sponsor. | `require_counterparty_assignable` refuses an agreement that already has one. | `a_bounty_names_its_winner_once_and_never_again`, "names a winner once and never again" |
| 12k | Nothing can be completed, settled or refunded before a payee exists. | Every such guard requires `has_counterparty()`. | `a_bounty_names_its_winner_once_and_never_again`, "pays nobody until a winner is named" |
| 12 | An agreement whose semantics are unimplemented cannot exist. | `initialize_agreement` accepts only `Escrow`, `MilestoneContract` and `Bounty`; `Invoice`, `Contract` and `ProofOnly` are refused with `UnsupportedAgreementType`. | "rejects an agreement type the kernel does not implement" |
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

## Property-tested protocol invariants (`PPV-P1` … `PPV-P10`)

The invariants above are each pinned by a fixed test. The ones below are pinned
by a *property*: an independent reference model plays the same instruction
sequences the chain does, and every invariant is asserted after every attempted
action — successful or refused. The harness lives in `tests/invariants/` and is
run by `scripts/verify-invariants.sh`; `docs/property-testing.md` describes the
architecture, budgets, seeds and limits.

Scope of this harness is ordinary `AgreementType::Escrow` and four
instructions — `fund`, `mark_completed`, `settle`, `cancel` — attacked by a
buyer, a seller and an outsider. Nothing here claims coverage of disputes,
refunds, milestones, bounties, proofs, migrations, Marketplace composition,
Token-2022 extensions or fee math.

`model` is the rule in `tests/invariants/model.ts`, written from this document
and `state-machines.md` rather than transcribed from the program. `observed` is
what `tests/invariants/snapshots.ts` reads back from the validator. `generated`
is the coverage `tests/invariants/generators.ts` produces.

| # | Invariant | Independent model rule | Chain observation | Generator coverage | Deterministic counterpart |
| --- | --- | --- | --- | --- | --- |
| PPV-P1 | Custody is conserved across the controlled token population. Setup minting is the only creation of value, and the baseline is taken once it is finished. | Balances move only on a transition the model itself accepted. | Buyer, seller, attacker and outsider token accounts, this agreement's vault, the unrelated agreement's vault and the substituted "fake vault", summed at one commitment, plus the balances retired with finished sequences. | Every action, valid and invalid, including every substituted source and destination. | Invariant 10, `tests/escrow.ts` "leaves a donated surplus untouched" |
| PPV-P2 | Terminal finality: once `Settled` or `Cancelled`, no later action causes a lifecycle transition, and every economic observable is unchanged. | `settled` and `cancelled` are absorbing; `predict` refuses every action from them. | Decoded `AgreementState` plus the full economic fingerprint, before and after. | Sequences continue for their full budget after reaching a terminal state; the suite asserts a floor of post-terminal attempts. | Invariant 2, `every_ending_is_final` |
| PPV-P3 | One agreement, at most one canonical settlement; the seller is never paid twice. | `settlementCount` increments only on an accepted `settle`, reachable only from `completed`. | `settled_total` against `amount`, and the count of settlements the harness itself executed. | `settle` is generated repeatedly, including after settlement and after cancellation. | Invariant 1, `double_settlement_is_impossible`, `regression/settlement-state-gate.ts` |
| PPV-P4 | A successful settlement may increase only a token account owned by the canonical seller. | `predict` accepts `settle` only with `destination = seller`. | Seller balance delta equals `amount`; buyer, attacker and outsider balances unchanged. | `destination` is drawn from seller, buyer, attacker, an unrelated wallet, and a seller-owned account of the *wrong* mint. | Invariant 5, "cannot be redirected away from the seller" |
| PPV-P5 | Escrow assets never leave through a substituted vault or a substituted authority. | Any non-canonical `vault` or `vaultAuthority` is refused outright. | The canonical vault balance, the unrelated agreement's vault, and an attacker-owned token account presented as a vault. | `vault` ∈ {canonical, another agreement's vault, a non-PDA token account}; `vaultAuthority` ∈ {canonical, another agreement's authority}. | Invariants 9 and 11, "refuses a substituted vault, vault authority, or mint" |
| PPV-P6 | For an ordinary escrow, `creator == initialBuyer` and `counterparty == initialSeller` after every operation. Not applicable unchanged to `Bounty`, whose counterparty is intentionally assignable exactly once. | The model's `buyer` and `seller` are fixed at construction and never written. | Decoded `creator` and `counterparty` compared with the values initialization recorded. | Asserted after every action of every sequence. | Invariant 12j (bounty's deliberate exception), `a_bounty_names_its_winner_once_and_never_again` |
| PPV-P7 | `agreement.mint` equals the mint it was initialized with, forever. | The model's `mint` is fixed at construction. | Decoded `mint` compared with the initialized mint. | Every custody action is generated with the agreement's mint and with an unrelated mint of the same decimals. | Invariant 7, "refuses a substituted mint…" |
| PPV-P8 | A failed action leaves every economically or semantically relevant observable byte-identical. | A refused action produces no model transition. | The raw agreement account, every token balance in the population, and the unrelated agreement's raw account, compared before and after. | Most generated actions fail; each one is an atomicity case. | Invariant 13, "emits nothing when it fails" |
| PPV-P9 | Correctly formed accounts in the wrong relationship are refused, and the unrelated agreement is never reachable. | Any non-canonical account for the instruction is refused. | The unrelated agreement's raw account and vault balance must be identical after every action. | Agreement A with vault B, agreement A with a wrong mint, a destination owned by the attacker, buyer/seller role substitution, and an unrelated agreement PDA. | Invariants 8, 11, 12a, 12g; cross-agreement isolation in `tests/escrow.ts` |
| PPV-P10 | The only legal successful edges are the eleven in `LEGAL_EDGES`: `Open → Funded`, `Open → Cancelled`, `Funded → Completed`, `Completed → Settled`, `Funded → Settled` (a milestone contract's last tranche, which never passes through `Completed`), `Funded → Refunded`, `Completed → Refunded`, `Funded → Disputed`, `Completed → Disputed`, `Disputed → Settled`, `Disputed → Refunded`. | `LEGAL_EDGES` in `model.ts` is the whole table. | Decoded state before and after; any change must correspond to an accepted action and a listed edge. | Every instruction is generated from every reachable state, by every actor. | Invariants 2 and 9a, `docs/state-machines.md` |

Receipts are deliberately *not* modelled here as an on-chain account. PPV
receipts are projections reconstructed from committed events (Invariants 15–17),
so the property this harness carries is the protocol fact underneath them: one
agreement admits at most one canonical settlement transition, and no history can
represent two. Receipt and indexer coverage belongs in PPV's own replay
architecture (`sdk/src/escrow/receipts.ts`, `scripts/replay-agreement.mts`), not
in an invented settlement account.

## Invariants deferred with their phases


Each arrives with the instruction that makes it reachable, and with the negative
test that proves it holds. Listing an invariant before its state exists would
document a check nothing performs.
