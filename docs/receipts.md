# PPV Receipts

A receipt answers, for one protocol transition: what happened, who took part,
what agreement it affected, what assets moved, what state changed, when, and
which transaction executed it.

## The storage decision, made explicitly

The escrow kernel writes **no receipt account**.

A dedicated receipt PDA would duplicate data the event already committed, in the
same transaction that produced it, at a rent cost per transition — and it would
add no verifiability, because anyone auditing the receipt would still be
checking it against that event. So a PPV receipt is a deterministic projection
of an immutable chain event plus the chain coordinates that carried it.

An on-chain receipt account is reconsidered when a receipt must be **proved to
another program** on chain. Nothing in Phase 1 does that. When something does,
the receipt PDA arrives for that use, not for all of them.

## Deterministic identity

```text
receiptId = "ppvr_" + sha256(
    "ppv-escrow-receipt:v1" | programId | txSignature |
    instructionIndex | innerInstructionIndex | action
)[..20 bytes]
```

The slot is recorded on the receipt but is deliberately **not** in the id. An id
must depend only on what identifies the event, and a transaction's signature
already does that; including the slot would let a re-read that disagreed about
the slot mint a second receipt for one fact.

Nothing in that derivation comes from wall-clock time, a random value, or a
database sequence. Replaying the same transaction produces the same receipt id,
so an indexer's receipt table is idempotent under at-least-once delivery without
needing a uniqueness oracle.

## What a receipt carries

```text
PPV RECEIPT
Receipt ID     ppvr_5c0f…            Action          SETTLEMENT_EXECUTED
Agreement      7xKX…                 Asset           100.000000 (mint 4zMM…)
Buyer          emerald.gwap          Previous state  Completed
Seller         builder.gwap          New state       Settled
Proof          —                     Timestamp       2026-03-04T18:22:07Z
Transaction    5Jd9…
```

`emerald.gwap` is a GNS presentation of a wallet, resolved off-chain. The wallet
is what the receipt records; the name is what a screen shows.

A PDF, a printed page, or a rendered card is a *representation* of a receipt.
The receipt is the projection above, and it is reproducible from chain data by
anyone.

## Reconstructing a lifecycle

```ts
import { escrowReceiptFromEvent, reconstructAgreementLifecycle } from "@gwap/ppv-sdk";

const receipts = envelopes.map(escrowReceiptFromEvent);
const lifecycle = reconstructAgreementLifecycle(receipts);
// → { state: "Settled", fundedAmount, settledAmount, settlementDestination, … }
```

Order comes from the **state chain**, not from a timestamp, a slot, or a table
of action ranks. Each receipt names the state its transition started from, so
the transitions link into exactly one path out of creation, and that path is the
history. Slots are then a check on the result rather than its source: a
transition cannot have committed in an earlier slot than the transition it
depends on.

The alternatives all fail. `blockTime` is a validator estimate and is not
monotonic. Slots tie, because two transitions can land in one slot. Ranking
actions works only while the lifecycle never branches, and disputes, refunds,
and milestones all branch.

`reconstructAgreementLifecycle` is deliberately strict. It refuses a history
where:

- a step does not start from a state the history reached,
- two transitions leave the same state (a fork the program cannot produce),
- the chain revisits a state,
- a transition committed in an earlier slot than the one it follows,
- a settlement appears without the funding it pays out,
- the settled amount disagrees with the funded amount,
- receipts from more than one agreement are mixed,
- the creation receipt is missing, or there is more than one.

Out-of-order and duplicated delivery are *not* errors — both are normal for
webhooks and RPC backfills, and neither may change the result.

Turning chain data into these receipts is the indexer's job, and the rules that
decide what counts as an event at all are in [indexing.md](indexing.md).

## Rules

1. A receipt is only ever built from a committed event in a confirmed
   transaction. A failed attempt, an intention, and a database row cannot
   produce one.
2. A receipt never becomes an independent truth. Every field is copied from the
   event or derived from the state machine.
3. Receipt reconstruction is a pure function. Two indexers replaying the same
   chain reach byte-identical receipt histories, which is what makes an
   independent verifier possible.
