# RR13-001 — remediation record

**Finding.** Escrow proof-backed settlement does not validate linked Core proof
status.

| | |
| --- | --- |
| **ID** | RR13-001 |
| **Severity** | MEDIUM |
| **Raised by** | the independent reviewer — not an internal finding |
| **Frozen reviewed target** | `0190248f6199398dfe4ce632e513123cb00b0cb0` |
| **Remediation target** | `PENDING_MERGE` |
| **Status at the close of this sprint** | `REMEDIATED_PENDING_REVIEW` |
| **`SECURITY_BEHAVIOR_CHANGED`** | **YES** |

`VERIFIED_FIXED` is the independent reviewer's to assign and is not claimed
here. RR-13 remains OPEN.

---

## 1. Reproduction

`RR13_001_REPRODUCED = YES`, from source, at the frozen target.

The reviewer's sequence was checked step by step against
`0190248f6199398dfe4ce632e513123cb00b0cb0`:

| Step | At the frozen target |
| --- | --- |
| Core proof created through `submit_proof` | `ppv_escrow` CPIs into `ppv_core::create_proof`; the record's `authority` is the submitter's own wallet (`submit_proof.rs`) |
| Escrow proof approved | `decide_proof.rs` writes `ProofStatus::Approved`; the decision is final |
| `ppv_core::revoke_proof` | authority-only, terminal, sets `ProofStatus::Revoked` (`ppv_core/src/state.rs`) |
| `settle` | checked `proof.agreement == agreement_key` and `proof.is_approved()`, then paid |
| `settle_milestone` | the **same two checks**, written out a second time |

The decisive fact is structural rather than a matter of ordering: at the frozen
target neither `Settle` nor `SettleMilestone` carried a `ppv_core::ProofRecord`
account at all. No core status could be consulted, because no core account was
in the instruction. A settlement therefore paid out citing a commitment its own
author had revoked, and recorded that payment as proof-backed.

Scope of the defect:

* **Affected:** `settle` (escrow, bounty), `settle_milestone` (every tranche of
  a milestone contract, each of which may cite evidence).
* **Not affected:** `refund` and `resolve_dispute`, which cite no evidence;
  `submit_proof` and the decision instructions, which move no custody.
* **Not a fund-loss defect.** A settlement still paid only the counterparty,
  only from the agreement's own vault, only `remaining()`, and only from a
  legal state. What was wrong is the justification the chain recorded for the
  payment, which is exactly why MEDIUM is the right severity.

## 2. The protocol rule

`CHOSEN_PROTOCOL_MODEL = LIVE_CORE_VALIDITY`

A proof-backed payout is allowed only while the linked `ppv_core::ProofRecord`
is `Active`. The full analysis of the two candidate models, and why the
repository's own architecture settles it, is in
[`docs/security-model.md`](../../security-model.md) § "Core revocation and
settlement". In short: the escrow `Proof` account was deliberately built *not*
to be a second commitment — it stores no content hash, on the stated grounds of
"one proof primitive, one place to revoke". A snapshot model would hand the
protocol precisely the second source of truth it refused.

## 3. Griefing analysis

`GRIEFING_ANALYSIS = NO_UNILATERAL_PAYOUT_GRIEFING`

Who may revoke: only the wallet that made the commitment. `submit_proof`
forwards the submitter's own signature rather than signing as a program PDA, so
`ProofRecord.authority` is the submitting party, and `revoke_proof` is
`has_one = authority`. Neither the counterparty nor an outsider can revoke the
other side's evidence.

Whether a revocation can block a payout: **no**, in any agreement shape,
because citing evidence is optional in both settlement paths and the payout
amount does not depend on the citation.

