# Architecture

## Three programs, one claim each

| Program | Claim | Custody | Program ID |
| --- | --- | --- | --- |
| `ppv_core` | proves **facts** | non-custodial | `9cWE41ZDNQChvFrRoVuPQDeoVLg46ACTiZRCZaBZzfwU` |
| `ppv_commerce` | proves **agreements** | non-custodial | `GmRDoFuPrBrsxnvTX751WK5rLu14JXe4sgjh6vNwHzr3` |
| `ppv_escrow` | controls **value** | **custody boundary** | `7U1bCHQcr8Jg6J8G69JGaAWCRtsrZB1RYx4zo1sNEVF4` |

## The one program boundary PPV crosses

`ppv_escrow::submit_proof` performs a CPI into `ppv_core::create_proof`. It is
the only cross-program call in the protocol.

```
submitter ──signs──> ppv_escrow::submit_proof
                         │
                         ├─ writes escrow Proof PDA  (owner: ppv_escrow)
                         │
                         └─CPI──> ppv_core::create_proof
                                      └─ writes ProofRecord  (owner: ppv_core)
```

Four properties make that boundary safe, all enforced in
`programs/ppv_escrow/src/instructions/submit_proof.rs`:

1. **The callee is pinned by type.** `Program<'info, PpvCore>` — not an
   `UncheckedAccount` the client fills in, and not a constant compared in the
   handler.
2. **No privilege is manufactured.** The submitter's signature already exists on
   the outer transaction and is forwarded. `ppv_escrow` signs for no PDA here,
   so the `authority` on the core record is the human who committed.
3. **The record's address is derived, not chosen.** `core_proof_id` is
   `hash(CORE_PROOF_ID_DOMAIN ‖ agreement ‖ proof_index)[..16]`, and the
   resulting PDA is asserted equal to the passed account *before* the CPI.
4. **Failure unwinds everything.** If `ppv_core` refuses, the `proof_count`
   increment and the escrow Proof account unwind with it. There is no state in
   which escrow believes a commitment exists that Core never wrote.

## Two proof identities — do not collapse them

| | escrow `Proof` PDA | `ppv_core` `ProofRecord` |
| --- | --- | --- |
| Owner | `ppv_escrow` | `ppv_core` |
| Seeds | `["proof", agreement, proof_index]` | `["proof", submitter, core_proof_id]` under `ppv_core::ID` |
| Records | what **this agreement decided** about the evidence | the **commitment itself** |
| Field linking them | `Proof.core_proof` | — |
| Event field | `proof` | `coreProof` |

`AgreementLifecycle.proofs[].proof` is the **escrow-side** account. Asking
`ppv_core`'s ownership question of that address is a category error; it was the
exact defect fixed in PR #42. The binding a consumer must verify is
`escrowProof.core_proof == event.coreProof`, with each account owned by its own
program.

## Account model

| Account | Seeds | Owner |
| --- | --- | --- |
| `EscrowAgreement` | `["agreement", creator, agreement_id_le]` | `ppv_escrow` |
| vault authority | `["vault", agreement]` | PDA, no data |
| vault token account | `["vault_token", agreement]` | SPL Token, authority = vault authority |
| `Milestone` | `["milestone", agreement, milestone_index_le]` | `ppv_escrow` |
| `Proof` | `["proof", agreement, proof_index_le]` | `ppv_escrow` |

The creator is in the agreement seeds, so one wallet cannot front-run another
wallet's `agreement_id`. The agreement address is in every subordinate seed, so
one agreement's milestones, proofs and vault are unreachable from another.

**There is no global vault authority.** Compromising one agreement's derivation
reaches exactly one agreement's funds.

## Agreement lifecycle

```
                    ┌─────────> Cancelled            (terminal)
                    │
  Open ──fund──> Funded ──mark_completed──> Completed ──settle──> Settled
                    │                           │                 (terminal)
                    ├──open_dispute─────────────┤
                    │                           │
                    └──> Disputed ──resolve_dispute──> Settled | Refunded
                    │                                          (terminal)
                    └──refund──────────────────────────> Refunded (terminal)
```

A milestone contract never passes through `Completed`: it settles straight from
`Funded` when its last tranche is released. `mark_completed` explicitly refuses
a milestone contract.

`LEGAL_EDGES` in `tests/invariants/model.ts` is the authoritative table and
carries eleven edges.
