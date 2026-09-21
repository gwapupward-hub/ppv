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
| Commit under review | `02b5b5286fab95ce68a4ca53d8b7768a738a1013` |
| Reached `main` as | "Land PPV Escrow live custody evidence and close RR-6" (#43) |
| Worktree at capture | clean |
| Baseline CI | green (workflow run 35486148014) |

**Every claim in this package is made about that commit**, not about whatever
`main` points at when you read this. The commit is permanent and directly
checkoutable — see [09-reproduction](09-reproduction.md).

> **Pending re-freeze.** The F-01…F-05 remediation changes commentary in
> `scripts/lib/identity.mjs`, which [14-change-control](14-change-control.md)
> lists as a target-invalidating path. The target is therefore re-frozen at
> that remediation's merge commit, recorded in the amendment table there. The
> change is comment-only and `SECURITY_BEHAVIOR_CHANGED=NO`, but the path is
> listed precisely so "it's only a comment" is never a judgement call made in
> passing.

### `CURRENT_REPOSITORY_HEAD` — what `main` points at

| Fact | Value |
| --- | --- |
| Commit | `bd99f2419ae0becdd52e5cb05d01cc79ce8dc26b` |
| Ahead of the target by | 2 commits, both merged after the target was frozen |
| `1c24aaa624c9c89083d48cdf7bf25e55d24141f9` | this package itself (#45), `docs/security/rr13/**` only |
| `bd99f2419ae0becdd52e5cb05d01cc79ce8dc26b` | repository-local development tooling (#44), `.claude/skills/**` only |
| CI on that head | green — workflow run 35498756470, all four jobs |

### Why the newer head does not move the target

Neither commit touches a security-sensitive path. This is asserted by tree
hash rather than by reading a diff, so it cannot be satisfied by a change that
merely looks equivalent:

| Subtree | `02b5b52` | `1c24aaa` | `bd99f24` |
| --- | --- | --- | --- |
| `programs/` | `1c3d2411…` | `1c3d2411…` | `1c3d2411…` |
| `sdk/` | `b258cc9f…` | `b258cc9f…` | `b258cc9f…` |
| `indexer/` | `e2697bd3…` | `e2697bd3…` | `e2697bd3…` |
| `tests/` | `84ee8932…` | `84ee8932…` | `84ee8932…` |
| `scripts/` | `4bb1de53…` | `4bb1de53…` | `4bb1de53…` |
| `deployments/` | `f06ac1a8…` | `f06ac1a8…` | `f06ac1a8…` |

`Anchor.toml`, `Cargo.toml`, `Cargo.lock`, `package.json`, `package-lock.json`
and `rust-toolchain.toml` are likewise byte-identical across all three commits.

`.claude/**` is listed as a **non-invalidating** path in
[14-change-control](14-change-control.md), and the skill it carries is
development tooling for this repository's own contributors. **It is not an
audit, and nothing it produced substitutes for the independent review RR-13
names.** Section [14-change-control](14-change-control.md) states what would
invalidate the target.

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
