# Independent review handoff

Everything an independent reviewer needs to start, and an explicit statement of
what this handoff is not.

## The two SHAs, kept apart

| | Value |
| --- | --- |
| **`FROZEN_AUDIT_TARGET_SHA`** | **`0190248f6199398dfe4ce632e513123cb00b0cb0`** |
| `PACKAGE_BASE_SHA` | the commit this package's text lives at — `main` at or after the re-freeze reconciliation |

**Review the target, not `main`.** `docs/security/rr13/**` is a
[non-invalidating path](14-change-control.md), so this package's own edits
advance `main` without moving the target. At the moment of writing, the package
text sits at the target; the reconciliation commit that publishes it will put
`PACKAGE_BASE_SHA` one commit ahead. That divergence is expected and is not
drift.

If the two differ when you read this, confirm for yourself that nothing
security-sensitive moved between them:

```bash
for t in programs sdk indexer tests deployments .github; do
  echo "$t $(git rev-parse 0190248:$t) $(git rev-parse main:$t)"
done
```

Each line's two hashes must match. If one does not, the target has been moved
without an amendment and [14-change-control](14-change-control.md) is the
document at fault — say so.

## Access

Public repository, no credential required for the whole static review:

```bash
git clone https://github.com/gwapupward-hub/ppv.git
cd ppv
git checkout 0190248f6199398dfe4ce632e513123cb00b0cb0
git status --porcelain          # must print nothing
sha256sum -c docs/security/rr13/MANIFEST.sha256   # from the repository root
```

Full commands, tiers and the optional live read-only checks are in
[09-reproduction](09-reproduction.md). No deployer key, custody signer, funder
key or private RPC credential is needed for any part of the static review.

## What you are receiving

| Item | Where |
| --- | --- |
| Scope, and what is excluded | [00-scope](00-scope.md) |
| Architecture and the one CPI boundary | [01-architecture](01-architecture.md) |
| Program identities and deployment evidence | [02-program-identities](02-program-identities.md) |
| Trust boundaries, custody boundary, governance | [03-trust-boundaries](03-trust-boundaries.md) |
| All 17 escrow instructions, per-instruction | [04-escrow-attack-surface](04-escrow-attack-surface.md) |
| 46 invariants mapped to code and test tier | [05-security-invariants](05-security-invariants.md) |
| Verification ladder, mutation qualification, gaps | [06-test-and-evidence-map](06-test-and-evidence-map.md) |
| Disclosed risks and the residual-risk register | [07-known-risks](07-known-risks.md) |
| Toolchain, reproducibility, Squads governance | [08-deployment-governance](08-deployment-governance.md) |
| Reproduction commands | [09-reproduction](09-reproduction.md) |
| Ranked review targets | [10-auditor-checklist](10-auditor-checklist.md) |
| Internal pre-audit findings | [finding-register](finding-register.md) |
| Change control and the re-freeze amendment | [14-change-control](14-change-control.md) |
| Hashes for the package, source, config, evidence and guards | [MANIFEST.sha256](MANIFEST.sha256) |

### Evidence records, hashed in the manifest

| Record | SHA-256 |
| --- | --- |
| `deployments/evidence/ppv-escrow-devnet-231dceb.json` | `7c74113405ec4a537aeb13a931c4c07c00bc476a8e4b899a5fbe2ac79ac15196` |
| `deployments/validation/ppv-escrow-devnet-live-custody-35465469908.json` | `c95943d6a658ee7723c18b5696f543fe98e0a49ad9b4a57269ca3a0b8411ad3c` |
| `deployments/evidence/ppv-core-devnet-861a8df.json` | in manifest |

## The archive, and why the commit is the real artifact

A zip is a convenience copy. The authoritative artifact is the git commit
`0190248f6199398dfe4ce632e513123cb00b0cb0`, because it is what CI ran against
and what the manifest attests.

If you want a single file to send or receive, build it deterministically —
fixed timestamps, sorted entries, no extra attributes — so two people building
it from the same commit get byte-identical output and the same SHA-256:

```bash
git checkout 0190248f6199398dfe4ce632e513123cb00b0cb0
find docs/security/rr13 programs deployments \
     Anchor.toml Cargo.toml Cargo.lock rust-toolchain.toml \
     package.json package-lock.json scripts/lib/identity.mjs \
     docs/invariants.md docs/property-testing.md docs/deployment-gates.md \
     docs/security/ppv-escrow-attack-matrix.md \
     docs/security/ppv-escrow-residual-risk.md \
     docs/security/ppv-escrow-readiness-verdict.md \
     docs/security/ppv-escrow-surface.md \
     scripts/mutation-qualify.sh scripts/mutation-qualify-property.sh \
     scripts/test/escrow-freeze-tampering.test.mjs \
     scripts/test/escrow-current-state-docs.test.mjs \
     scripts/test/attack-matrix.test.mjs \
     scripts/test/coverage-docs.test.mjs \
  -type f | LC_ALL=C sort > /tmp/rr13-files.txt

TZ=UTC zip -X -q PPV-RR13-FINAL-HANDOFF.zip -@ < /tmp/rr13-files.txt
sha256sum PPV-RR13-FINAL-HANDOFF.zip > PPV-RR13-FINAL-HANDOFF.sha256
```

