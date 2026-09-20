# Test and evidence map

## Verification ladder as built

| Tier | Mechanism | Command | State at review commit |
| --- | --- | --- | --- |
| 1 compile/format/lint | `cargo fmt`, `cargo clippy`, `tsc --noEmit` | `cargo fmt --all -- --check`, `npm run typecheck` | green |
| 2 unit + serialization | 76 host Rust tests | `cargo test --workspace --locked` | 76 pass |
| 3 release/tooling suite | 41 files, 801 tests | `npm run test:release` | 800 pass, 1 skipped, 0 fail |
| 4 property / state machine | `fast-check` model vs real validator | `npm run test:invariants:pr` | green in CI |
| 5 local validator | `tests/escrow.ts`, `tests/integration/` | `npm run test:f1` | green in CI |
| 6 devnet rehearsal | live custody matrix | workflow dispatch | RR-6 CLOSED |
| 7 reproducible build | double build + IDL compare; artifact hashing | `npm run verify:idl-build` | built == on-chain |
| 8 external review | — | — | **RR-13 OPEN — this package** |
| 9 mainnet smoke | — | — | not authorized |

## Mutation qualification — what is proven to be detected

Two harnesses, because an answer about one layer says nothing about the other.

### `scripts/mutation-qualify.sh` — the deterministic security suite

Seven mutation classes: `authorization`, `custody`, `destination`, `terminal`,
`identity`, `milestone`, `state-machine`.

### `scripts/mutation-qualify-property.sh` — the randomized property suite

Four mutations, each requiring the **property suite specifically** to fail
(compile errors and host-suite failures do not count):

| Id | Defect injected |
| --- | --- |
| `milestone-double-release` | an already-released tranche may be released again |
| `milestone-recipient` | a tranche may be paid to any account of the right mint |
| `milestone-overpay` | a tranche pays out everything the vault still holds |
| `bounty-winner-replacement` | a bounty's winner may be replaced |

Budget is measured, not guessed: 300 sequences × 28 actions × 2 seeds, sized
against the narrowest observation windows, with
`tests/invariants/reachability.test.ts` asserting those windows still exist.
CI asserts no mutation survives into the working tree.

## Property-test coverage gaps

| Area | Current coverage | Property coverage | Classification |
| --- | --- | --- | --- |
| Ordinary escrow (fund/complete/settle/cancel) | U V P L M | **yes** | — |
| Refund | U V P L M | **yes** | — |
| Disputes (open + resolve) | U V P L M | **yes** | — |
| Milestones (create/submit/approve/reject/settle) | U V P L M | **yes** | — |
| Bounty (select_counterparty) | U V P L M | **yes** | — |
| **`submit_proof`** | U V L | **no** | RECOMMENDED_BEFORE_AUDIT |
| **`approve_proof` / `reject_proof`** | U V L | **no** | RECOMMENDED_BEFORE_AUDIT |
| **Proof-backed settlement (`settlement_proof`)** | U V L | **no** | RECOMMENDED_BEFORE_AUDIT |
| **`ppv_core` CPI composition** | U V L | **no** | AUDITOR_TARGET |
| **Cross-feature (proof × milestone / dispute / bounty)** | partial V | **no** | AUDITOR_TARGET |

**Why RECOMMENDED and not BLOCKER.** The proof lifecycle is not untested. It
carries deterministic negative tests against a real validator —
`tests/escrow.ts` asserts `CannotDecideOwnProof`, `ProofAlreadyDecided`,
`ProofNotApproved`, `ProofAgreementMismatch` and `CoreProofMismatch` — and it
has live devnet evidence: the RR-6 record carries 2 escrow Proof PDAs, 2
`ppv_core` records, verified owners on both sides, and a proof-backed final
settlement. What is absent is the *randomized* tier and the *mutation* tier,
which is a measurable difference in assurance, not an absence of assurance.

**Why the CPI row is AUDITOR_TARGET.** Cross-program composition under
adversarial account substitution is exactly the work an independent reviewer is
better placed to do than the team that wrote the binding.

## Mutation-test gaps

Guards with a deterministic negative test but **no mutation entry proving the
guard's removal is detected**:

| Guard | Location | Invariant |
| --- | --- | --- |
| `CannotDecideOwnProof` | `state/proof.rs::require_decidable` | 12d |
| `ProofAlreadyDecided` (decision finality) | `state/proof.rs::require_decidable` | 12e |
| `proof.agreement == agreement_key` | `settle.rs`, `milestone.rs` | 12a / 12f |
| `proof.is_approved()` gate | `settle.rs`, `milestone.rs` | 12f |
| `core_proof` address assertion | `submit_proof.rs` | CPI binding |
| `Program<'info, PpvCore>` CPI pinning | `submit_proof.rs` | CPI binding |

Six guards. Each protects proof-backed settlement — the path by which evidence
becomes money. Adding one mutation per row would raise the proof lifecycle to
the same qualification level the milestone and bounty paths already hold.

Classification: **RECOMMENDED_BEFORE_AUDIT**. Not blocking, because the guards
have negative tests; recommended, because mutation qualification is the
repository's own standard for "this suite would notice", and the proof path is
the one custody path that does not meet it.

## Live devnet evidence (RR-6)

Record `deployments/validation/ppv-escrow-devnet-live-custody-35465469908.json`,
recovered read-only by run 35481530878 from run 35465469908.

* 8 primary scenarios, all terminal, **every vault 0** — ordinary escrow Settled,
  cancel Cancelled, refund Refunded, dispute→seller Settled, dispute→buyer
  Refunded, milestones Settled (2 tranches), bounty Settled, proofs Settled
  (2 proofs).
* **43 expected refusals**, each a *landed* transaction carrying `err != null`.
* 2 escrow Proof PDAs owned by `ppv_escrow`; 2 `coreProof` records owned by
  `ppv_core`; each escrow account's stored `core_proof` matching the binding its
  events published.
* `PRIMARY_SCENARIO_VAULT_TOTAL`, `FIXTURE_VAULT_TOTAL` and
  `TOTAL_RUN_PPV_VAULT_BALANCE` all 0.
* `recoveryMode=READ_ONLY`, `valueMovingTransactionsSentDuringRecovery=0`.

## Transaction lifecycle

`scripts/test/transaction-lifecycle.test.mjs` covers every property the review
brief asks for:

| Requirement | Test |
| --- | --- |
| Signature known before broadcast | 1, 2, 3 |
| Value-moving transactions not blindly resent | 4, 5, "web3.js is never allowed to rebroadcast on our behalf" |
| Ambiguous submission resolves against chain state | 6, "never confirms is ambiguous, not a success" |
| Expected refusal requires a **landed failed** transaction | 9, 15–16, "cannot record a refusal without asking the chain" |
| Infrastructure failure cannot masquerade as a protocol refusal | 11, "a rate-limited log read does not demote a proven refusal" |
| A landed signature with `err == null` where refusal was expected | 10 — classified a **CustodyDefect** |
| Confirmation never requires a websocket | 7 |
| Diagnostics carry no secrets and are never PASS evidence | 18, 19 |
