# PPV Escrow attack matrix

Every security claim this repository makes about `ppv_escrow`, and the
executable evidence for it. A claim with no test is listed as having no test.

**Nothing here authorises a deployment.** `ppv_escrow` is deployed to devnet
and to no other cluster; mainnet is not authorized, and the custody gate in
[deployment-gates.md](../deployment-gates.md) is closed. The readiness verdict is
[**GO**](ppv-escrow-readiness-verdict.md) as of Sprint 3.1 — which authorises a
separately controlled deployment sprint and nothing else. A matrix of passing
rows is not a verdict, and this one is not read as one.

## How to read the evidence column

The distinction matters more than the result, because "verified" means
different things at different levels and the strongest-sounding word is not
always available:

| Level | What it means |
| --- | --- |
| **MODEL VERIFIED** | Asserted on the host against an independent model of the rules, with no validator. Exhaustive where it applies, and blind to token movement, account substitution and CPI. |
| **LOCAL-VALIDATOR VERIFIED** | Asserted against a real deployment of the program on `solana-test-validator`, with real token accounts and real transfers. |
| **STATICALLY VERIFIED** | Asserted about the repository — a workflow, a manifest, a constant — rather than about running code. |
| **NOT COVERED** | No executable evidence. Named here so it appears in the residual-risk register rather than in nobody's list. |

**No row here is LIVE DEVNET VERIFIED**, and the reason has narrowed twice.

The program is deployed, as of 2026-09-15. The custody harness
`scripts/devnet-escrow-custody.mjs` has been run against devnet — run
35465469908 — and its evidence is committed at
`deployments/validation/ppv-escrow-devnet-live-custody-35465469908.json`,
which is what closed **RR-6**. Two of the three conditions this paragraph once
named are therefore met.

The third is not: **no row below is mapped to a transaction in that
evidence.** The run proves nine lifecycle families end-to-end with every vault
at 0 and 43 landed refusals; it does not say which of its transactions
discharges which row here. Until that mapping exists and is checkable, the
correct level for every row below is the one it already carries, and promoting
a row on the strength of "the matrix ran" would be exactly the overclaim this
column exists to prevent.

*Historical note.* This paragraph has read two earlier ways. First:
"`ppv_escrow` is not deployed, so no row is LIVE DEVNET VERIFIED and none can
be." Then, after the deployment: "the harness has not been run against
devnet." Both premises have since become false. The conclusion has survived
both, for a third reason.

## Authorization

| ID | Attack | Invariant | Defence | Evidence | Level | Result |
| --- | --- | --- | --- | --- | --- | --- |
| A-1 | An outsider funds, completes, settles, cancels, refunds, disputes or resolves | PPV-P10 | Every guard names its signer before it looks at state | `lifecycle_model.rs::every_guard_agrees_with_the_stated_rules` (1,008 cells) | MODEL | pass |
| A-2 | The buyer marks the seller's work complete | PPV-P10 | `require_completable` is the seller's alone | `lifecycle_model.rs`, `escrow.ts` "completion" | MODEL + LOCAL-VALIDATOR | pass |
| A-3 | The buyer refunds itself without the seller's consent | PPV-D1 | `require_refundable` is the seller's alone; a buyer must dispute | `lifecycle_model.rs`, `escrow.ts` "refuses a buyer taking its own refund" | MODEL + LOCAL-VALIDATOR | pass |
| A-4 | A non-party opens a dispute over someone else's escrow | PPV-D1 | `require_disputable` requires `is_party` | `lifecycle_model.rs`, `escrow.ts` "refuses a dispute from an outsider" | MODEL + LOCAL-VALIDATOR | pass |
| A-5 | The seller names its own bounty winner | PPV-B1 | `require_counterparty_assignable` is the sponsor's alone | `agreement.rs::a_bounty_names_its_winner_once_and_never_again` | MODEL | pass |
| A-6 | A party decides its own proof | PPV-P10 | `require_decidable` refuses `signer == submitter` | `proof.rs`, `escrow.ts` "proof decisions" | MODEL + LOCAL-VALIDATOR | pass |
| A-7 | An outsider's *valid signature* passes a role-specific gate | PPV-P10 | Roles are compared by address, not by signer presence | `lifecycle_model.rs` (Outsider role, every guard) | MODEL | pass |
| A-8 | The same wallet supplied in two roles | PPV-P6 | `initialize_agreement` refuses `counterparty == creator`; `record_counterparty` repeats it | `agreement.rs`, `escrow.ts` "initialization" | MODEL + LOCAL-VALIDATOR | pass |

