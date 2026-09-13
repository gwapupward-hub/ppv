# PPV Escrow instruction surface and state graph

Derived from the code, not from the design documents. Where the two disagreed,
this file follows `programs/ppv_escrow/src/`.

`ppv_escrow` is **not deployed to any cluster.** This describes what the
program does, not what it does in production, because it has no production.

## The state graph, as implemented

```text
                         ┌──────────────── cancel() ────────────────┐
                         │                  (buyer)                  ▼
                       Open ───────────────────────────────────> Cancelled
                         │
                         │ fund()  (buyer, exact amount)
                         ▼
       ┌──────────────Funded──────────────┐
       │                 │                │
       │ mark_completed()│ refund()       │ open_dispute()
       │ (seller;        │ (seller)       │ (either party)
       │  not milestone) │                │
       ▼                 ▼                ▼
   Completed         Refunded         Disputed
       │                 ▲                │
       │ settle()        │ refund()       │ resolve_dispute()
       │ (either party)  │ (seller)       │ (either party, never to itself)
       │                 │                │
       │            ┌────┴────┐      ┌────┴─────┐
       ▼            │         │      ▼          ▼
   Settled <────────┘    Completed  Settled  Refunded
                          also      (paid    (conceded
                          disputable seller)  to buyer)
```

Milestone contracts take a different route to `Settled`: they never enter
`Completed`, and the agreement settles when the last tranche is released.

```text
   Funded ──settle_milestone() × N──> Settled
              (agreement settles on the last one)

   per milestone:
   Pending ──submit()──> Submitted ──approve()──> Approved ──settle()──> Settled
      ▲                      │
      └──────reject()────────┘
```

Three terminal states: `Settled`, `Cancelled`, `Refunded`. `AgreementState::is_terminal`
names exactly those, and no guard admits any of them — asserted exhaustively in
`state/lifecycle_model.rs::no_guard_admits_a_terminal_state`.

**`Disputed` is not terminal and has no timeout.** A dispute ends only by
concession. If neither party concedes, the agreement stays `Disputed` and the
money stays in the vault. See RR-10 in the
[residual-risk register](ppv-escrow-residual-risk.md).

## Agreement types

`initialize_agreement` accepts three of the six wire variants:

| Type | Payee at creation | Settles by | Notes |
| --- | --- | --- | --- |
| `Escrow` | required | `settle` after `mark_completed` | The ordinary case |
| `MilestoneContract` | required | last `settle_milestone` | Never enters `Completed`; schedule fixed while `Open` |
| `Bounty` | **optional** | `settle` after `mark_completed` | The only type that may exist without a payee |

`Invoice`, `Contract` and `ProofOnly` are refused with `UnsupportedAgreementType`.
They exist to keep the borsh discriminants stable (RR-9).

## Instructions

Seventeen. Five move value; the rest move state or record facts.

### Value-moving

| Instruction | From | To | Signer | Amount | Destination constraint |
| --- | --- | --- | --- | --- | --- |
| `fund` | `Open` | `Funded` | buyer | exactly `amount`, credit re-read and asserted | vault PDA, re-derived from the agreement |
| `settle` | `Completed` | `Settled` | either party | `remaining()` | `owner == counterparty`, `mint == agreement.mint` |
| `refund` | `Funded`, `Completed` | `Refunded` | **seller only** | `remaining()` | `owner == creator` |
| `resolve_dispute` | `Disputed` | `Settled` or `Refunded` | either party, never to itself | `remaining()` | owner must be a party, and not the signer |
| `settle_milestone` | `Funded` (milestone) | `Funded` or `Settled` | either party | milestone `amount`, capped at `remaining()` | `owner == counterparty` |

All four payout paths go through one function, `pay_out_of_vault`, which signs
with the per-agreement vault-authority PDA, uses `transfer_checked`, and re-reads
both accounts to require the exact delta on each side. That is deliberate: a
reviewer asking "can this be redirected or double-spent" has one place to look,
and the three payout paths cannot drift apart.