| Shape | Effect of revoking a cited commitment |
| --- | --- |
| Ordinary escrow | The citation is refused. Either party settles uncited, or cites other approved evidence; the seller receives `remaining()` in full. |
| Milestone contract | The tranche's citation is refused. The tranche still releases uncited — the milestone submit/approve lifecycle never touches proofs. |
| Repeated tranche payouts | Each tranche cites independently. One revoked commitment cannot block a schedule. |
| Bounty | Identical to ordinary escrow; `select_counterparty` is unrelated to evidence. |
| Dispute | `resolve_dispute` cites nothing and is unaffected. |

So evidence integrity and settlement liveness are both satisfied without a
broader protocol change, and no architectural review is required. The single
cost is recorded honestly: a settlement made after a revocation stores
`settlement_proof = Pubkey::default()`, because the chain declines to record a
payment as proof-backed when the proof no longer stands.

Event, indexer and SDK semantics are unchanged by this choice. `SettlementExecuted.proof`
is `None` for an uncited settlement, which is a shape consumers already handle;
no event field was added, removed or reinterpreted.

## 4. Regression test first

The regression was written against the vulnerable program, before the guard
existed:

* `tests/escrow.ts` → `describe("core proof revocation at settlement (RR13-001)")`,
  test **"reproduces the finding: a revoked core commitment cannot back a
  payout"** — Active → approved → revoked → `settle` citing it must be refused.
* The milestone counterpart, **"refuses a tranche backed by a revoked
  commitment, and still pays it without one"**, covers `settle_milestone`.
* Host-level: `programs/ppv_escrow/src/state/proof.rs` →
  `a_revoked_core_commitment_cannot_back_a_payout`.

`REGRESSION_FAILS_BEFORE_FIX = YES`, with two different strengths of evidence,
stated separately because they are not the same claim.

**Demonstrated, executed.** `./scripts/mutation-qualify.sh core-revocation`
deletes the status guard — which is, for the purposes of that check, the
frozen target's behaviour — and requires the suite to fail. It does:

```text
  core-revocation  a settlement may cite a revoked ppv_core commitment
                   detected [cross-program evidence validity (RR13-001)]
                     state::proof::tests::a_revoked_core_commitment_cannot_back_a_payout
```

`core-revocation-inverted` and `core-proof-binding` are detected in the same
run. Full result: `MUTATION_QUALIFICATION_PASSED (10 mutations, all detected)`.

**Structural, not executed.** The local-validator regression in `tests/escrow.ts`
cannot run in this environment (§9). It does not need to be run to know it fails
against the frozen target: there, `Settle` and `SettleMilestone` take no core
proof account, so the test cannot even build its transaction, let alone reach an
`Active` check. The failure is structural rather than a matter of a check being
ordered wrongly. It is listed as **unrun** in §9, and CI executes it.

## 5. The fix

At the custody boundary, on chain, before any token moves. No part of it relies
on an indexer, the SDK, a client, or off-chain policy.

| Where | What |
| --- | --- |
| `state/proof.rs` | `CoreCommitment` — the four facts read out of the core record — and `Proof::require_live_core_commitment`, a pure function with host unit tests |
| `instructions/settlement_proof.rs` | `require_cited_proof`, the one citation rule **both** settlement paths call, and `load_core_commitment`, which checks owner and discriminator before reading a byte |
| `instructions/settle.rs` | `core_proof: Option<UncheckedAccount>`; the inline two-line check replaced by the shared call |
| `instructions/milestone.rs` | the same, for `SettleMilestone` |
| `errors.rs` | `CoreProofRequired`, `UnexpectedCoreProof`, `CoreProofRevoked`, **appended** so no existing error code moves |

What is established before the status is consulted:

1. the account is owned by `ppv_core`;
2. its discriminator is `ProofRecord`'s (`try_deserialize`, not a raw cast);
3. its address equals the escrow decision's recorded `core_proof`;
4. its address equals the protocol's own
   `core_proof_address(submitter, agreement, proof_index)` derivation — so a
   stored field is never the only thing between custody and a substituted
   account;
5. its `authority` is the proof's submitter;
6. **then** `status == Active`.