## State machine and terminal finality

| ID | Attack | Invariant | Defence | Evidence | Level | Result |
| --- | --- | --- | --- | --- | --- | --- |
| S-1 | Any instruction against a `Settled`, `Cancelled` or `Refunded` agreement | PPV-P2 | Every guard requires a non-terminal state | `lifecycle_model.rs::no_guard_admits_a_terminal_state` | MODEL | pass |
| S-2 | Settle twice | PPV-P3 | `Settled` is terminal and `require_settleable` demands `Completed` | `lifecycle_model.rs`, property suite PPV-P3, `escrow.ts` | MODEL + LOCAL-VALIDATOR | pass |
| S-3 | Refund twice, or refund after settlement | PPV-D5 | `Refunded` is terminal; `require_refundable` demands `Funded`/`Completed` | property suite (`refund` action), `escrow.ts` "closes every ending for good" | LOCAL-VALIDATOR | pass |
| S-4 | Settle while disputed | PPV-D2 | `settle` demands `Completed`, and `Disputed` is not it | property suite, `escrow.ts` "halts settlement the moment a dispute is opened" | LOCAL-VALIDATOR | pass |
| S-5 | Resolve a dispute twice | PPV-D5 | Resolution lands in a terminal state | `escrow.ts` "refuses a second resolution" | LOCAL-VALIDATOR | pass |
| S-6 | Fund twice | PPV-P1 | `require_fundable` demands `Open` | `lifecycle_model.rs`, property suite | MODEL + LOCAL-VALIDATOR | pass |
| S-7 | Cancel after funding, to skip the refund path | PPV-P1 | `require_cancellable` demands `Open`; `cancel` takes no token accounts at all | `lifecycle_model.rs`, `escrow.ts` | MODEL + LOCAL-VALIDATOR | pass |
| S-8 | An illegal lifecycle edge the model does not list | PPV-P10 | `LEGAL_EDGES` is checked after every attempted action | property suite `assertions.ts` | LOCAL-VALIDATOR | pass |
| S-9 | Dispute an unclaimed bounty to reach a state with no exit | PPV-D1 | **Fixed in this sprint.** `require_disputable` and `require_resolvable` now require a payee | `agreement.rs::an_unclaimed_bounty_cannot_be_disputed_into_a_dead_end` | MODEL | pass (was a finding) |

## Custody conservation and accounting

| ID | Attack | Invariant | Defence | Evidence | Level | Result |
| --- | --- | --- | --- | --- | --- | --- |
| C-1 | Total tokens change across a sequence | PPV-P1 | Conservation is measured against a baseline taken once, after minting | property suite `assertions.ts` PPV-P1 | LOCAL-VALIDATOR | pass |
| C-2 | Pay out more than was funded | PPV-P1 | `record_payout` checks `total <= amount` before writing | `lifecycle_model.rs::no_sequence_of_payouts_can_exceed_the_funded_amount` | MODEL | pass |
| C-3 | A refused payout corrupts the books | PPV-P1 | **Fixed in this sprint.** Compute, check, then write | `lifecycle_model.rs` (same test), `a_refused_milestone_settlement_advances_neither_counter` | MODEL | pass (was a finding) |
| C-4 | Overflow `settled_total` or `milestone_total` to wrap past the cap | PPV-P1 | `checked_add`, and the cap is checked on the computed value | `lifecycle_model.rs` overflow assertions | MODEL | pass |
| C-5 | A transfer that moves an amount other than the one agreed | PPV-P1 | `pay_out_of_vault` re-reads both sides and requires the exact delta | `custody.rs`, property suite balance assertions | LOCAL-VALIDATOR | pass |
| C-6 | Fund with less than the agreed amount | PPV-P1 | `fund` re-reads the vault and requires the exact credit | `fund.rs`, `escrow.ts` "funding" | LOCAL-VALIDATOR | pass |
| C-7 | Zero or negative amounts | PPV-P1 | `initialize_agreement` requires `amount > 0`; `create_milestone` likewise | `escrow.ts` "initialization" | LOCAL-VALIDATOR | pass |
| C-8 | Value stranded with no recovery path | PPV-P1 | See S-9; the remaining stranding case is a donation to the vault | — | **NOT COVERED** | see residual risk RR-3 |

## Destination and account substitution

