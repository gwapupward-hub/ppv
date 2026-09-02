# Reputation Events v1

PPV records facts. Every GWAP product that wants a shared reputation history
reads those facts through one versioned contract set, published from this
repository's SDK at `sdk/src/reputation/`:

| Module | What it is |
| --- | --- |
| `contracts.ts` | `ReputationEventV1`, `GwapDeliverableReferenceV1`, `PpvReceiptV1`, `PpvSealState`, `GnsRecordSnapshotV1`, validators. |
| `chain-events.ts` | Decoder for the `emit_cpi!` events of `ppv_core` and `ppv_commerce`. Discriminators are pinned here and in the Rust unit tests. |
| `normalize.ts` | Chain event → `ReputationEventV1`; product submission → `proof.submitted`. |
| `receipts.ts` | One deterministic receipt per participant per event. |
| `seal-state.ts` | `recorded → verified → counterparty_confirmed → settled → dispute_resolved` (+ terminal `revoked`). |
| `eligibility.ts` | Credential NFT eligibility and the public-metadata allowlist. |
| `hashing.ts` | Deterministic ids. Chain idempotency key: `(transactionSignature, instructionIndex, innerInstructionIndex)`. |

The modules are pure: no storage, no network, no scoring. Consumers (the
GWAP web app indexer, GNS Verified Activity, GwapScore) vendor them
verbatim; `gwapspot-web/scripts/sync-ppv-contracts.mjs --check` fails on
drift.

## Rule

PPV records; GwapScore interprets. No module here carries a trust label, a
score adjustment, or a scoring rule. `outcome` is the factual result of an
event (`completed`, `rejected`, `cancelled`, `revoked`, …), never a judgement.

## Program events

Every event names every party it concerns so an off-chain consumer can
attribute it without reading the account. That is what makes at-least-once,
unordered webhook delivery safe: the normalizer is stateless.

| Program | Event | Reputation event | Actor / counterparty |
| --- | --- | --- | --- |
| `ppv_core` | `ProofCreated` | `proof.created` | authority / — |
| `ppv_core` | `ProofRevoked` | `proof.revoked` | authority / — |
| `ppv_commerce` | `AgreementCreated` | `agreement.created` | party_a / party_b |
| `ppv_commerce` | `AgreementRevised` | `agreement.revised` | proposer / other party |
| `ppv_commerce` | `AgreementSigned` | `agreement.signed` | signer / other party |
| `ppv_commerce` | `AgreementExecuted` | `agreement.executed` | party_a / party_b |
| `ppv_commerce` | `AgreementCancelled` | `agreement.cancelled` | canceller / other party |

`escrow.funded`, `milestone.*`, `invoice.paid`, `dispute.*` and
`settlement.completed` are declared in the contract so consumers can be
built now. They are produced by the custody programs that remain outside
this foundation (see README, "Foundation scope"); no normalizer emits them
until those programs exist and pass their own gates.

`proof.submitted` is product-attested: a product registers a
`GwapDeliverableReferenceV1` against an existing proof. It borrows the chain
coordinates of the `proof.created` event it references, so it cannot exist
without a chain-verified proof and a resubmission collapses to one event.

## Identity

Wallet authority is canonical. `GnsRecordSnapshotV1` is the `.gwap` name the
wallet held when the event was first indexed; it is frozen with the event. A
later transfer of the name never moves historical activity to the new owner.

## Seal states

"PPV Verified / Stamped & Guaranteed" means only that the displayed
credential corresponds to a verifiable PPV protocol record. It does not
guarantee quality, copyright ownership, honesty, future behaviour, or
generalized trustworthiness.

## Versioning

Adding an event type, an outcome, or a field that every consumer tolerates
is a v1 change. Renaming or re-meaning anything is v2: new types, new schema
version, old ones untouched.
