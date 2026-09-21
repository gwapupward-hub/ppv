# RR13-001 — post-merge re-freeze record

**Date:** 2026-09-21

This record reconciles the RR-13 audit package after the independently verified
RR13-001 remediation was squash-merged. It does not authorize deployment and
does not close RR-13.

## Target chain

| Field | Value |
| --- | --- |
| Original frozen target where RR13-001 was found | `0190248f6199398dfe4ce632e513123cb00b0cb0` |
| Independently reviewed remediation head | `a43dd0074a707b16117480a2871a4ef578edd07d` |
| Independent disposition | `RR13_001_STATUS=VERIFIED_FIXED` |
| PR | #49 — Remediate RR13-001 Core proof revocation at settlement |
| Squash-merge commit on `main` | `e574c69570979081e34e0358673c62f87ba9220d` |
| New frozen RR-13 security target | `e574c69570979081e34e0358673c62f87ba9220d` |
| Security behavior changed from old target | **YES** |
| IDL changed | **YES** — optional `core_proof` account added to `settle` and `settle_milestone` |

The independently reviewed PR head and the merge commit have the identical Git
tree object:

`c224791e4468b75a5cc2e89fb1da3e7c325b8c95`

The squash merge therefore changed commit identity and parentage, not the
reviewed source tree.

## Independent review

The independent disposition is preserved in
[17-rr13-001-independent-review.md](17-rr13-001-independent-review.md).

The reviewer verified the live-Core-validity rule in both value-moving
settlement paths, optional citation liveness, account substitution resistance,
pre-custody ordering, the IDL/interface change, and the RR13-001
regression/mutation evidence. The reviewer explicitly did not close broader
RR-13.

## CI reconciliation

PR CI run `35600960812` was green for SDK, host program tests, Anchor local
validator, and property-suite mutation qualification at the reviewed head.

Post-merge push CI run `35613748305` executes against the exact new target.
Its first Anchor-local-validator attempt failed before protocol tests because
`cargo_build_sbf` received an HTTP 504 while downloading Solana
`platform-tools`. That is an infrastructure failure, not a protocol assertion.
A clean retry is required before this re-freeze record is final.

`POST_MERGE_CI_STATUS=PENDING_INFRA_RETRY`

## Residual state

```text
RR13_001=VERIFIED_FIXED
F06=OPEN_NARROWED
RR13_002=OPEN_INFORMATIONAL
RR_13=OPEN
LEGAL_REVIEW=OPEN
CUSTODY_GATE=CLOSED
MAINNET_AUTHORIZED=NO
```

F-06 remains open because the randomized property model still does not model
proof-lifecycle actions directly. RR13-001 narrowed that assurance gap through
direct regressions and mutation qualification; it did not close the gap.

## Manifest rule

The old manifest remains the attestation for the old frozen target until this
reconciliation is complete. The new manifest must be generated from the
repository-root-relative file set after all docs-only reconciliation edits are
final, must include the RR13-001 remediation and independent-review records, and
must not hash itself.

No program was deployed or upgraded as part of this re-freeze.

## Final re-freeze completion — 2026-09-21

The pending state above is historical. The re-freeze is now complete.

PR #50 merged as docs-only commit:

`54af83c405873eadf9ea24d0165e70312fff535f`

Post-merge CI run `35630872920` (CI #194) completed successfully with all
four required jobs green:

- Solana programs (host)
- SDK
- Anchor local validator
- Property-suite mutation qualification

The frozen security target remains:

`e574c69570979081e34e0358673c62f87ba9220d`

The following security-sensitive trees and root build/config files are
byte-identical between the frozen target and package base `54af83c4…`:
`programs/`, `sdk/`, `indexer/`, `tests/`, `scripts/`,
`deployments/`, `.github/`, `Anchor.toml`, `Cargo.toml`, `Cargo.lock`,
`package.json`, `package-lock.json`, and `rust-toolchain.toml`.

Therefore CI #194 validates the exact same security-sensitive source tree while
the docs-only package reconciliation lives one commit ahead.

```text
POST_MERGE_CI_STATUS=SUCCESS
RE_FREEZE_FINAL=YES
RR13_001=VERIFIED_FIXED
F06=OPEN_NARROWED
RR13_002=OPEN_INFORMATIONAL
RR_13=OPEN
LEGAL_REVIEW=OPEN
CUSTODY_GATE=CLOSED
MAINNET_AUTHORIZED=NO
```

The regenerated `MANIFEST.sha256` attests the reconciled package and reviewed
source/config/evidence set and is verifiable from the repository root.
