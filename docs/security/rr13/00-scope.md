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

| Fact | Value |
| --- | --- |
| Repository | `gwapupward-hub/ppv` |
| Branch | `main` |
| Commit under review | `02b5b5286fab95ce68a4ca53d8b7768a738a1013` |
| Worktree at capture | clean |
| Baseline CI | green (workflow run 35486148014) |

Every claim in this package is made about that commit. Section
[14-change-control](14-change-control.md) states what invalidates it.

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