| ID | Attack | Invariant | Defence | Evidence | Level | Result |
| --- | --- | --- | --- | --- | --- | --- |
| D-1 | Settle to the attacker's token account | PPV-P4 | `seller_token_account.owner == agreement.counterparty` | property suite (`destination` variants), `escrow.ts` | LOCAL-VALIDATOR | pass |
| D-2 | Refund to a token account the buyer does not own | PPV-D4 | `buyer_token_account.owner == agreement.creator` | property suite (`refund` action), `escrow.ts` "a redirected one" | LOCAL-VALIDATOR | pass |
| D-3 | Resolve a dispute to a third party | PPV-D4 | Handler requires `is_party(destination.owner)` | property suite (`resolve` action), `escrow.ts` "refuses anyone taking the money" | LOCAL-VALIDATOR | pass |
| D-4 | Concede a dispute to yourself | PPV-D4 | `require_resolvable` requires `signer != beneficiary` | `lifecycle_model.rs::a_dispute_can_only_be_conceded_between_two_real_parties` (all role pairs) | MODEL + LOCAL-VALIDATOR | pass |
| D-5 | Present a wrong-mint token account of the right owner | PPV-P7 | `mint == agreement.mint` on every token account, plus `transfer_checked` | property suite (`*WrongMint` variants) | LOCAL-VALIDATOR | pass |
| D-6 | Substitute another agreement's vault | PPV-P5 | `seeds = [VAULT_TOKEN_SEED, agreement.key()]` with the stored bump | property suite (`vault: otherAgreement`) | LOCAL-VALIDATOR | pass |
| D-7 | Present an attacker-owned token account as the vault | PPV-P5 | Same seeds constraint; a non-PDA cannot satisfy it | property suite (`vault: fake`) | LOCAL-VALIDATOR | pass |
| D-8 | Sign the transfer with another agreement's vault authority | PPV-P5 | `seeds = [VAULT_AUTHORITY_SEED, agreement.key()]` | property suite (`vaultAuthority: otherAgreement`) | LOCAL-VALIDATOR | pass |
| D-9 | Act on an unrelated agreement account | PPV-P9 | Agreement PDA re-derived from its own stored creator and id | property suite (`agreement: unrelated`), `escrow.ts` "cross-agreement isolation" | LOCAL-VALIDATOR | pass |
| D-10 | Present another agreement's milestone or proof | PPV-P9 | `require_belongs_to` / `proof.agreement` equality, plus PDA seeds | `milestone.rs`, `settle.rs`, `escrow.ts` | MODEL + LOCAL-VALIDATOR | pass |
| D-11 | Substitute the token program | PPV-P5 | `Program<'info, Token>` pins it by type | `settle.rs` and every custody instruction | STATICALLY VERIFIED | pass |
| D-12 | Block an agreement by pre-funding its vault address with one lamport | PPV-P1 | `create_vault` allocates and assigns rather than creating, when lamports exist | `initialize_agreement.rs`, `escrow.ts` "initialization" | LOCAL-VALIDATOR | pass |

## Milestones

| ID | Attack | Invariant | Defence | Evidence | Level | Result |
| --- | --- | --- | --- | --- | --- | --- |
| M-1 | Schedule more than the escrow will hold | PPV-M1 | `record_milestone` checks `total <= amount` before writing | `lifecycle_model.rs::a_milestone_schedule_cannot_promise_more_than_the_escrow` | MODEL | pass |
| M-2 | Fund a partly-scheduled contract | PPV-M1 | `fund` requires `milestone_total == amount` | `fund.rs`, `escrow.ts` "milestones" | LOCAL-VALIDATOR | pass |
| M-3 | Release a milestone twice | PPV-M3 | `require_settleable` demands `Approved`; settling moves it to `Settled` | `milestone.rs`, `escrow.ts` | MODEL + LOCAL-VALIDATOR | pass |
| M-4 | Release a milestone that was never approved | PPV-M3 | Same guard | `lifecycle_model.rs`, `escrow.ts` | MODEL + LOCAL-VALIDATOR | pass |
| M-5 | Release a tranche larger than what the vault still owes | PPV-M2 | `settle_milestone` requires `amount <= remaining()` | `milestone.rs`, `lifecycle_model.rs::a_refused_milestone_settlement_advances_neither_counter` | MODEL | pass |
| M-6 | Redirect a milestone payment | PPV-M4 | `seller_token_account.owner == agreement.counterparty` | `milestone.rs`, `escrow.ts` | LOCAL-VALIDATOR | pass |
| M-7 | Release after the agreement settled or refunded | PPV-M5 | `require_milestone_active` demands `Funded` | `lifecycle_model.rs`, `escrow.ts` | MODEL + LOCAL-VALIDATOR | pass |
| M-8 | Add a milestone after funding | PPV-M1 | `require_milestone_creatable` demands `Open` | `lifecycle_model.rs` | MODEL | pass |
| M-9 | Milestone ordering: release tranche 2 before tranche 1 | PPV-M3 | **By design, tranches are independent** — each has its own approval, and order is not constrained | property suite (generated tranche order) | LOCAL-VALIDATOR | pass; see RR-2 |
| M-10 | Randomized adversarial attack on the milestone lifecycle | PPV-M1…M5 | — | property suite: 315 milestone sequences, 4,998 tranche actions, 169 releases, 348 duplicate-release attempts, 362 foreign-account attempts, 1,185 post-terminal attempts | LOCAL-VALIDATOR | pass (RR-1 closed) |
| M-11 | A settled milestone contract with every tranche unreleased | PPV-M5 | **Intended.** `resolve_dispute` and `refund` pay the remaining balance and terminate whatever the tranche state says; `require_milestone_active` then refuses every release | `regression/milestone-dispute-settlement.ts` | LOCAL-VALIDATOR | pass; see RR-2 |

