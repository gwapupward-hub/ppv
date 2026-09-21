# RR-13 audit-readiness finding register

Findings from the team's own pre-audit review. They were raised against
`02b5b5286fab95ce68a4ca53d8b7768a738a1013` and resolved at the current frozen
target, `0190248f6199398dfe4ce632e513123cb00b0cb0`. This is **not** the independent
review and does not anticipate its results.

Internal findings are numbered **F-xx**. The identifiers `RR13-001`, `RR13-002`
and onward are reserved for the independent reviewer and are not used here.

| Severity | Count | Status |
| --- | --- | --- |
| CRITICAL | **0** | — |
| HIGH | **0** | — |
| MEDIUM | **3** | **all RESOLVED** |
| LOW | **2** | **all RESOLVED** |
| INFORMATIONAL | **4** | open by design — see below |

**F-01 … F-05 are RESOLVED.** They were remediated in
"Resolve RR-13 pre-audit documentation findings F-01–F-05", which is
documentation, commentary and test-guard work only: no program logic, program
identity, PDA derivation, authority, Squads configuration, deployment state or
custody behaviour changed. Each finding below carries its resolution and the
guard that now prevents its return.

**F-06 … F-09 remain open, deliberately.** They are informational assurance
gaps, not defects, and they are the honest part of this package. F-06 in
particular — the proof lifecycle sitting outside the property model and
mutation qualification — is the highest-value thing an independent reviewer
can attack, and it was **not** closed by this remediation. Nothing here added
property or fuzz infrastructure to make the package look cleaner than it is.

No exploitable defect was found in program logic. Every MEDIUM and LOW finding
is a **documentation-integrity** defect: repository security documentation that
contradicts the code or the committed evidence it describes. That class matters
for RR-13 specifically, because those documents are the map an independent
reviewer navigates by.

---

## CRITICAL

**None.**

## HIGH

**None.**

---

## MEDIUM

### F-01 — Canonical identity module states Escrow is undeployed and its authority untransferred, contradicting committed evidence

| | |
| --- | --- |
| **Severity** | MEDIUM |
| **Component** | release / governance tooling |
| **Affected files** | `scripts/lib/identity.mjs:96-97`; guard at `scripts/test/escrow-current-state-docs.test.mjs:57-61` |
| **AUDIT_BLOCKING** | false |

**Attack precondition.** None. This is not exploitable; it is an accuracy
defect in the document a reviewer is most likely to trust.

**Attack path / failure path.** `scripts/lib/identity.mjs` is described in its
own docstring as "the single record every release and deployment gate reads".
Lines 96–97 read as follows. This quotation is **historical**: it was true
until the Sprint 4 deployment on 2026-09-15 and is false at this commit.
>
> Vault index 0, and the *intended future* upgrade authority for `ppv_escrow`.
> Escrow is not deployed and no authority has been transferred to this address

Both clauses are false at this commit. `deployments/evidence/ppv-escrow-devnet-231dceb.json`
records deployment at slot 498656161 and an authority transfer to exactly that
address at slot 498656235, both finalized.

The repository already has a purpose-built guard against precisely this drift.
`escrow-current-state-docs.test.mjs` defines `STALE_CLAIMS` and fails any
unlabelled occurrence once an Escrow release record exists. **Four of its own
patterns match `identity.mjs`**, listed here as the historical claims the guard
was built to catch:
- `/escrow is not deployed/i`
- `/no authority has been transferred/i`
- `/the \*intended future\* upgrade/i`
- `/escrow (?:is|was) not deployed (?:and|,)/i`

The guard does not fire because its file set is
`markdownFiles(docs/) + README.md + SECURITY.md` — Markdown only. The drift sits
in a `.mjs` file, outside its scope.

**Impact.** An independent reviewer reading the canonical governance module is
told the custody authority is prospective when it is live. Misleads the
governance portion of the review; would be caught by any on-chain check.

**Current mitigation.** The correct facts are in the committed evidence record,
`docs/deployment-gates.md`, and `docs/security/ppv-escrow-attack-matrix.md:6`.

**Evidence.** Verified by re-running the guard's own `STALE_CLAIMS` regexes
against `identity.mjs`: 4 matches at lines 96–97. A repository-wide scan of all
non-Markdown files found this file and one benign test-name occurrence.

**Recommended remediation.**
1. Rewrite the `identity.mjs` comment to state the live facts, citing the
   evidence record and slot.
