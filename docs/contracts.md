# Contracts and Terms

## Two machines, deliberately not one

```text
ppv_commerce                        ppv_escrow
negotiation                         custody

DRAFT ─┐                            OPEN
       ├─> PENDING ─revision─┐        │ fund()
       │      │              │        ▼
       │      │ both sign    │      FUNDED
       │      ▼              │        │
       └─> EXECUTED <────────┘        ▼ …
```

A negotiated contract and a funded escrow are different objects in different
programs with different upgrade authorities. That is not an accident of history:
one enum spanning "counter-offer sent" and "vault funded" is how an illegal
transition gets smuggled through a state that looks adjacent and is not.

`ppv_escrow` never reads a `ppv_commerce` account. There is no CPI between them
and no field in one that the other trusts.

## What binds them

A cryptographic commitment, re-checkable by anyone:

```text
canonical terms document
        │ SHA-256 (canonicalization v1)
        ▼
   terms_hash ──────────────┬──────────────> ppv_commerce.Agreement.terms_hash
                            └──────────────> ppv_escrow.EscrowAgreement.terms_hash
```

The escrow program's guarantee is narrow and strong: `terms_hash` is fixed at
creation and never rewritten (Invariant 7). What it cannot tell you is *which*
document that hash names, or whether both parties accepted it. That is what
`verifyTermsBinding` establishes, from the two accounts:

```ts
import { verifyTermsBinding } from "@gwap/ppv-sdk";

const { bound, reasons } = verifyTermsBinding({ escrow, contract });
```

It requires all of:

- the two `terms_hash` values are equal,
- the contract is `Executed`, not `Pending` or `Cancelled`,
- the escrow's two parties are the contract's two parties,
- both signatures exist, are for the contract's *current* version, and committed
  to the same content and terms hashes,
- the two signatures are from different wallets, and both are parties.

Anything else is reported as a reason, and every disagreement is reported rather
than only the first — an escrow that fails one check usually fails several, and
knowing which matters when you are deciding whether to release money.

## Why this is not a check the program skipped

A caller might reasonably ask why `ppv_escrow` does not verify this itself. It
would have to read a `ppv_commerce` account, which means either a CPI or
deserializing another program's layout by hand — coupling custody to the shape
of a program it is deliberately independent of, and putting a second program's
upgrade authority in the path of every settlement.

The commitment does the work instead. A wrong `terms_hash` cannot be fixed after
the fact, and a client that checks the binding before funding knows exactly what
it is funding. The one thing the on-chain record cannot do is *find* the contract
for you: an indexer builds that map from `AgreementOpened` and
`AgreementRevised` events, which name the hash of every version.

## Revisions

`ppv_commerce` clears both signatures on every revision and requires each
signature to restate the version and hashes the wallet saw. So a signature that
survives is a signature for the current version by construction, and a stale
screen produces a clean transaction failure rather than an accidental agreement.

`verifyTermsBinding` re-checks that anyway, so the binding is sound on its own
rather than resting on a property of the other program.

Accepted terms never mutate: a change is a new version with a new hash, and an
escrow funded against the old hash stays bound to the old document. Whether to
fund against the new one is a decision, not a migration.
