# RR13-001 — Independent remediation review

**Repository:** `gwapupward-hub/ppv`  
**Pull request:** [#49 — Remediate RR13-001 Core proof revocation at settlement](https://github.com/gwapupward-hub/ppv/pull/49)  
**Reviewed head:** `a43dd0074a707b16117480a2871a4ef578edd07d`  
**Base:** `827f8f18efc3251c9c7f666ee660f25297d04f70`  
**Original frozen target recorded by the remediation:** `0190248f6199398dfe4ce632e513123cb00b0cb0`  
**Review date:** 2026-09-21

## Disposition

> **RR13-001: VERIFIED_FIXED at PR head `a43dd007…`.**

The original finding is valid against the frozen target: both proof-backed settlement paths checked only that the escrow `Proof` belonged to the agreement and was approved. They did not supply or inspect the linked `ppv_core::ProofRecord`, so a settlement could cite a commitment after its author had revoked it.

The remediation fixes the finding at the custody boundary. Both `settle` and `settle_milestone` call the same `require_cited_proof` validator before `pay_out_of_vault`. A cited escrow proof and its Core record are required together; an uncited Core account is rejected. The validator checks the Core account owner, Anchor discriminator/type, the address recorded in the escrow proof, the deterministic `ppv_core` PDA derived from `(submitter, agreement, proof_index)`, the Core authority against the escrow submitter, and finally `ProofStatus::Active`. A revoked record therefore cannot justify either settlement path.

The remediation also preserves liveness: citation remains optional. A revoked citation is rejected without moving funds, while the same payout remains reachable without a citation. The milestone path uses the same validator, so the fix is not limited to the single-payment path.

## Verification performed

### Source and target verification

The PR head was fetched from GitHub and checked out detached at the exact requested head. The PR is open, non-draft, mergeable, and based directly on the frozen main commit. The original target hash recorded in the remediation commit exists in repository history. The pre-remediation settlement source at that target confirms the missing Core status check in both settlement paths.

### Security logic review

The implementation was reviewed across:

| Area | Result |
| --- | --- |
| Shared settlement enforcement | Both `handle_settle` and `handle_settle_milestone` call `require_cited_proof` before token movement. **Pass.** |
| Optional-account pairing | `(settlement_proof, core_proof)` is enforced as both present or both absent. **Pass.** |
| Core account owner | Owner must equal `ppv_core::ID`. **Pass.** |
| Core account type | `ProofRecord::try_deserialize` enforces the Core discriminator/layout. **Pass.** |
| Recorded-address binding | Presented Core account must equal `Proof.core_proof`. **Pass.** |
| Derived-address binding | Presented account must equal the PDA derived from the escrow proof’s submitter, agreement, and index under `ppv_core::ID`. **Pass.** |
| Authority binding | `ProofRecord.authority` must equal `Proof.submitter`. **Pass.** |
| Revocation check | Only `ProofStatus::Active` is accepted; `Revoked` returns `CoreProofRevoked`. **Pass.** |
| Pre-custody ordering | Validation occurs before `pay_out_of_vault` in both paths. **Pass.** |
| Liveness | Uncited settlement remains available after revocation; no custody deadlock is introduced. **Pass.** |
| Other payout paths | Refund and dispute-resolution paths do not cite proof evidence and are outside this finding. No unintended new dependency was found. **Pass.** |

No independent security finding was identified in the changed logic that would block verification of RR13-001.

### Regression and mutation evidence

The PR adds or preserves coverage for:

- Approved evidence with an Active Core commitment succeeds.
- Approved evidence with a revoked Core commitment fails before custody changes.
- A revoked citation remains payable without a citation.
- The same revocation behavior is exercised through milestone settlement.
- Citation without a Core record and Core record without citation are both rejected.
- Substitution with another agreement’s record, another index, another submitter, a foreign live record, the escrow proof account, a wallet, or a wrong-type account is rejected.
- Only the Core commitment authority can revoke; unrelated parties cannot create the denial condition.
- Three permanent mutations cover deletion of the Active guard, inversion of the status predicate, and removal of Core-account binding.

The completed PR CI run `35600960812` reports success for SDK, host program tests, Anchor local-validator tests, and property-suite mutation qualification. The PR head and all reported checks were verified through GitHub metadata.

## Execution limitation

This sandbox could not independently rerun Rust or Anchor tests: `cargo` is not installed, the Anchor/Solana toolchain is unavailable, and the checkout has no installed Node dependencies. The attempted focused Rust test and three RR13-001 mutation runs therefore failed at the environment/toolchain boundary, not because of a protocol assertion. Those results are recorded as **unrun locally**, not as passes. The completed GitHub CI results above are treated as corroborating repository evidence, while the security disposition is based on the independent source review and test/mutation inspection.

## Change-control state

The remediation changes security behavior and changes the settlement instruction account lists by adding an optional `core_proof` account to both settlement paths. The hand-written client builders and custody harness were updated accordingly. Existing error-code ordering was preserved by appending the new errors.

This review verifies the PR head only. It does **not** close RR-13, re-freeze the audit target, or replace the package manifest. After merge, the repository must perform the documented re-freeze procedure, regenerate and attest the post-merge package/IDL evidence, and keep the remaining disclosed assurance gap open: the randomized property model does not model proof lifecycle actions.

**Final status:** `RR13-001 = VERIFIED_FIXED`; `RR-13 = OPEN pending post-merge re-freeze and remaining audit gates`.

## Reviewed files

- `programs/ppv_escrow/src/instructions/settlement_proof.rs`
- `programs/ppv_escrow/src/instructions/settle.rs`
- `programs/ppv_escrow/src/instructions/milestone.rs`
- `programs/ppv_escrow/src/state/proof.rs`
- `programs/ppv_escrow/src/errors.rs`
- `tests/escrow.ts`
- `scripts/mutation-qualify.sh`
- `scripts/lib/escrow-instructions.mjs`
- `scripts/test/escrow-instructions.test.mjs`
- `docs/security/rr13/15-rr13-001-remediation.md`
- `docs/security/rr13/14-change-control.md`

*This is an independent remediation disposition for RR13-001, not a full protocol audit or a statement that the broader RR-13 review is closed.*

## Evidence pointers

- PR: https://github.com/gwapupward-hub/ppv/pull/49
- CI run: https://github.com/gwapupward-hub/ppv/actions/runs/35600960812
- Reviewed head commit: https://github.com/gwapupward-hub/ppv/commit/a43dd0074a707b16117480a2871a4ef578edd07d
- Original finding/remediation commit: https://github.com/gwapupward-hub/ppv/commit/f7d7fb0c81289c16184217c8fd3d611821ea5886

## Reproduction note

The repository checkout used for this review is available at `/home/ubuntu/rr13-review49/ppv`; the final report is intentionally separate from the reviewed working tree.

## Independent reviewer signature

**Disposition:** `VERIFIED_FIXED`  
**Scope:** RR13-001 only  
**Reviewer:** Manus independent review agent

---

### Appendix: concise decision rule

- Finding valid against frozen target: **Yes**.
- Remediation present in both value-moving settlement paths: **Yes**.
- Revoked Core commitment rejected before custody: **Yes, by source review and completed CI evidence**.
- Liveness preserved without citation: **Yes**.
- Required re-freeze after merge: **Yes**.
- Broader RR-13 closed: **No**.
- RR13-001 disposition: **VERIFIED_FIXED**.

---

## Review evidence files

The raw PR metadata and review extracts used in this disposition are preserved alongside this report under `/home/ubuntu/rr13-review49/evidence/`.

- `pr49.json`
- `pr49-diff.txt`
- `test-diff.txt`
- `ci-jobs.json` (the attempted API response was empty in this environment and is not relied upon)

The authoritative CI status used above is the completed PR check rollup retrieved from GitHub during review.

---

**End of independent review.**
