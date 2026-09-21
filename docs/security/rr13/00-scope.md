# RR-13 — Scope of the independent security review

## Status of this document

This package prepares PPV for an independent production-readiness security
review. It is **not** that review, and it is not an RR-13 closure.

| Gate | State |
| --- | --- |
| RR-6 — custody behaviour reconstructed from chain | CLOSED |
| RR-7 — live Squads decode | CLOSED for the Escrow custody multisig; NARROWED to Core/Commerce |
| RR-13 — independent security review | **OPEN** |
| Legal review | **OPEN** |
| Custody gate | **CLOSED** |
| Mainnet authorized | **NO** |

Nothing in this package opens a gate, authorises a deployment, or authorises a
mainnet release.

## Review target

`main` has advanced past the frozen target since this package was written. The
two are distinguished here so a reviewer never has to guess which one a claim
is about.

### `FROZEN_RR13_SECURITY_TARGET` — what is under review

| Fact | Value |
| --- | --- |
| Repository | `gwapupward-hub/ppv` |
| **Commit under review** | **`0190248f6199398dfe4ce632e513123cb00b0cb0`** |
| Reached `main` as | "Resolve RR-13 pre-audit documentation findings F-01–F-05" (#47), squash-merged |
| Worktree at capture | clean |
| Baseline CI | green — workflow run 35560538644, all four required jobs |
| Previous target | `02b5b5286fab95ce68a4ca53d8b7768a738a1013`, re-frozen 2026-09-21 |

**Every claim in this package is made about that commit**, not about whatever
`main` points at when you read this. The commit is permanent and directly
checkoutable — see [09-reproduction](09-reproduction.md).

### Why the target moved

The F-01…F-05 remediation changed commentary in `scripts/lib/identity.mjs`,
which [14-change-control](14-change-control.md) lists as a
**target-invalidating path** — deliberately, so that "it's only a comment" is
never a judgement call made in passing. The target was therefore re-frozen at
that remediation's merge commit rather than left where it was.

`SECURITY_BEHAVIOR_CHANGED=NO`. Across the whole re-freeze,
`02b5b52 → 0190248`, every security-sensitive subtree is the **same git tree
object** — not merely free of visible diff:

| Subtree | `02b5b52` | `0190248` |
| --- | --- | --- |
| `programs/` | `1c3d2411…` | `1c3d2411…` |
| `sdk/` | `b258cc9f…` | `b258cc9f…` |
| `indexer/` | `e2697bd3…` | `e2697bd3…` |
| `tests/` | `84ee8932…` | `84ee8932…` |
| `deployments/` | `f06ac1a8…` | `f06ac1a8…` |
| `.github/` | `5fba144e…` | `5fba144e…` |

`Anchor.toml`, `Cargo.toml`, `Cargo.lock`, `package.json`, `package-lock.json`
and `rust-toolchain.toml` are byte-identical across both. And with comments
stripped, `scripts/lib/identity.mjs` is byte-identical too — 42 lines of code,
unchanged — which is what makes the one invalidating path a commentary change
rather than a behavioural one.

### `PACKAGE_BASE_SHA` — where this package's text lives

The package documents the target; it is not part of it. `docs/security/rr13/**`
is a **non-invalidating** path, so edits to these files — including this
re-freeze — advance `main` without moving the frozen target. Expect
`PACKAGE_BASE_SHA` to sit one or more non-invalidating commits ahead of
`FROZEN_AUDIT_TARGET_SHA`, and review the target, not the tip.

`.claude/**` is non-invalidating for the same reason, and the skill it carries
is development tooling for this repository's own contributors. **It is not an
audit, and nothing it produced substitutes for the independent review RR-13
names.**

## What is in scope

* `programs/ppv_core` — proof primitive.
* `programs/ppv_commerce` — negotiation and signature primitive.
* `programs/ppv_escrow` — the custody boundary, and the highest-risk component.
* `sdk/` — encoders, decoders, PDA derivation, receipts.
* `indexer/` — event interpretation, replay, lifecycle reconstruction.
* `scripts/` — release, deployment, custody and recovery tooling, including the
  transaction lifecycle.
* `deployments/evidence/`, `deployments/validation/` — committed release and
  custody evidence.
* CI workflows that gate build, release, deployment and security.

## What is out of scope, and why

| Out of scope | Reason |
| --- | --- |
| Token-2022 and its extensions | Every custody account is typed `Program<Token>` / `Account<TokenAccount>`. A Token-2022 mint is rejected, not half-supported. See [07-known-risks](07-known-risks.md). |
| Mainnet deployment | Not authorized. No mainnet artifact, authority or evidence exists. |
| `AgreementType::Invoice`, `Contract`, `ProofOnly` | Refused at initialization (`UnsupportedAgreementType`). RR-9. |
| Arbiter-based dispute resolution | Not implemented. Resolution is concession-only. RR-10. |
| Fee math, partial settlement splits | No fee or split path exists in the kernel. |
| On-chain Commerce↔Escrow binding | **None exists.** See [03-trust-boundaries](03-trust-boundaries.md). |

## The architectural claim under review

> **PPV Core proves facts.**
> **PPV Commerce proves agreements.**
> **PPV Escrow controls value.**

Core and Commerce are non-custodial. Escrow is the custody boundary. Escrow
interacts with Core for agreement-bound proofs; it has no on-chain relationship
with Commerce.
