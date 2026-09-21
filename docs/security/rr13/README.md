# RR-13 — Independent security review package

**Frozen RR-13 security target:** `0190248f6199398dfe4ce632e513123cb00b0cb0`

Re-frozen 2026-09-21 from `02b5b5286fab95ce68a4ca53d8b7768a738a1013`, because
the F-01…F-05 remediation touched `scripts/lib/identity.mjs` — a
target-invalidating path, even for a comment. `SECURITY_BEHAVIOR_CHANGED=NO`:
every security-sensitive subtree is the same git tree object across the move,
and `identity.mjs` is byte-identical with comments stripped. See
[00-scope.md](00-scope.md) for the evidence and
[14-change-control.md](14-change-control.md) for the amendment.

**Review the target, not `main`.** `docs/security/rr13/**` is non-invalidating,
so this package's own edits advance `main` without moving the target.

**Entry verdict:** `RR13_AUDIT_ENTRY=READY_FOR_INDEPENDENT_REVIEW` — internal
findings F-01…F-05 resolved; F-06…F-09 remain open by design. This is not an
RR-13 closure and not a passed audit. See
[finding-register.md](finding-register.md).

> Core proves facts. Commerce proves agreements. Escrow controls value.

| Gate | State |
| --- | --- |
| RR-6 | CLOSED |
| RR-7 | CLOSED (scoped: Escrow custody governance) |
| RR-13 | **OPEN** |
| Legal review | **OPEN** |
| Custody gate | **CLOSED** |
| Mainnet authorized | **NO** |

## Contents

| File | What it answers |
| --- | --- |
| [00-scope.md](00-scope.md) | what is being reviewed, and what is not |
| [01-architecture.md](01-architecture.md) | three programs, the one CPI boundary, the two proof identities |
| [02-program-identities.md](02-program-identities.md) | program IDs, ProgramData, hashes, evidence records |
| [03-trust-boundaries.md](03-trust-boundaries.md) | actors, custody boundary, token trust, governance |
| [04-escrow-attack-surface.md](04-escrow-attack-surface.md) | all 17 escrow instructions, per-instruction |
| [05-security-invariants.md](05-security-invariants.md) | 46 invariants mapped to implementation and test tier |
| [06-test-and-evidence-map.md](06-test-and-evidence-map.md) | verification ladder, mutation qualification, coverage gaps |
| [07-known-risks.md](07-known-risks.md) | mandatory disclosures and the residual-risk register |
| [08-deployment-governance.md](08-deployment-governance.md) | toolchain, reproducibility, Squads governance |
| [09-reproduction.md](09-reproduction.md) | exact commands, no secrets required |
| [10-auditor-checklist.md](10-auditor-checklist.md) | ranked review targets |
| [11-handoff.md](11-handoff.md) | independent-review handoff: the two SHAs, access, archive recipe |
| [PPV-RR13-INDEPENDENT-REVIEW-BRIEF.md](PPV-RR13-INDEPENDENT-REVIEW-BRIEF.md) | the brief to send the reviewer |
| [finding-register.md](finding-register.md) | internal pre-audit findings |
| [15-rr13-001-remediation.md](15-rr13-001-remediation.md) | RR13-001: reproduction, chosen protocol rule, griefing analysis, fix, coverage — `REMEDIATED_PENDING_REVIEW` |
| [16-rr13-002-disposition.md](16-rr13-002-disposition.md) | RR13-002: dependency advisories — `OPEN_INFORMATIONAL`, no remediation claimed |
| [14-change-control.md](14-change-control.md) | what invalidates the target |
| [MANIFEST.sha256](MANIFEST.sha256) | hashes of this package and the source artifacts; verify from the repository root |

## Mandatory disclosures

* **No on-chain Commerce↔Escrow binding exists.**
* **Classic SPL Token is the current security claim.**
* **Token-2022 is outside the current security claim.**
* **One devnet Escrow custody signer overlaps Core/Commerce governance**;
  the exception is devnet-only and below the 2-of-3 threshold.
* **Legal review remains OPEN. Mainnet is NOT authorized.**

## Current amendment — RR13-001 post-merge re-freeze (2026-09-21)

The original package text above is preserved as the historical handoff for the
target where RR13-001 was discovered. For subsequent RR-13 review activity, the
new security target is the squash-merge commit:

`e574c69570979081e34e0358673c62f87ba9220d`

RR13-001 has been independently assigned `VERIFIED_FIXED`. The reviewer report
is [17-rr13-001-independent-review.md](17-rr13-001-independent-review.md), and
the re-freeze reconciliation is
[18-rr13-001-post-merge-refreeze.md](18-rr13-001-post-merge-refreeze.md).

Broader status is unchanged: RR-13 OPEN, RR13-002 OPEN_INFORMATIONAL, F-06
OPEN_NARROWED, legal review OPEN, custody gate CLOSED, mainnet NOT authorized.

## Final RR13-001 re-freeze status — 2026-09-21

```text
FROZEN_RR13_SECURITY_TARGET=e574c69570979081e34e0358673c62f87ba9220d
RR13_001=VERIFIED_FIXED
RE_FREEZE_FINAL=YES
POST_MERGE_CI_RUN=35630872920
POST_MERGE_CI=SUCCESS
F06=OPEN_NARROWED
RR13_002=OPEN_INFORMATIONAL
RR_13=OPEN
LEGAL_REVIEW=OPEN
MAINNET_AUTHORIZED=NO
```

The current `MANIFEST.sha256` is the attestation for this reconciled package.
