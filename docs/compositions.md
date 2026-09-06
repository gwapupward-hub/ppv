# Invoices and Bounties

Neither is a new protocol. Both are compositions of the primitives PPV already
has, which is the point: a system that grows a new custody surface per product
ends up with several, each with its own bugs.

## Invoices

PPV has no invoice account, no invoice instruction, and no invoice state
machine. An invoice is a **document** whose canonical hash is the `terms_hash`
of an ordinary escrow agreement, and "paid" is what that escrow's settlement
already means.

```text
issuer drafts invoice ──> canonical hash ──> payer creates escrow with that
                                             terms hash, and funds it
                                                    │
                         issuer acknowledges  <─────┘  mark_completed()
                                   │
                                   ▼  settle()
                         issuer paid; receipt reconstructible from chain
```

```ts
import { invoiceCommitment, verifyInvoice } from "@gwap/ppv-sdk";

const termsHash = await invoiceCommitment(invoice);   // before funding
const { matches, status, reasons } = await verifyInvoice(invoice, lifecycle, termsHash);
```

`verifyInvoice` re-hashes the document and checks it against the escrow: the
commitment, the mint, the issuer against the payee, the payer against the funder,
the line items against the total, and the total against what was funded and
paid. A hash on chain says *that* something was agreed; only re-hashing the
document says *what*.

Amounts are strings in the mint's base units. An invoice is a financial document
and JSON numbers lose precision above 2^53.

**The wrinkle worth stating.** The *payer* creates and funds the agreement,
because the escrow kernel's creator is its buyer. An invoice is issued by the
seller, so the document travels off chain and the payer escrows against its
hash. Making the issuer the creator would need a second funding path where the
counterparty pays — and two funding paths is exactly the custody surface this
protocol is trying not to have. The trade is real, and it is the honest one.

## Bounties

A bounty reuses the same escrow, with one narrow protocol addition:
`select_counterparty`.

```text
sponsor creates a Bounty with no payee ──> funds it   (applicants can now see
        │                                              the money exists)
        │  applicants anchor deliverables as proofs
        ▼
select_counterparty(winner)  ──> the payee is frozen from here on
        ▼
mark_completed() ──> settle()  ──> the winner is paid
```

Everything else — proofs, approval, disputes, refunds — works unchanged.

**Why the exception exists.** A bounty has to escrow before it knows who will be
paid; that is what makes it a bounty rather than a promise. Every other
agreement fixes its payee at creation.

**Why it is safe.** The field can be assigned exactly once. Before selection
nobody can be paid at all — no wallet can sign as the default address, and the
program says so explicitly rather than leaving it to be derived. After
selection the destination is as frozen as any other agreement's, so Invariant 5
holds unchanged, and the sponsor cannot re-choose after seeing what a settlement
would do.

**What it does not solve.** A sponsor who never selects leaves the money in the
vault. That is the same liveness gap as an agreement with no expiry, recorded in
[security-model.md](security-model.md) rather than papered over. Selecting more
than one winner, or splitting a bounty between several, needs either several
agreements or the split-settlement machinery that arrives with arbitration in
Phase 13.
