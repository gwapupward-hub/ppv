# Indexing PPV

> Given the PPV program id, the PPV SDK, and any Solana RPC endpoint, an
> independent developer can determine who participated, what state was reached,
> what funds moved, and what receipt represents the outcome — without access to
> a GWAP database.

`@gwap/ppv-indexer` is that claim, written down and tested. If it ever disagrees
with a PPV product's screen, the indexer is right.

```bash
npm run build
node --import tsx scripts/replay-agreement.mts \
  --rpc https://api.devnet.solana.com \
  --program <PPV_ESCROW_PROGRAM_ID> \
  --creator <WALLET> --id 42
```

## The pipeline

```text
getSignaturesForAddress(agreement)   paged newest→oldest, then reversed
        │
        ▼
getTransaction(signature)            encoding: json, maxSupportedTransactionVersion: 0
        │
        ▼
extractEscrowEvents(tx)              inner instructions only, event authority required
        │
        ▼
escrowReceiptFromEvent(envelope)     deterministic id from chain coordinates
        │
        ▼
ReceiptStore                         idempotent, keyed by receipt id
        │
        ▼
reconstructAgreementLifecycle()      ordered by the state chain, checked against slots
```

Each stage is a pure function of the stage before it, so the whole pipeline is
replayable: re-running it over the same chain produces the same receipts, in the
same order, with the same ids.

## What counts as an event

Three rules decide, and each is a security property rather than a parsing
convenience.

**A failed transaction is not history.** It committed nothing, so nothing
happened. An indexer that read events out of failed transactions would
manufacture history from attempts — the exact failure mode that makes a
"settlement" appear for a settlement that never paid.

**Only inner instructions.** An Anchor event CPI is the program invoking
itself. A *top-level* instruction to the program is a request someone
submitted, not a fact. Reading top-level instruction data as an event would let
anyone forge PPV history for the price of a transaction fee.

**Only with the event authority.** The generated event handler requires the
program's `__event_authority` PDA as a signer, and only the program can sign for
it. Because the transaction committed, the runtime already checked that
signature — so the presence of that account in the inner instruction is proof
the program emitted it. This is also what separates a genuine event from an
unrelated instruction whose data happens to begin with the same eight bytes.

A fourth rule comes from the SDK: an event is identified by the pair
(program id, discriminator), and only the program id is authoritative. Anchor
derives a discriminator from the event name alone, so no two PPV programs are
allowed to share a name — a rule `scripts/test/discriminators.test.mjs`
enforces. The extractor still decodes only instructions that targeted the
program it was configured with: the name rule keeps a mistake there from
producing something plausible.

## Versioned transactions

A v0 transaction's account list is **static keys, then lookup-table writables,
then lookup-table readonlys**. Instruction indices address that combined list.
Reading only `message.accountKeys` resolves the wrong program id and silently
drops every event — an agreement that looks like it never happened. The
extractor builds the combined list once, in `accountKeysOf`.

The RPC also refuses to return a v0 transaction at all unless
`maxSupportedTransactionVersion` is set, with the same silent-empty result.
`httpChainSource` always sends it, and a test asserts the request shape rather
than trusting the client code.

## Ordering, and why not by timestamp

History is ordered by **following the state chain**, not by sorting on a
timestamp, a slot, or a table of action ranks:

- `blockTime` is a validator's estimate and is not monotonic between blocks.
- Slots tie: two transitions can land in the same slot, and neither the slot nor
  the signature says which executed first.
- Ranking actions works only for a lifecycle that never branches. Disputes,
  refunds, and milestones all branch.

Each receipt names the state its transition started from, so the transitions
link into exactly one path out of creation, and that path *is* the history. Slots
then serve as a check on the result rather than its source: a transition cannot
have committed in an earlier slot than the transition it depends on, and a
history that claims otherwise is refused.

Reconstruction also refuses a forked chain (two transitions leaving one state), a
cycle, an orphan that attaches to no reachable state, a settlement without its
funding, and a settled amount that disagrees with the funded amount.

## Idempotency

Delivery is at-least-once and unordered however an indexer is fed — webhook,
backfill, or a replay after an outage. `ReceiptStore` keys on the receipt id,
which is a pure function of (program id, signature, instruction index, inner
index, action). The same transaction seen a hundred times is one receipt, and
the store converges on identical contents regardless of arrival order.

A receipt id that resolves to *different content* is refused outright rather than
resolved in favour of one side: two different facts cannot share an id, so if
they appear to, one of them did not come from the transaction it names.

## Incremental indexing

`signatureHistory` accepts an `until` cursor: paging runs newest to oldest and
stops when it reaches a signature already indexed, so a steady-state indexer
reads only what is new. Because receipt ids are deterministic, an overlapping
window is harmless — re-reading a transaction produces a receipt the store
already holds.

There is no partial-history mode. An agreement's identity, parties, and mint
come from its creation event, so a replay that cannot see the creation
transaction refuses rather than reporting a lifecycle it had to guess at.

## Consuming events without the indexer

An integrator who already has a transaction stream needs only the SDK:

```ts
import { decodeEventForProgram, escrowReceiptFromEvent } from "@gwap/ppv-sdk";

const decoded = decodeEventForProgram("ppv_escrow", innerInstructionData);
if (decoded) {
  const receipt = escrowReceiptFromEvent({
    event: decoded.event,
    programId,
    transactionSignature,
    slot,
    instructionIndex,
    innerInstructionIndex,
    blockTime,
  });
}
```

The three rules above still apply, and they are the indexer's job to enforce, not
the decoder's. A stream that hands the decoder top-level instruction data, or
data from a failed transaction, will get a decoded event back — because the bytes
are well-formed. Deciding whether those bytes are *history* is the caller's
responsibility.