## Bounties

| ID | Attack | Invariant | Defence | Evidence | Level | Result |
| --- | --- | --- | --- | --- | --- | --- |
| B-1 | Replace a bounty winner after selection | PPV-B1 | `require_counterparty_assignable` refuses an assigned payee | `agreement.rs`, `escrow.ts` "bounties" | MODEL + LOCAL-VALIDATOR | pass |
| B-2 | Name the sponsor itself as winner | PPV-B1 | `record_counterparty` refuses `winner == creator` | `agreement.rs` | MODEL | pass |
| B-3 | Name the default address as winner | PPV-B1 | `record_counterparty` refuses `Pubkey::default()` | `agreement.rs` | MODEL | pass |
| B-4 | Pay a bounty before a winner exists | PPV-B3 | `require_settleable`/`require_refundable`/`require_completable` all require a payee | `lifecycle_model.rs` (no-payee configurations) | MODEL | pass |
| B-5 | Reach a payout path on an unclaimed bounty via the dispute route | PPV-B3 | **Fixed in this sprint** — see S-9 | `agreement.rs::an_unclaimed_bounty_cannot_be_disputed_into_a_dead_end` | MODEL | pass (was a finding) |
| B-6 | Pay a bounty twice | PPV-B2 | Settlement is terminal | `lifecycle_model.rs`, property suite | MODEL + LOCAL-VALIDATOR | pass |
| B-7 | Randomized adversarial attack on the bounty lifecycle | PPV-B1…B4 | — | property suite: 323 bounty sequences, 5,577 bounty actions, 306 winner selections, 1,081 replacement attempts, 144 payout attempts with no winner | LOCAL-VALIDATOR | pass (RR-1 closed) |

## Cross-program

| ID | Attack | Invariant | Defence | Evidence | Level | Result |
| --- | --- | --- | --- | --- | --- | --- |
| X-1 | Direct the proof CPI at a program that is not `ppv_core` | PPV-X4 | `Program<'info, PpvCore>` pins the callee by type | `submit_proof.rs` | STATICALLY VERIFIED | pass |
| X-2 | Have `ppv_core` file the record at a client-chosen address | PPV-X4 | Escrow derives `core_proof_id` from the agreement and index and asserts the address before the CPI | `submit_proof.rs`, `escrow.ts` "proofs" | LOCAL-VALIDATOR | pass |
| X-3 | Present another program's account where an escrow account is expected | PPV-X4 | Anchor's `Account<T>` checks owner and discriminator | `escrow.ts`, `tests/integration/core-commerce.ts` | LOCAL-VALIDATOR | pass |
| X-4 | Discriminator collision between PPV programs' events | PPV-X4 | Event names were made distinct; asserted | `events/mod.rs::the_renamed_events_no_longer_collide_with_ppv_commerce` | MODEL | pass |
| X-5 | Attribute an escrow event to Core or Commerce | PPV-X4 | `extractPpvEvents` decodes for the emitting program id | `indexer/test/extract-ppv.test.ts` | MODEL | pass |
| X-6 | Bind escrow custody to the wrong Commerce agreement | PPV-X1 | **No such binding exists.** `ppv_escrow` does not reference `ppv_commerce` at all | — | **NOT APPLICABLE** | see residual risk RR-4 |
| X-7 | Party or terms mismatch against an upstream Commerce agreement | PPV-X2, PPV-X3 | Same — escrow carries its own parties and its own `terms_hash` | — | **NOT APPLICABLE** | see residual risk RR-4 |