2. **Extend `escrow-current-state-docs.test.mjs` to scan `scripts/**/*.mjs` and
   `scripts/**/*.sh`** — closing the guard's scope hole is the durable fix; the
   comment edit alone leaves the class open.

**Regression test.** The extended guard is itself the regression test. Add a
tamper case that restores the old sentence and proves the guard fails.

**STATUS: RESOLVED.** Both stale comment blocks in `scripts/lib/identity.mjs`
now state the live facts and cite the evidence record, slot 498656161 for the
deployment and slot 498656235 for the authority transfer. The change is
commentary only, proven mechanically: with comments stripped, the file's text
is byte-identical before and after.

`escrow-current-state-docs.test.mjs` now scans `scripts/**/*.mjs` and
`scripts/**/*.sh` alongside Markdown, excluding only itself (it defines the
patterns). Widening the scan immediately caught one further real offender —
`scripts/test/attack-matrix.test.mjs`, whose test name asserted the stale
premise — which is now fixed under F-02.

Three tamper cases prove the guard bites: the verbatim restored comment trips
at least three patterns; a historical label rescues it only inside its own
paragraph; and the scan is asserted to cover `scripts/lib/identity.mjs` and to
exclude the guard's own source. Detection was extracted into `staleClaimsIn()`
so a tamper case can ask the question without writing a defect into the tree.

---

### F-02 — Attack-matrix deployment-surface rows describe a pre-deployment posture and cite a test that now asserts the opposite

| | |
| --- | --- |
| **Severity** | MEDIUM |
| **Component** | security documentation |
| **Affected files** | `docs/security/ppv-escrow-attack-matrix.md:160-167` (rows G-1 … G-4, G-8) |
| **AUDIT_BLOCKING** | false |

**Failure path.** The "Deployment surface" table states defences that are no
longer the repository's posture, while citing `custody-gate.test.mjs` as their
evidence:

| Row | Matrix claims | Reality at this commit |
| --- | --- | --- |
| G-1 | "Not among the workflow's program choices" | `custody-gate.test.mjs:129` asserts choices are `["ppv_core","ppv_commerce","ppv_escrow"]` |
| G-2 | "`record-deployment.sh` refuses any program but Core and Commerce" | an escrow release record exists in `deployments/evidence/` |
| G-3 | "Escrow appears in `[programs.devnet]` — Absent; asserted" | `Anchor.toml` lists it; `custody-gate.test.mjs:106` asserts it **is** present |
| G-4 | "`identity.mjs` names escrow unreleased explicitly" | true only because of F-01, which is itself the defect |
| G-8 | "NOT COVERED — see RR-7" | RR-7 is **CLOSED** for the custody multisig; narrowed to Core/Commerce |

The cited test does not merely fail to assert these defences — for G-1 and G-3
it asserts their negation.

**Impact.** The attack matrix is the natural entry point for an external
reviewer mapping the deployment surface. Five of its eight deployment rows
misdescribe the current gate posture. The custody gate is genuinely still
CLOSED, but its *meaning* changed from "escrow cannot be deployed at all" to
"escrow is deployed to devnet; mainnet and custody remain gated", and the table
did not follow.

**Current mitigation.** The matrix header (line 6) and line 36 already
acknowledge escrow is deployed, so the document contradicts itself rather than
being uniformly stale — a careful reader will notice.

**Recommended remediation.** Rewrite rows G-1 … G-4 against the current gate
definition and re-point each to what `custody-gate.test.mjs` now asserts.
Update G-8 to RR-7's closed/narrowed state.

**Regression test.** Extend `attack-matrix.test.mjs` to assert each G-row's
cited test name exists *and* that the row's claim matches an assertion in it.

**STATUS: RESOLVED.** The deployment-surface rows are rewritten against the
current gate definition, and each now cites a control that actually asserts
it. G-1 states that escrow *is* a workflow choice and is selectable only
alongside the frozen checks; G-2 moves to the binary-hash equality the
verifier enforces; G-3 and G-4 cite the identity-agreement and
placeholder-absence tests by name. A new G-9 records that the custody gate
does not open on a deployment or a custody pass. The header paragraph's reason
for "no row is LIVE DEVNET VERIFIED" is corrected: the program is deployed and
the custody matrix *has* run with committed evidence, so the surviving reason
is that no row is mapped to a transaction in that run. E-5 is promoted from
"partial, see RR-6" to the closed state RR-6 actually reached.

Two new guards make this class of drift mechanical rather than editorial. One
requires every quoted JavaScript test name in a row to be defined in the file
cited beside it. The other refuses a `NOT COVERED` row that cites a residual
risk the register records as closed. Three tamper cases confirm both bite: a
renamed quoted test, a `NOT COVERED` row pointed at a closed risk, and the
restored stale premise each fail exactly the intended test.