The citation and its core record are required **both-or-neither**: cited
evidence without the record is `CoreProofRequired`, a record without a citation
is `UnexpectedCoreProof`. No arbitrary user-supplied account reaches a custody
path with no rule attached to it.

No copy of core status is kept in escrow. `Proof` is byte-identical — the fix
adds an account to two instructions, not a field to an account.

`SETTLE_FIXED = YES`. `SETTLE_MILESTONE_FIXED = YES`.

## 6. Account-substitution coverage

`escrow.ts` → **"refuses every core record but this evidence's own"** drives all
of the following through `settle` and requires `CoreProofMismatch` before any
custody movement, then settles honestly to prove none of them is a false
rejection:

| Substitution | Refused by |
| --- | --- |
| Another proof of the same agreement (live core record) | recorded-address and derivation binding |
| Another agreement's core record | same |
| The right index under the wrong submitter | derivation binding |
| The wrong proof index | derivation binding |
| A foreign `ppv_core` record the attacker minted for itself | recorded-address binding |
| The escrow `Proof` PDA offered as its own commitment (self-substitution) | owner check |
| The agreement account | owner/discriminator |
| A wallet — not a program account at all | owner check |
| Wrong Core **program** | not expressible: escrow derives under `ppv_core::ID` and compares addresses, so a record under another program id is a different address |
| `Proof.core_proof` mismatch | covered at host level by `the_stored_link_is_never_the_only_thing_checked`; unreachable on chain because `submit_proof` writes the field itself |
| Revoked core proof | `CoreProofRevoked` — §4 |

`ACCOUNT_SUBSTITUTION_TESTS = 11 CASES, ALL REFUSED BEFORE CUSTODY MOVEMENT`

## 7. Assurance — the F-06 gap this landed in

RR13-001 landed exactly where the package said to attack: the proof lifecycle,
disclosed as **F-06**, outside the property model and outside mutation
qualification. The gap is narrowed here, deliberately and not further:

**Mutation qualification — done.** `scripts/mutation-qualify.sh` gains three
permanent mutations, each of which must make `cargo test -p ppv_escrow` fail:

| id | Defect injected |
| --- | --- |
| `core-revocation` | the status guard is deleted — the finding itself, kept so the suite can never lose the ability to detect it |
| `core-revocation-inverted` | the guard is inverted rather than removed, which a careless edit produces far more easily and which a suite testing only the rejection path would pass |
| `core-proof-binding` | the address and authority binding is removed, so any `ppv_core` record may stand in |

This required the rule to be a host-testable function rather than inline
handler code, which is why `require_live_core_commitment` exists in that shape.

**Randomized property suite — evaluated, deliberately not done.** Adding proof
lifecycle actions to `tests/invariants/` would mean new `ActionKind`s, model
rules, generator weights, chain assertions and reachability floors. That is the
"unrelated fuzz infrastructure" this sprint was told not to inflate into, it
cannot be exercised in an environment with no validator (§9), and
`scripts/test/coverage-docs.test.mjs` currently *asserts* the proof lifecycle is
absent from the generator so that the package cannot overclaim. Closing F-06
properly is its own sprint, with its own budget and its own reachability
evidence. **F-06 remains OPEN.**

`PROPERTY_COVERAGE = UNCHANGED (F-06 STILL OPEN, BY DECISION)`
`MUTATION_QUALIFICATION = EXTENDED — 3 NEW MUTATIONS OVER THE RR13-001 GUARD`

## 8. Client and IDL contract

`IDL_CHANGED = YES` — `settle` and `settle_milestone` each gain one optional
account, `core_proof`, immediately after `settlement_proof`. No instruction
argument, account layout, discriminator or event changed, and no existing error
code moved.

`SDK_CHANGED = NO` for `sdk/` — the published SDK has no instruction builders.
It decodes accounts and events and derives addresses, and already exports
`deriveCoreProof` and `coreProofId`, which is what a client needs to supply the
new account.

The hand-written client that *does* build instructions was updated atomically:

* `scripts/lib/escrow-instructions.mjs` — both builders take `coreProof`,
  defaulting to absent, encoded with the same "program id means None"
  convention the existing optional account uses.
* `scripts/devnet-escrow-custody.mjs` — both proof-citing settlements now pass
  the derived core record, including the negative that cites a *rejected*
  proof, so it still fails for the reason it names rather than for a missing
  account.
* `scripts/test/escrow-instructions.test.mjs` — the guard parses the Rust
  structs and compares field for field, so it caught the change by
  construction; new cases cover the cited and uncited account lists for both
  instructions.

Indexer semantics are unchanged, and the two identities stay distinct: the
escrow `Proof` PDA is the decision, the `ppv_core::ProofRecord` is the
commitment, and `SettlementExecuted.proof` continues to name the former.

## 9. Validation

`FULL_CI = PARTIAL — EVERY TOOLCHAIN-AVAILABLE GATE GREEN; VALIDATOR GATES NOT
EXECUTABLE HERE`

| Gate | Result |
| --- | --- |
| `cargo fmt --all -- --check` | **PASS** |
| `cargo test --workspace --locked` | **PASS** — 65 escrow host tests, including 6 new ones over the RR13-001 rule |
| `cargo clippy --workspace --all-targets --locked` | **PASS** — no new warnings |
| `npm ci` | **PASS** |
| `npm test` (typecheck, SDK, indexer, release guards, generators) | **PASS** — 818 pass, 1 skipped, 0 fail |
| `npm run build` | **PASS** |
| `./scripts/mutation-qualify.sh` | **PASS** — 10 mutations, all detected, including the three new RR13-001 ones |
| Anchor local-validator suite (`tests/escrow.ts`, PPV-P1…P10, proof lifecycle properties) | **NOT EXECUTED** |
| `./scripts/mutation-qualify-property.sh` | **NOT EXECUTED** |
| `anchor build` / IDL verification | **NOT EXECUTED** |

The reason for the last three is environmental and is stated rather than worked
around: the remediation environment has no `anchor` and no `solana` binary, and
its network policy refuses `release.anza.xyz`, so the toolchain cannot be
installed. Every gate that needs a validator or an SBF build is therefore
**unrun, not passed**. CI runs them on the pull request, and this remediation is
not complete until they are green there.

One consequence is worth naming plainly for the reviewer: because `anchor build`
could not run here, the IDL emitted for the two changed account lists has not
been inspected in this environment. The account structs themselves are
machine-compared against the hand-written client by
`scripts/test/escrow-instructions.test.mjs`, which did run.

## 10. Change control

| Field | Value |
| --- | --- |
| `FINDING` | RR13-001 |
| `OLD_REVIEW_TARGET` | `0190248f6199398dfe4ce632e513123cb00b0cb0` |
| `REMEDIATION_TARGET` | `PENDING_MERGE` |
| `SECURITY_BEHAVIOR_CHANGED` | **YES** |
| `TARGET_INVALIDATING_PATHS` | `programs/ppv_escrow/**`, `scripts/devnet-escrow-custody.mjs`, `scripts/lib/escrow-instructions.mjs` |
| `RR13_001_STATUS` | `REMEDIATED_PENDING_REVIEW` |
| `RR_13` | OPEN |

The frozen target `0190248f…` is **not** overwritten. It remains the SHA the
independent review was conducted against, and
[`MANIFEST.sha256`](MANIFEST.sha256) remains its attestation — which means the
manifest will *not* verify against this remediation branch, by design. Re-hashing
the package and issuing a new target SHA happens at re-freeze, after merge,
per [14-change-control.md](14-change-control.md) § "Procedure".

`tests/escrow.ts` was **modified**, not only extended: the `settle` and
`settleMilestone` helpers gained the new optional account, because the
instruction interface changed. That is disclosed here because the change-control
rule for `tests/**` is "additive only", and a helper signature change is not
additive. No assertion was weakened or removed.