## Replay, duplication and ordering

| ID | Attack | Invariant | Defence | Evidence | Level | Result |
| --- | --- | --- | --- | --- | --- | --- |
| R-1 | The same value-moving instruction submitted twice | PPV-R1 | The second attempt meets a state that refuses it | property suite (repeated actions in generated sequences) | LOCAL-VALIDATOR | pass |
| R-2 | Complete versus cancel, settle versus dispute, refund versus settle | PPV-R2 | Exactly one ordering is legal from any state; the loser is refused | property suite (both orderings arise from generation) | LOCAL-VALIDATOR | pass |
| R-3 | Two proofs racing for the same index | PPV-R1 | The index comes from the agreement counter; the loser's `init` fails on an existing account | `submit_proof.rs` | STATICALLY VERIFIED | pass |
| R-4 | A failed transaction leaves partial state | PPV-P8 | Anchor unwinds; asserted after every refused action | property suite `assertions.ts` PPV-P8 | LOCAL-VALIDATOR | pass |
| R-5 | True concurrency (two transactions in one slot) | PPV-R2 | Solana serialises writes to the same account | — | **NOT COVERED** | see residual risk RR-5 |

## Events and indexing

| ID | Attack | Invariant | Defence | Evidence | Level | Result |
| --- | --- | --- | --- | --- | --- | --- |
| E-1 | An event describes a transfer that did not happen | PPV-P1 | `pay_out_of_vault` asserts both balance deltas before the event is emitted | `custody.rs` | STATICALLY VERIFIED | pass |
| E-2 | A failed transaction contributes to protocol history | PPV-P8 | Inner instructions of a failed transaction are not committed | `tests/integration/core-commerce.ts` | LOCAL-VALIDATOR | pass |
| E-3 | An "event" emitted without the program's own event authority | PPV-X4 | `#[event_cpi]` requires the program's `__event_authority` PDA as signer | `tests/integration/core-commerce.ts` | LOCAL-VALIDATOR | pass |
| E-4 | Duplicate or reordered delivery changes the reconstruction | PPV-R1 | Reconstruction is keyed by account and idempotent | `tests/integration/core-commerce.ts`, `escrow.ts` "chain-data reconstruction" | LOCAL-VALIDATOR | pass |
| E-5 | Escrow-specific reconstruction of milestone, refund, dispute and bounty history | PPV-R1 | Reconstructed live from chain for all nine lifecycle families, twice and in reverse delivery order, each agreeing with the live account state | `deployments/validation/ppv-escrow-devnet-live-custody-35465469908.json`, `scripts/test/custody-recovery.test.mjs` | LOCAL-VALIDATOR | pass — **RR-6 CLOSED** |

## Deployment surface

| ID | Attack | Invariant | Defence | Evidence | Level | Result |
| --- | --- | --- | --- | --- | --- | --- |
| G-1 | Deploy `ppv_escrow` to devnet outside the frozen checks | custody gate | Escrow **is** a workflow program choice, and is selectable only alongside the full set of frozen identity and governance checks | `scripts/test/custody-gate.test.mjs` "escrow is selectable only alongside the full set of frozen checks" | STATICALLY VERIFIED | pass |
| G-2 | Write an escrow release record that disagrees with chain | provenance | Every committed record must satisfy the verifier, and its built, on-chain and recorded binary hashes must be equal | `scripts/test/deployed-program.test.mjs` "every committed release record is one the verifier accepts" | STATICALLY VERIFIED | pass |
| G-3 | Escrow's `[programs.devnet]` id disagrees with source or tooling | identity | Present in both `Anchor.toml` sections, and asserted equal to `declare_id!` and to `identity.mjs` | `scripts/test/custody-gate.test.mjs` "every committed identity source names the permanent id" | STATICALLY VERIFIED | pass |
| G-4 | A permanent escrow identity appears in one source and not another | identity | All committed sources name the same permanent id; the build-only placeholder is asserted absent from every identity and deploy path | `scripts/test/custody-gate.test.mjs` "the build-only placeholder is gone from every identity and deploy path" | STATICALLY VERIFIED | pass |
| G-5 | A "2-of-3" authority whose members repeat | governance | Evidence collection refuses duplicate members and a vault listed as its own member | `scripts/test/deployed-program.test.mjs` | STATICALLY VERIFIED | pass (was a finding) |
| G-6 | An on-curve wallet as upgrade authority | governance | Refused before a record is written | `collect-deployment-evidence.mjs`, `deployed-program.test.mjs` | STATICALLY VERIFIED | pass |
| G-7 | Mainnet as a target | mainnet block | Every live path refuses a genesis that is not devnet's, and refuses mainnet by name first | `deployed-program.test.mjs` "mainnet is refused outright" | STATICALLY VERIFIED | pass |
| G-8a | The declared **Escrow custody** Squads threshold does not match the on-chain multisig | governance | `scripts/lib/squads.mjs` decodes the Squads V4 `Multisig` account and `verify-custody-governance.mjs --live-squads` compares the decoded account against the declared configuration; it has been run against `GEE6nE9x…` and agreed on program, threshold 2, the exact 3 members, mask 7 each, vault index 0 and time lock 0 | `scripts/test/squads-decode.test.mjs`, `scripts/test/custody-governance.test.mjs`, RR-7 | STATICALLY VERIFIED | pass — **RR-7 CLOSED for the custody multisig** |
| G-8b | The declared **Core/Commerce** Squads threshold does not match the on-chain multisig | governance | — | — | **NOT COVERED** | RR-7, narrowed to Core/Commerce governance |
| G-9 | The custody gate opens on a deployment or a custody pass | custody gate | The gate is asserted CLOSED independently of any deployment or custody result; RR-13 and legal review are its remaining requirements | `scripts/test/custody-gate.test.mjs`, `scripts/test/custody-operator-docs.test.mjs` | STATICALLY VERIFIED | pass |

