# The PPV Integration Contract

> Given the PPV program id, the PPV SDK, and Solana RPC access, an independent
> developer can determine who participated, what agreement existed, what state
> was reached, what funds moved, what proof was submitted, what was approved,
> whether there was a dispute, how it was resolved, whether payment settled, and
> what immutable receipt represents the outcome.

That is the standard PPV is built to. This page is the interface list that makes
it true for someone outside GWAP.

## The four layers

```text
ppv_escrow / ppv_core / ppv_commerce      programs — the source of truth
        │  emit_cpi! events
        ▼
@gwap/ppv-sdk                             decode, derive, verify, reconstruct
        │
        ├── @gwap/ppv-indexer             chain → receipts → lifecycle
        │
        └── normalizeEscrowEvent()        chain → reputation facts
                    │
                    ▼
        GwapScore / GNS / GwapOS / Daily Ideas / Gwap Market / DIMI
```

Applications consume this. They may cache it, index it, render it, and add their
own meaning to it. They may not redefine it: where a product's database and this
pipeline disagree, the pipeline is right.

## What each layer promises

**Programs.** Event identity is the pair (program id, discriminator); layouts
are pinned by unit tests on both the Rust and TypeScript sides. Appending a
field to an existing event breaks every decoder, so new facts get new events.

**SDK.** Address derivation, account and event decoding, deterministic receipts,
lifecycle reconstruction, and the two verifications that connect documents to
chain state — `verifyTermsBinding` for a negotiated contract, `verifyInvoice`
for an invoice. No runtime dependencies.

**Indexer.** Three rules decide what counts as an event: a failed transaction is
not history, only inner instructions, only with the program's event authority.
See [indexing.md](indexing.md).

**Reputation.** `normalizeEscrowEvent` turns one escrow event into one
`ReputationEventV1`, or into nothing.

## Facts, never judgements

PPV emits what happened. GwapScore decides what it means. No normalized event
contains a score, a rating, or a label like `good_user`, and `outcome` says which
side a dispute went to — never who was right.

Some protocol events map to nothing at all. A bounty naming its payee is a fact
about an agreement, not about a participant's conduct, and inventing a reputation
event for it would put weight on something that carries none.

## Event map

| Protocol event | Reputation event | Outcome |
| --- | --- | --- |
| `AgreementOpened` | `agreement.created` | recorded |
| `AgreementFunded` | `escrow.funded` | recorded |
| `WorkCompleted` | `work.completed` | completed |
| `SettlementExecuted` | `settlement.completed` | completed |
| `RefundExecuted` | `agreement.refunded` | resolved_for_counterparty |
| `AgreementAbandoned` | `agreement.cancelled` | cancelled |
| `DisputeOpened` | `dispute.opened` | opened |
| `DisputeResolved` | `dispute.resolved` | resolved_for_counterparty |
| `ProofSubmitted` | `proof.created` | recorded |
| `ProofApproved` | `proof.approved` | completed |
| `ProofRejected` | `proof.rejected` | rejected |
| `MilestoneCreated` | `milestone.created` | recorded |
| `MilestoneSubmitted` | `milestone.delivered` | recorded |
| `MilestoneApproved` | `milestone.approved` | completed |
| `MilestoneRejected` | `milestone.rejected` | rejected |
| `MilestoneSettled` | `milestone.settled` | completed |
| `CounterpartyAssigned` | — | — |

Phase 10 appended `work.completed`, `milestone.settled`, `agreement.refunded`,
`proof.approved` and `proof.rejected` to `REPUTATION_EVENT_TYPES`. Appended, not
substituted: every earlier type still means what it meant, and a consumer that
ignores a type it does not recognise keeps working.

## One trap worth naming

A milestone settlement emits **two** events: `MilestoneSettled` and the
`SettlementExecuted` that carries the payment. They describe the same money from
two angles. A consumer summing payments should sum `settlement.completed` only —
the same rule lifecycle reconstruction follows, and for the same reason.

## Identity

Wallets are canonical. GNS names are resolved off chain and frozen into an event
when the indexer first sees it, never refreshed, so a later name transfer cannot
rewrite history. PPV never treats a name as an authority, and settlement
correctness does not depend on GNS being available.

## Stability

- Event layouts and account layouts are pinned by tests on both sides.
- Receipt ids are pure functions of chain coordinates, so replay is idempotent.
- `REPUTATION_EVENT_SCHEMA_VERSION` and `PPV_CANONICALIZATION_VERSION` are
  frozen; changes arrive as new versions rather than edits.
- Program ids are permanent protocol identity. Changing one changes the address
  of every agreement, vault and proof that has ever existed — see
  [pdas.md](pdas.md).
