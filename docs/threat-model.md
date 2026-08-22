# Foundation Threat Model

The caller may bypass GWAP OS and invoke programs directly. Frontend validation
is never a security control.

| Instruction | Authority | Worst case if bypassed | Program guard |
|---|---|---|---|
| `create_proof` | proof authority | False attribution or ID squatting | signer required; PDA includes signer; nonzero hash |
| `revoke_proof` | recorded authority | Destruction of another wallet's evidence status | `has_one`; PDA seeds; signer; append-only revocation |
| `create_agreement` | party A | Fake counterparty agreement or global ID front-run | signer; party validation; PDA includes party A; bounded expiry |
| `propose_revision` | either party | Unsigned edits presented as signed terms | party check; expected-version lock; both signatures cleared |
| `sign_agreement` | either party | Forged execution or signature over unseen bytes | signer; party check; exact version and hash; expiry guard |
| `cancel_agreement` | either party while pending | Unauthorized cancellation or evidence deletion | party check; pending-only; account remains permanently |

## Foundation invariants

- A proof authority never changes.
- A revoked proof never becomes active again.
- Agreement parties never change.
- Agreement version increases by exactly one per accepted revision.
- Revision always clears both signature slots.
- Executed means both signatures reference the current version and current
  content hash.
- Executed and Cancelled agreements have no outgoing state transition.
- No instruction transfers SOL or SPL tokens.
- No evidence account has a close path.

## Explicitly deferred risks

The following are release blockers for future custody work:

- binding every escrow field to the signed `terms_hash`;
- arbiter conflicts of interest and replacement policy;
- mint and token-program allowlists;
- PDA vault authority and destination pinning;
- fee destination snapshots;
- pause semantics that never block withdrawals;
- vault accounting invariants and state-machine fuzzing;
- legal review for escrow and dispute resolution.

