# PPV State Machines

## The rule every instruction obeys

```text
WHO may perform this action?
                AND
IS this action legal in the current state?
```

Authorization alone is not sufficient. State alone is not sufficient. An
instruction that checks only one of the two is incomplete, and the missing half
is the vulnerability.

## Escrow custody lifecycle (`ppv_escrow`)

```text
        OPEN ──cancel()──> CANCELLED          buyer only, no money exists yet
          │ fund()                            buyer only
          ▼
    ┌── FUNDED ──────────────────┐
    │     │ mark_completed()     │ open_dispute()   either party
    │     ▼                      │ refund()         seller only
    │ COMPLETED ──open_dispute()─┤
    │     │ settle()             ▼
    │     │                  DISPUTED
    │     │                      │ resolve_dispute()   the conceding party
    │     ▼                      ├──────────> SETTLED
    │  SETTLED <─────────────────┘
    └──refund()──────────────────────────────> REFUNDED
```

`SETTLED`, `REFUNDED` and `CANCELLED` are terminal. Every way an agreement can
end is final: paid, refunded, or abandoned before money was ever involved.

| Action | Signer | Legal from | Result | Custody effect |
| --- | --- | --- | --- | --- |
| `initialize_agreement` | creator | — | `Open` | Creates an empty vault |
| `fund` | creator (buyer) | `Open` | `Funded` | Buyer ATA → vault, exactly `amount` |
| `mark_completed` | counterparty (seller) | `Funded` | `Completed` | None |
| `settle` | either party | `Completed` | `Settled` | Vault → seller ATA, exactly `amount` |
| `cancel` | creator (buyer) | `Open` | `Cancelled` | None — the vault is empty by construction |
| `open_dispute` | either party | `Funded`, `Completed` | `Disputed` | None |
| `resolve_dispute` | the conceding party | `Disputed` | `Settled` or `Refunded` | Vault → the *other* party, exactly `amount` |
| `refund` | counterparty (seller) | `Funded`, `Completed` | `Refunded` | Vault → buyer ATA, exactly `amount` |
| `submit_proof` | either party | `Funded`, `Completed`, `Disputed` | unchanged | None |
| `approve_proof` | the party who did not submit | `Funded`, `Completed`, `Disputed` | unchanged | None |
| `reject_proof` | the party who did not submit | `Funded`, `Completed`, `Disputed` | unchanged | None |

Explicitly rejected, and covered by tests:

```text
OPEN      --X-->  COMPLETED
OPEN      --X-->  SETTLED
FUNDED    --X-->  SETTLED
FUNDED    --X-->  FUNDED       (double funding)
COMPLETED --X-->  COMPLETED    (double completion)
SETTLED   --X-->  anything     (terminal)
```

### Evidence is not a transition

`submit_proof` anchors a hash to the agreement while it is `Funded` or
`Completed`. It moves no money and changes no state — the agreement's own
counter advances, and that is all. What follows from a proof is decided
separately, which is what keeps evidence from becoming an implicit authority to
release funds.

```text
FUNDED ──submit_proof()──> FUNDED      (proof 0, proof 1, … anchored)
COMPLETED ──submit_proof()──> COMPLETED
```

Neither `Open` nor `Settled` accepts evidence: before funding there is nothing
escrowed to deliver against, and after settlement the record is closed.

A proof runs a small machine of its own, orthogonal to the agreement's:

```text
SUBMITTED ──approve_proof()──> APPROVED   (decided by the party who did not submit)
          └─reject_proof()───> REJECTED
```

Both decisions are terminal. Re-deciding would let a party withdraw an approval
a settlement had already relied on. A rejection ends nothing — the submitter may
anchor more evidence — and it erases nothing: the rejected proof stays on chain
with its hash intact.

`settle` may cite one approved proof, which is then recorded on the agreement
and named in the settlement event. It is optional on purpose: a plain escrow
settles on the parties' own signatures, and requiring a proof would fold
approval into custody.

### Disputes are resolved by concession, not by a judge

`resolve_dispute` has no arbiter and trusts nobody. The signer surrenders its
own claim and the money goes to the **other** party:

```text
buyer signs  → seller is paid    → SETTLED
seller signs → buyer is refunded → REFUNDED
```

So the only party who can send this vault to the seller is the buyer, and the
only one who can send it back to the buyer is the seller. Neither can take it.
The beneficiary is read from the destination account's owner rather than passed
as a flag, so one fact decides the outcome instead of two that could disagree.

That is the whole of Phase 5's resolution model — one side whole, never a split.
Percentage splits, designated arbiters, and multisig arbitration are Phase 13,
behind the arbiter policy gate. Concession is what a protocol can do safely
before it has decided who is allowed to judge.

### Cancellation and refund are not the same act

`cancel` exists only for `Open`, where the vault is empty by construction — it
takes no token accounts at all, so there is nothing it could move even if it
were wrong. Once money is escrowed, giving it back is `refund`, which moves
custody and is the seller's to give. A buyer who wants its money back over the
seller's objection has to `open_dispute`; it cannot simply take it.

### Why completion and settlement are separate

`mark_completed` moves no money. That separation is what leaves room, without
touching the custody path, for the approval, proof, dispute-window, milestone
verification, and delayed-settlement steps of later phases. Collapsing the two
into one instruction would be smaller today and unextendable tomorrow.

### Why `settle` accepts either party

The settlement destination is constrained to a token account the seller owns,
so a buyer-triggered settlement can only pay the seller. Allowing either party
removes a liveness failure — a seller who disappears after completing work
cannot strand the buyer's tokens in the vault — without widening who can be
paid. It is not permissionless: a third party has no role in custody here.

## Negotiation lifecycle (`ppv_commerce`)

```text
Pending --both current signatures--> Executed
Pending --revision-----------------> Pending (version + 1, signatures cleared)
Pending --either party cancels-----> Cancelled
```

Negotiation state and custody state are separate machines in separate programs.
There is deliberately no single enum spanning "counter-offer sent" and "vault
funded": one enum covering business and custody conditions is how an illegal
transition gets smuggled through a state that looks adjacent and is not.

## Not yet implemented

`Disputed`, `Refunded`, and `Cancelled` are Phase 5 states, and milestones are
Phase 6 child machines. They are absent from `AgreementState` rather than
present and unreachable: an enum variant no instruction can produce is a
promise the program does not keep. Adding them appends borsh discriminants
without moving the existing four.