---

### F-03 — Property-test scope tables understate actual coverage

| | |
| --- | --- |
| **Severity** | MEDIUM |
| **Component** | security documentation |
| **Affected files** | `docs/property-testing.md:74-80`; `docs/invariants.md:104` (PPV-P10) |
| **AUDIT_BLOCKING** | false |

**Failure path.** Two stale scope statements, in opposite directions:

1. `docs/property-testing.md`'s table lists as **not covered**: "milestone
   contracts, bounties", "`open_dispute`, `resolve_dispute`, `refund`, proofs
   and proof decisions, milestone instructions, `select_counterparty`", and
   "partial payouts, `settled_total` accounting across tranches".

   `tests/invariants/actions.ts` generates `dispute`, `resolve`, `refund`,
   `createMilestone`, `submitMilestone`, `approveMilestone`,
   `rejectMilestone`, `settleMilestone` and `selectWinner`;
   `tests/invariants/fixture.ts:254` constructs a `milestoneContract`. Only
   **"proofs and proof decisions"** and **Token-2022** remain genuinely
   uncovered.

   The document ends with "Nothing in this document claims coverage of a row in
   the right-hand column" — which is now an *under*-claim that hides real
   assurance.

2. `docs/invariants.md` PPV-P10 states "The only legal successful edges are
   `Open → Funded`, `Open → Cancelled`, `Funded → Completed`,
   `Completed → Settled`". `LEGAL_EDGES` carries **eleven** edges, including
   `funded → settled`, `funded → refunded`, `completed → refunded`,
   `funded → disputed`, `completed → disputed`, `disputed → settled`,
   `disputed → refunded`.

**Impact.** An auditor scoping from these tables would (a) redundantly attack
milestone/bounty/dispute paths believing them unmodelled, and (b) under-attack
the proof lifecycle, which is the one genuinely unmodelled path. Both errors
point effort away from the real gap.

**Recommended remediation.** Regenerate both tables from
`tests/invariants/actions.ts` and `model.ts`, leaving proofs and Token-2022 in
the right-hand column. State the proof gap explicitly rather than burying it.

**Regression test.** Assert the scope table's right-hand column against the
`ActionKind` union and `LEGAL_EDGES` so a generator change that closes a gap
fails the doc.

**STATUS: RESOLVED.** Both tables are regenerated from the source of truth.
`docs/property-testing.md` now names all thirteen generated instructions and
all three generated agreement types on the covered side, and keeps
`submit_proof`, `approve_proof`, `reject_proof`, proof-cited settlement,
Token-2022, `ppv_core` CPI composition and the unimplemented agreement types on
the not-covered side. PPV-P10 in `docs/invariants.md` lists all eleven edges
`LEGAL_EDGES` carries, including `Funded → Settled` for a milestone contract's
last tranche.

`scripts/test/coverage-docs.test.mjs` is the new guard, and it treats
understating coverage as strictly as overstating it — that was the actual
defect here. It checks each generated instruction is named on the covered side
and absent from the other, each unmodelled instruction the reverse, that
Token-2022 stays out of the claim, that the generator still emits no proof
action, and that PPV-P10's edge list equals `LEGAL_EDGES` element for element.
Matching is on backticked names, so `settle` cannot be satisfied by
`settlement_proof`. Four tamper cases bite, including restoring the exact
original stale sentence.

---

## LOW

### F-04 — `docs/invariants.md` invariant 12 describes an enforcement rule the code no longer has

| | |
| --- | --- |
| **Severity** | LOW · **Component** security documentation · **AUDIT_BLOCKING** false |
| **Affected files** | `docs/invariants.md:33` |

