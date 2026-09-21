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
| **RR-13** | **OPEN — closed only by your review** |
| Legal review | **OPEN** |
| Custody gate | **CLOSED** |
| Mainnet authorized | **NO** |

No independent reviewer has yet examined this code. Nothing in this repository,
including the repository-local engineering skill under `.claude/skills/`, is an
independent review or a substitute for one.
