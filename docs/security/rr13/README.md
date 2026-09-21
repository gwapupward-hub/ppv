# RR-13 — Independent security review package

**Frozen RR-13 security target:** `02b5b5286fab95ce68a4ca53d8b7768a738a1013`

**Current repository head:** `bd99f2419ae0becdd52e5cb05d01cc79ce8dc26b` — two
commits ahead, both non-invalidating (this package, and `.claude/skills/**`
development tooling). Every security-sensitive subtree is identical across the
two. See [00-scope.md](00-scope.md) for the tree-hash evidence.

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
| [finding-register.md](finding-register.md) | internal pre-audit findings |
| [14-change-control.md](14-change-control.md) | what invalidates the target |
| [MANIFEST.sha256](MANIFEST.sha256) | hashes of this package and the source artifacts; verify from the repository root |

## Mandatory disclosures

* **No on-chain Commerce↔Escrow binding exists.**
* **Classic SPL Token is the current security claim.**
* **Token-2022 is outside the current security claim.**
* **One devnet Escrow custody signer overlaps Core/Commerce governance**;
  the exception is devnet-only and below the 2-of-3 threshold.
* **Legal review remains OPEN. Mainnet is NOT authorized.**
