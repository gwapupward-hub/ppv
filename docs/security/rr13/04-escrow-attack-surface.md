# `ppv_escrow` attack surface — every instruction

Seventeen instructions. Source names are used throughout. Read with
`programs/ppv_escrow/src/instructions/` and `state/agreement.rs` open.

Legend for **Coverage**: `U` host unit (`cargo test`), `V` local validator
(`tests/escrow.ts`), `P` randomized property suite, `L` live devnet (RR-6
evidence), `M` mutation-qualified.

---

## 1. `initialize_agreement`

| | |
| --- | --- |
| Signer | `creator` (becomes buyer) |
| Writable | `agreement` (init), `vault` (created), `creator` (payer) |
| Read-only | `mint`, `vault_authority`, `token_program`, `system_program` |
| PDA constraints | `agreement = ["agreement", creator, agreement_id_le]`; `vault_authority = ["vault", agreement]`; `vault = ["vault_token", agreement]` |
| Token/mint | vault created via explicit `create_account`/`allocate`+`assign` then `initialize_account3`, authority = `vault_authority` |
| Preconditions | `counterparty != default` (unless Bounty) and `!= creator`; `amount > 0`; `terms_hash` non-zero; type ∈ {Escrow, MilestoneContract, Bounty}; `vault.data_is_empty()` |
| Transition | → `Open` |
| Value movement | rent only, from creator |
| CPI | System, SPL Token (vault creation) |
| Events | `AgreementOpened` |
| Terminal effect | none |
| Negative tests | zero/self counterparty, zero amount, zero terms hash, unsupported type, duplicate id, pre-funded vault |
| Coverage | U V P L M |

> The lamport-griefing case is handled: if the vault PDA already holds lamports,
> `create_account` would fail, so the handler tops up rent and uses
> `allocate`+`assign` instead.

## 2. `fund`

| | |
| --- | --- |
| Signer | `buyer` — must equal `agreement.creator` |
| Writable | `agreement`, `vault`, `funder_token_account` |
| PDA constraints | agreement + vault re-derived; `has_one = mint`, `has_one = vault` |
| Token/mint | `funder_token_account.mint == agreement.mint`, `.owner == buyer`; `transfer_checked` with `mint.decimals` |
| Preconditions | state `Open`; for a MilestoneContract, `milestone_total == amount` |
| Transition | `Open → Funded` |
| Value movement | exactly `agreement.amount`, buyer → vault |
| Events | `AgreementFunded` |
| Coverage | U V P L M |

> State is written **after** the transfer and after `vault.reload()` proves the
> credited delta equals `amount`. A direct token transfer into the vault is not
> funding (Invariant 10).

## 3. `mark_completed`

Seller-only, `Funded`-only, **refuses a MilestoneContract**, requires a
counterparty to exist. Moves no money. → `Completed`. `WorkCompleted`.
Coverage `U V P L M`.

## 4. `settle`

| | |
| --- | --- |
| Signer | either party (`is_party`) |
| Writable | `agreement`, `vault`, `seller_token_account` |
| Read-only | `mint`, `vault_authority`, `settlement_proof` (optional), `token_program` |
| Token/mint | destination `.mint == agreement.mint` **and** `.owner == agreement.counterparty` → `DestinationNotOwnedBySeller` |
| Preconditions | counterparty assigned; state `Completed` |
| Proof gate | if a `settlement_proof` is cited: `proof.agreement == agreement` **and** `proof.is_approved()`, both **before** any custody moves |
| Transition | `Completed → Settled` (terminal) |
| Value movement | `agreement.remaining()` → seller |
| Events | `SettlementExecuted` |
| Negative tests | non-party signer, wrong state, redirected destination, wrong mint, substituted vault/authority, unapproved proof, another agreement's proof |
| Coverage | U V P L M (proof gate: U V L only — see 06) |

> Either party may trigger settlement **because the destination can only ever be
> seller-owned**. That constraint is what makes the open trigger safe.

## 5. `refund`

Seller-only (`NotTheSeller`), state `Funded` or `Completed`, destination must be
`agreement.creator`-owned. Pays `remaining()` → `Refunded` (terminal).
`RefundExecuted`. Coverage `U V P L M`.

> A buyer wanting its money back over the seller's objection cannot take it
> here; that is what `open_dispute` is for.

## 6. `open_dispute`

Either party, state `Funded` or `Completed`, `reason_hash` non-zero. Moves
nothing. → `Disputed`. Records `dispute_opened_by`. `DisputeOpened`.
Coverage `U V P L M`.

> `settle` becomes impossible because it demands `Completed`, and `Disputed` is
> not it (Invariant 9a).

## 7. `resolve_dispute`

| | |
| --- | --- |
| Signer | either party |
| Beneficiary | **read from `destination.owner`**, not passed as a flag |
| Preconditions | state `Disputed`; beneficiary is a party; **`signer != beneficiary`** → `CannotConcedeToSelf` |
| Transition | `Disputed → Settled` or `Disputed → Refunded` (both terminal) |
| Value movement | `remaining()` → beneficiary |
| Events | `DisputeResolved` **plus** `SettlementExecuted` or `RefundExecuted` |
| Coverage | U V P L M |

