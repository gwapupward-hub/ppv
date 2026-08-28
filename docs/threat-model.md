# Foundation Threat Model

PPV assumes clients may call the on-chain programs directly. Security therefore
lives in signer checks, PDA constraints, state transitions, governance approval
rules, and loader-account validation rather than in the frontend.

## Protocol controls

| Instruction | Required authority | Primary control |
|---|---|---|
| `create_proof` | proof authority | signer required; PDA includes signer; content hash must be nonzero |
| `revoke_proof` | recorded authority | `has_one`; PDA seeds; signer; revocation is terminal |
| `create_agreement` | party A | signer; party validation; wallet-namespaced PDA; bounded expiry |
| `propose_revision` | either party | party check; expected-version lock; both signatures cleared |
| `sign_agreement` | either party | signer; party check; exact version and hash; expiry guard |
| `cancel_agreement` | either party while pending | party check; pending-only; account history remains |

## Native governance controls

| Instruction | Required authority | Primary control |
|---|---|---|
| `initialize_governance` | protected bootstrap payer | canonical singleton governance and vault PDAs |
| `create_upgrade_proposal` | governance member | monotonic proposal id; exact target program and buffer committed |
| `create_reconfiguration_proposal` | governance member | validated member set, threshold, delay, lifetime and treasury |
| `approve_proposal` | governance member | one approval per member; current governance epoch required |
| `cancel_proposal` | proposal creator | active proposal and exact proposer signer |
| `execute_reconfiguration` | permissionless after approval | threshold, delay, expiry, epoch and action validation |
| `execute_upgrade` | permissionless after approval | threshold, delay, expiry, epoch, exact target/buffer, ProgramData derivation, loader ownership and canonical Vault PDA signer |

## Governance invariants

- Governance has 2–8 unique, non-default members.
- Threshold is always at least 2 and never exceeds the member count.
- A member cannot approve the same proposal more than once.
- A proposal cannot execute before threshold or before its configured delay.
- Executed, cancelled, expired, or stale-epoch proposals cannot execute.
- Governance reconfiguration increments the epoch and invalidates all older
  pending proposals.
- Upgrade execution is bound to the exact approved target program and loader
  buffer.
- The Vault PDA has no private key; only `ppv_governance` can sign for it using
  its canonical seeds.
- Governance, Core and Commerce upgrade authorities must equal the canonical
  PPV Vault PDA after bootstrap.
- Governance member wallets never become direct program upgrade authorities.

## Foundation invariants

- A proof authority never changes.
- A revoked proof never becomes active again.
- Agreement parties never change.
- Agreement version increases by exactly one per accepted revision.
- Revision always clears both signature slots.
- Executed means both signatures reference the current version and current
  content hash.
- Executed and Cancelled agreements have no outgoing state transition.
- No Foundation instruction transfers SOL or SPL tokens between users.
- No evidence account has a close path.

## Governance verification requirements

Before PPV relies on native governance for a production candidate:

- bootstrap Governance and Vault PDAs in the same protected deployment process;
- verify the live member set, threshold, delay, proposal lifetime and treasury;
- verify every controlled program reports the canonical Vault PDA as authority;
- test below-threshold, duplicate-approval, timelock, expiration and stale-epoch
  behavior on a local validator and devnet;
- complete one controlled governed upgrade on devnet and verify the resulting
  binary hash and unchanged Vault PDA authority;
- include `ppv_governance` in the independent Solana security review.

## Explicitly deferred risks

The following remain release blockers for future custody work:

- binding every escrow field to the signed `terms_hash`;
- arbiter conflicts of interest and replacement policy;
- mint and token-program allowlists;
- custody vault authority and destination pinning;
- fee destination snapshots;
- pause semantics that never block withdrawals;
- custody accounting invariants and state-machine fuzzing;
- legal review for escrow and dispute resolution.