The archive's SHA-256 is deliberately **not** recorded in this package. Any
file inside the archive that quoted its own archive's hash would change that
hash by being edited — the hash is a property of the commit you build from, and
that commit is stated above. Verify the contents with
[MANIFEST.sha256](MANIFEST.sha256), which has no such circularity, and treat
the archive hash as a transport checksum agreed between sender and receiver.

## Reviewer brief

**Claim under review.** Core proves facts. Commerce proves agreements. Escrow
controls value. Core and Commerce are non-custodial; `ppv_escrow` is the
custody boundary and the highest-risk component.

**Where to start.** [10-auditor-checklist](10-auditor-checklist.md), items 1–3:

1. **Dependency advisory status.** The team could not check this — network
   egress during preparation was scoped to the project repository. Versions in
   [08-deployment-governance](08-deployment-governance.md) come from the
   repository's own lockfiles. Whether any carries a published advisory at
   review time is genuinely open.
2. **The `ppv_core` CPI boundary.** The protocol's only cross-program call, and
   the least independently attacked surface.
3. **Proof-backed settlement.** The path by which evidence becomes money, and
   the one custody path that is neither property-tested nor
   mutation-qualified.

**Known assurance gaps, stated rather than hidden.** F-06 … F-09 in the
[finding-register](finding-register.md) are open on purpose. The largest:

* the proof lifecycle (`submit_proof`, `approve_proof`, `reject_proof`,
  proof-cited settlement) sits **outside** the randomized property model and
  **outside** mutation qualification — 5 property gaps, 6 unqualified guards.
  It carries deterministic negative tests and live devnet evidence, which is
  assurance, but not the tier every other custody path has;
* `ppv_core` CPI composition under adversarial account substitution is not
  property-tested;
* upstream version currency and advisory status are unverified;
* donated surplus and vault rent are permanently stranded (RR-3).

No property or fuzz infrastructure was added to make this package look cleaner
than it is.

**Mandatory disclosures.** No on-chain Commerce↔Escrow binding exists. Classic
SPL Token is the current security claim; Token-2022 is outside it. One devnet
Escrow custody signer overlaps Core/Commerce governance, below the 2-of-3
threshold, devnet-scoped. Legal review is OPEN. Mainnet is NOT authorized.

## Finding identifiers

Internal pre-audit findings are **F-01 … F-09** and stay that way.
**`RR13-001`, `RR13-002`, … are reserved for you.** Nothing in this repository
uses them, and nothing internal should be read as an independent finding.

## What this handoff is not

`RR13_AUDIT_ENTRY=READY_FOR_INDEPENDENT_REVIEW` answers exactly one question:
is the package coherent enough to hand over. It does **not** mean RR-13 passed,
that a security audit passed, that the system is production ready, or that
mainnet is authorized.

| Gate | State |
| --- | --- |
| RR-6 | CLOSED |
| RR-7 | CLOSED (scoped: Escrow custody governance) |
| **RR-13** | **OPEN** — eligible for closure only after the independent review is complete and all closure-blocking findings have been remediated and independently re-reviewed |
| Legal review | **OPEN** |
| Custody gate | **CLOSED** |
| Mainnet authorized | **NO** |

Completing the review does not close RR-13. **Critical and High findings block
closure until remediated *and* independently re-reviewed**, Medium findings
need an explicit disposition, and the review artifacts and final target
reconciliation must be complete. The PPV team may mark a fix
`REMEDIATED_PENDING_REVIEW`; only the independent reviewer may mark it
`VERIFIED_FIXED`. Internal remediation alone is never sufficient. The full rule
is in
[PPV-RR13-INDEPENDENT-REVIEW-BRIEF.md](PPV-RR13-INDEPENDENT-REVIEW-BRIEF.md),
§6.

No independent reviewer has yet examined this code. Nothing in this repository,
including the repository-local engineering skill under `.claude/skills/`, is an
independent review or a substitute for one.

## Post-remediation handoff amendment — 2026-09-21

The initial handoff above is preserved as the record of the review that produced
RR13-001. For subsequent review:

| | Value |
| --- | --- |
| `FROZEN_AUDIT_TARGET_SHA` | `e574c69570979081e34e0358673c62f87ba9220d` |
| RR13-001 disposition | `VERIFIED_FIXED` |
| Independent review record | [17-rr13-001-independent-review.md](17-rr13-001-independent-review.md) |
| Re-freeze record | [18-rr13-001-post-merge-refreeze.md](18-rr13-001-post-merge-refreeze.md) |

The earlier statement that no independent reviewer had examined the code is
historical to the initial handoff and is superseded for RR13-001 by the signed
review record above. It does not imply that the broader RR-13 review is complete.

RR-13 remains OPEN. Legal review remains OPEN. Mainnet remains NOT authorized.