## Does the suite detect real defects?

A matrix of passing tests is worth what the tests would catch. Two harnesses ask
that question of the two layers, because an answer about one says nothing about
the other.

**The host model** — `./scripts/mutation-qualify.sh` breaks one defence at a
time and requires the host suite to fail:

| Mutation | Class | Detected by |
| --- | --- | --- |
| any signer may open a dispute | authorization | `a_dispute_halts_settlement`, `every_guard_agrees_with_the_stated_rules` |
| `settled_total` may exceed the funded amount | custody conservation | `no_sequence_of_payouts_can_exceed_the_funded_amount` and two others |
| a party may concede to itself | destination binding | `a_dispute_can_only_be_conceded_between_two_real_parties` |
| `Settled` stops reporting itself terminal | terminal finality | `no_guard_admits_a_terminal_state`, `every_ending_is_final` |
| the default address counts as a party | party identity | `an_unclaimed_bounty_cannot_be_disputed_into_a_dead_end` |
| a schedule may promise more than the escrow | milestone allocation | `a_milestone_schedule_cannot_promise_more_than_the_escrow` |
| settlement no longer requires `Completed` | state-machine legality | `double_settlement_is_impossible` and two others |

**The randomized property suite** — `./scripts/mutation-qualify-property.sh`,
pinned to `tests/invariants/**/*.invariant.ts` so no deterministic test can be
what noticed:

| Mutation | Class | Seed | First violation | Minimized counterexample |
| --- | --- | --- | --- | --- |
| an already-settled tranche may be released again | milestone lifecycle finality (PPV-M3) | 20260912 | PPV-MODEL | `settleMilestone(second)` after it had settled |
| a tranche may be paid to any account of the right mint | destination binding (PPV-M4 / PPV-P4) | 20260912 | PPV-MODEL | `settleMilestone(second) [destination=attacker]` |
| a tranche pays out everything the vault still owes | custody conservation (PPV-P1 / PPV-M2) | 20260912 | PPV-MODEL | a second release after a canonical one |
| a bounty sponsor may replace the winner after naming one | bounty lifecycle finality (PPV-B1) | 20260912 | PPV-MODEL | `selectWinner` twice |

All eleven detected. Two of the property mutations survived their first run, and
the cause was the generator rather than the assertions — see RR-1 and RR-8 in
the [residual-risk register](ppv-escrow-residual-risk.md). No mutation was made
easier and no assertion weakened to close them.

## Token program scope

**Classic SPL Token only.** `TOKEN-2022 = OUT OF CURRENT SECURITY CLAIM`.

Every custody instruction pins `Program<'info, Token>`, which is the classic
token program and nothing else. `initialize_agreement` creates the vault by
hand specifically to avoid `anchor_spl::token_2022` entering the dependency
tree. A Token-2022 mint cannot be used with this program, and no claim is made
about transfer fees, transfer hooks, confidential transfers, or any other
extension.
