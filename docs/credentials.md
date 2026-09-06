# PPV Credentials

## What "PPV Verified" is allowed to mean

Exactly one thing: **the displayed credential corresponds to a verifiable PPV
protocol record at this state.**

It says nothing about quality, ownership, honesty, originality, or future
behaviour. A credential is never applied because a frontend database says
something happened; every field is computed from a lifecycle that was itself
rebuilt from committed chain events.

```ts
import { escrowCredential, replayAgreement } from "@gwap/ppv-sdk";

const { lifecycle } = await replayAgreement(source, agreement, { programId });
const credential = escrowCredential(lifecycle, { chainVerified: true });
```

## The ladder

```text
revoked   ← outside the ladder; a revoked proof is never shown as verified
recorded              the facts exist
verified              the account was re-read from chain and matched
counterparty_confirmed the other party accepted something
settled               value actually moved
dispute_resolved      a dispute ended
```

## Two rules that decide almost everything

**Confirmation means the *other* party accepted something.** An approved proof,
an approved milestone, a completed settlement. `WorkCompleted` is the seller's
own claim that it finished — if that counted, one party could stamp itself. A
rejection withholds confirmation rather than granting it, and there is nothing
to un-set, because only an approval ever sets the flag.

**A refund is never a settlement.** Money going back to the buyer is recorded as
`refunded` and never raises the seal to `settled`. An agreement that paid one
milestone and refunded the rest is honestly both: one tranche was earned.

## Chain verification is required, not defaulted

`escrowCredential` takes `chainVerified` explicitly. A credential built from an
event feed alone is a credential that trusts its own event feed; the flag says
the indexer re-read the account from chain and it matched the reconstruction.
Without it the seal cannot rise above `recorded`, whatever the events claim.

## What a verifier gets

The credential carries the agreement, the parties, the mint, what was funded,
paid and returned, the approved proofs it cites, and the receipt ids. Every one
of those is re-derivable from the chain by anyone with the program id and an RPC
endpoint — which is what makes it a credential rather than a badge.

## Rendering, and NFTs

Rendering is a product concern. A stamp, a card, a PDF, a share image: all are
*representations* of the credential above, and none of them is the credential.

An optional NFT is the same thing again — a representation, minted only after
the protocol state it describes is final, and never required for any PPV
security property. The eligibility gate for one already exists in
`sdk/src/reputation/eligibility.ts` and evaluates server-side from chain-derived
facts; nothing a browser sends about eligibility is trusted. Minting itself is
Phase 12 and waits on a deployed program with a permanent id — there is nothing
worth pointing an NFT at until then.