`fund` is the only instruction that moves value *in*, and it is the only one
whose amount is `agreement.amount` rather than `remaining()`.

### State-moving, no custody

| Instruction | From | To | Signer | Notes |
| --- | --- | --- | --- | --- |
| `initialize_agreement` | — | `Open` | creator | Creates the agreement PDA and the vault; refuses `counterparty == creator`, zero amount, all-zero terms hash |
| `mark_completed` | `Funded` | `Completed` | seller | Refused for milestone contracts |
| `cancel` | `Open` | `Cancelled` | buyer | **Takes no token accounts at all** — it exists only where the vault is empty by construction |
| `open_dispute` | `Funded`, `Completed` | `Disputed` | either party | Requires a non-zero reason hash and, since this sprint, an assigned payee |
| `select_counterparty` | `Open`, `Funded` | unchanged | sponsor | Bounty only, once; refuses the creator and the default address |
| `create_milestone` | `Open` | unchanged | buyer | Milestone contracts only; total may never exceed `amount` |
| `submit_milestone` | `Funded` | unchanged | seller | Milestone `Pending` → `Submitted` |
| `approve_milestone` | `Funded` | unchanged | buyer | Milestone `Submitted` → `Approved` |
| `reject_milestone` | `Funded` | unchanged | buyer | Milestone `Submitted` → `Pending`; the seller may retry |
| `submit_proof` | `Funded`, `Completed`, `Disputed` | unchanged | either party | CPIs into `ppv_core` to mint the commitment |
| `approve_proof` | live | unchanged | the *other* party | Refuses `signer == submitter` |
| `reject_proof` | live | unchanged | the *other* party | Not terminal for the agreement; the submitter may anchor more |

## Accounts

| Account | PDA seeds | Options? | Holds value |
| --- | --- | --- | --- |
| `EscrowAgreement` | `["agreement", creator, agreement_id_le]` | none | no |
| vault authority | `["vault", agreement]` | — (no data) | no |
| vault | `["vault_token", agreement]` | — (SPL token account) | **yes** |
| `Milestone` | `["milestone", agreement, index_le]` | none | no |
| `Proof` | `["proof", agreement, index_le]` | none | no |

The creator is in the agreement seeds, so the same numeric id under a different
creator is a different account and no wallet can front-run another's id. The
agreement is in the milestone and proof seeds, so one agreement's children can
never be presented for another.

**No escrow account has an `Option` field.** Every one is fixed width, borsh
fills the allocation exactly, and the SDK's strict trailing-bytes check is
therefore correct — unlike `ppv_commerce`, where an `Option` made every pending
agreement undecodable until Sprint 2. Pinned in
`sdk/test/escrow-accounts.test.ts`.

There is no global vault authority. Compromising one agreement's derivation
reaches exactly one agreement's funds.

## Token program scope

**Classic SPL Token only.** Every custody instruction pins
`Program<'info, Token>`. `initialize_agreement` creates the vault by hand rather
than with Anchor's `init` + `token::` constraints, specifically to keep
`anchor_spl::token_2022` out of the dependency tree.

`TOKEN-2022 = OUT OF CURRENT SECURITY CLAIM`. No claim is made about transfer
fees, transfer hooks, or confidential transfers, and a Token-2022 mint cannot be
used with this program.

## Cross-program surface

One CPI, in one instruction: `submit_proof` calls `ppv_core` to mint the proof
commitment. The callee is pinned by type (`Program<'info, PpvCore>`), the record
address is derived by escrow from the agreement and the proof index and asserted
before the call, and the submitter's own signature is forwarded rather than a
program-owned authority manufactured.

**`ppv_escrow` does not reference `ppv_commerce` anywhere.** It carries its own
parties and its own `terms_hash`. An escrow that corresponds to a Commerce
agreement does so by convention, enforced by neither program — see RR-4.