> Resolution is **concession only**. The signer surrenders its own claim. There
> is no arbiter because none is trusted. Neither party can take the money.

## 8. `cancel`

Creator-only, `Open`-only, **takes no token accounts** — there is nothing to
move. → `Cancelled` (terminal). `AgreementAbandoned`. Coverage `U V P L M`.

> Cancellation cannot strand escrowed money because it is unreachable once
> funded (Invariant 9d).

## 9. `select_counterparty`

Sponsor-only (`creator`), **Bounty only**, state `Open` or `Funded`, refuses an
agreement that already has a counterparty, refuses `default` and refuses the
creator itself. `CounterpartyAssigned`. Coverage `U V P L M`
(mutation id `bounty-winner-replacement`).

> The one field not fixed at creation, because a bounty escrows before it knows
> who wins. From selection onward the payee is as frozen as everywhere else.

## 10. `create_milestone`

Buyer-only, **MilestoneContract only**, `Open`-only, `amount > 0`, non-zero
`terms_hash`. `record_milestone` caps the running `milestone_total` at
`agreement.amount`. Milestone PDA seeded by the agreement's own
`milestone_count`. `MilestoneCreated`. Coverage `U V P L M`.

> The schedule is fixed before the money arrives, and `fund` refuses a partly
> scheduled contract — so no escrowed lamport is unreleasable by any tranche.

## 11. `submit_milestone`

Seller-only, agreement `Funded`, milestone `Pending → Submitted`. No value.
Coverage `U V P L M`.

## 12. `approve_milestone`

Buyer-only, agreement `Funded`, milestone `Submitted → Approved`. No value.
Coverage `U V P L M`.

## 13. `reject_milestone`

Buyer-only, agreement `Funded`, milestone `Submitted → Pending` (retryable). No
value. Coverage `U V P L M`.

## 14. `settle_milestone`

| | |
| --- | --- |
| Signer | either party |
| Preconditions | agreement `Funded`; milestone belongs to this agreement; milestone state `Approved`; `milestone.amount <= agreement.remaining()` |
| Proof gate | same as `settle` |
| Value movement | `milestone.amount` → seller-owned account |
| Transition | milestone → `Settled`; agreement → `Settled` **when `milestones_settled == milestone_count`** |
| Events | `MilestoneSettled` + `SettlementExecuted` |
| Coverage | U V P L M (mutations `milestone-double-release`, `milestone-recipient`, `milestone-overpay`) |

## 15. `submit_proof`

| | |
| --- | --- |
| Signer | `submitter` — must be a party |
| Writable | `agreement` (counter), `proof` (init), `core_proof` (written by Core), `submitter` (payer) |
| PDA constraints | `proof = ["proof", agreement, agreement.proof_count_le]`; `core_event_authority = ["__event_authority"]` under `ppv_core::ID`; `core_proof` re-derived and asserted |
| Preconditions | agreement `is_live()` (Funded, Completed or Disputed); `content_hash` non-zero |
| Transition | **none** — records a fact, changes no agreement state |
| Value movement | rent only |
| CPI | `ppv_core::create_proof`, target pinned by `Program<'info, PpvCore>`, **no `with_signer`** |
| Events | `ProofSubmitted` carrying both `proof` and `coreProof` |
| Coverage | U V L — **not P, not M** |

> Index comes from the agreement's own counter, so indices are dense and ordered
> and two racing clients cannot overwrite: the loser fails on an account that
> already exists.

## 16 / 17. `approve_proof` / `reject_proof`

| | |
| --- | --- |
| Signer | `decider` — a party, **and not `proof.submitter`** → `CannotDecideOwnProof` |
| Preconditions | `proof.agreement == agreement`; agreement `is_live()`; `proof.status == Submitted` → else `ProofAlreadyDecided` |
| Transition | proof → `Approved` / `Rejected`. **A decision is final.** |
| Value movement | **none** — approval is a decision about a fact; settlement is a separate instruction with its own gate |
| Events | `ProofApproved` / `ProofRejected`, each carrying `coreProof` |
| Coverage | U V L — **not P, not M** |

---

## Structural properties worth confirming once

* **No `remaining_accounts` anywhere in the workspace.** That entire attack class
  is structurally absent.
* **No `unsafe`, `unwrap()`, `expect()` or `panic!` in production program code.**
  Every occurrence is inside `#[cfg(test)]`.
* **No close/realloc instruction exists.** No revival or reinitialization path.
* **`overflow-checks = true`** in the release profile; `checked_add`/`checked_sub`
  at every accumulation; `record_payout` caps `settled_total` at `amount`.
* **Every `UncheckedAccount` is either PDA-seed-constrained or address-asserted
  before use.** Nine occurrences, all accounted for.
* **Clock is recorded, never used for authorization.** No deadline, expiry or
  time-based gate exists, so clock manipulation has no authorization surface.