The "Enforced by" cell reads "`agreement_type == Escrow` required at
initialization". `initialize_agreement.rs` accepts
`Escrow | MilestoneContract | Bounty` and refuses the rest with
`UnsupportedAgreementType`. The invariant *statement* ("An agreement whose
semantics are unimplemented cannot exist") remains true; only its stated
mechanism is stale. **Remediation:** update the cell to the current allowlist.

**STATUS: RESOLVED.** The cell now reads that `initialize_agreement` accepts
only `Escrow`, `MilestoneContract` and `Bounty`, and refuses `Invoice`,
`Contract` and `ProofOnly` with `UnsupportedAgreementType`. The implementation
was not touched: it was already correct, and the prose was what had gone
stale.

### F-05 — Attack-matrix G-8 cites RR-7 as NOT COVERED

| | |
| --- | --- |
| **Severity** | LOW · **Component** security documentation · **AUDIT_BLOCKING** false |
| **Affected files** | `docs/security/ppv-escrow-attack-matrix.md:167` |

G-8 marks "declared Squads threshold does not match the on-chain multisig" as
**NOT COVERED**, deferring to RR-7. RR-7 is CLOSED for the Escrow custody
multisig and narrowed to Core/Commerce. **Remediation:** split G-8 into the
closed custody case and the still-open Core/Commerce case. Folded into F-02's
remediation.

**STATUS: RESOLVED.** G-8 is split. G-8a covers the Escrow custody multisig and
records RR-7 as closed for it, citing the live Squads decode — program,
threshold 2, the exact three members, mask 7 each, vault index 0 and time lock
0, all read from `GEE6nE9x…` rather than declared. G-8b keeps the
Core/Commerce case `NOT COVERED` under RR-7's narrowed scope. The new
closed-risk guard described under F-02 prevents a `NOT COVERED` row from
citing a wholly closed risk again.

---

## INFORMATIONAL

### F-06 — Proof lifecycle is outside both the property model and mutation qualification

Not a defect; a measured assurance gap, fully described in
[06-test-and-evidence-map](06-test-and-evidence-map.md). Five property gaps,
six mutation gaps. The path carries deterministic negative tests and live
devnet evidence. Classification **RECOMMENDED_BEFORE_AUDIT**, and the highest-value
item an independent reviewer can attack (checklist items 2 and 3).

### F-07 — Donated surplus and vault rent are permanently stranded (RR-3)

Payouts derive from agreement fields, never `vault.amount`, so tokens sent
directly to a vault are neither funding nor payable. No instruction closes a
vault or agreement, so rent-exempt lamports are also permanent. Griefing/dust,
not theft — the surplus is unreachable by everyone including the donor. Adding
a sweep would create a new authority; that trade-off is the reason it does not
exist. Already registered as RR-3.

### F-08 — Upstream version currency and advisory status could not be verified

Network egress was scoped to the project repository, so crates.io, the Anchor
and Agave release feeds and RustSec were unreachable. All versions were read
from this repository's lockfiles and evidence. **No upgrade was performed** —
the `solana-program 1.18.17` pin is load-bearing (`spl-token-2022 v3` pulls
`solana-zk-token-sdk`, which pins `=1.18.26`). Item 1 on the auditor checklist.

### F-09 — Clippy warnings are macro noise

25 warnings on `ppv_escrow`, 9 on `ppv_core`, 13 on `ppv_commerce`. All are
`unexpected cfg condition value` from Anchor's macros (`anchor-debug`,
`solana`, `custom-panic`, `custom-heap`), plus one duplicated `#![cfg(test)]`
attribute at `programs/ppv_escrow/src/state/lifecycle_model.rs:22` in a
test-only module. None security-relevant. CI does not run `-D warnings`.

---

## Verdict

`RR13_AUDIT_ENTRY=READY_FOR_INDEPENDENT_REVIEW`

This answers one question and no other: **is the package internally coherent
enough to hand to an independent reviewer?** It is.

It does **not** mean RR-13 is closed, that a security audit has passed, or
that anything is production ready. RR-13 is OPEN and is closed only by the
independent review this package exists to enable. Legal review is OPEN. The
custody gate is CLOSED. Mainnet is NOT AUTHORIZED.

**What changed since `NOT_READY`.** The blocking criterion was "evidence
package complete", failed because three MEDIUM findings showed the
repository's own security documentation misdescribing the system: the attack
matrix's deployment surface, the property-test scope tables, and the canonical
identity module. All five documentation findings are now resolved, and each
carries a guard that fails if its claim drifts again — including the guard
scope hole F-01 exposed, which was the reason to call the drift systemic
rather than incidental.

**What deliberately did not change.** No program logic, program identity, PDA
derivation, token behaviour, state machine, authority, Squads configuration,
deployment workflow, deployment evidence or custody evidence. And no assurance
gap was closed by writing about it: F-06 through F-09 stay open, prominently,
because a reviewer is owed the real shape of what is and is not proven. The
proof lifecycle still sits outside the property model and outside mutation
qualification, and that is the first thing worth attacking.

**What a reviewer should read first.**
[10-auditor-checklist](10-auditor-checklist.md), items 1 through 3 — dependency
advisory status, the `ppv_core` CPI boundary, and proof-backed settlement.
