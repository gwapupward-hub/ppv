# PPV — RR-13 independent security review brief

**Frozen audit target: `0190248f6199398dfe4ce632e513123cb00b0cb0`**
Repository: `gwapupward-hub/ppv` · Cluster in evidence: devnet · Mainnet: **not authorized**

No independent reviewer has examined this code. Nothing in this repository —
including the repository-local engineering skill under `.claude/skills/` — is
an independent review or a substitute for one.

---

## 1. What you are reviewing

```bash
git clone https://github.com/gwapupward-hub/ppv.git
cd ppv
git checkout 0190248f6199398dfe4ce632e513123cb00b0cb0
git status --porcelain                              # must print nothing
sha256sum -c docs/security/rr13/MANIFEST.sha256     # from the repository root
```

Review **that commit**, not `main`. `docs/security/rr13/**` is a
non-invalidating path, so this package's own edits advance `main` without
moving the target — see [14-change-control.md](14-change-control.md). If `main`
is ahead, satisfy yourself nothing security-sensitive moved:

```bash
for t in programs sdk indexer tests deployments .github; do
  echo "$t $(git rev-parse 0190248:$t) $(git rev-parse main:$t)"
done
```

Each line's two hashes must match.

No deployer key, custody signer, funder key or private RPC credential is
required for any part of the static review. Full commands and tiers:
[09-reproduction.md](09-reproduction.md).

## 2. The architectural claim

> **Core proves facts. Commerce proves agreements. Escrow controls value.**

`ppv_core` and `ppv_commerce` are non-custodial. `ppv_escrow` is the custody
boundary and the highest-risk component.

| Program | ID |
| --- | --- |
| `ppv_core` | `9cWE41ZDNQChvFrRoVuPQDeoVLg46ACTiZRCZaBZzfwU` |
| `ppv_commerce` | `GmRDoFuPrBrsxnvTX751WK5rLu14JXe4sgjh6vNwHzr3` |
| `ppv_escrow` | `7U1bCHQcr8Jg6J8G69JGaAWCRtsrZB1RYx4zo1sNEVF4` |

**There is no on-chain Commerce↔Escrow binding.** No CPI, no stored program id,
no cross-program PDA, no referencing field. Any link between a negotiated
Commerce agreement and an escrowed `EscrowAgreement` is off-chain convention.
Do not assume one exists; the deployed architecture does not provide one.

**Two proof identities, not one.** The escrow `Proof` PDA (owner `ppv_escrow`)
records what an agreement decided; the `ppv_core` `ProofRecord` (owner
`ppv_core`, published in events as `coreProof`) is the commitment itself. They
are bound by `Proof.core_proof`. Asking Core's ownership question of the escrow
account is a category error and was a real defect once.

**Token scope.** Classic SPL Token is **in** the current security claim.
**Token-2022 is out of it** — rejected at the type boundary, not partially
supported.

## 3. Review priorities, highest first

1. **Escrow custody and value safety.** One function moves value:
   `pay_out_of_vault`. Settlement, milestone settlement, refund and dispute
   resolution differ in who may call and from which state — never in how
   custody moves.
2. **The Core↔Escrow proof boundary.** The protocol's only CPI, and the least
   independently attacked surface. `submit_proof.rs`.
3. **Signer and account substitution.** Confused deputy, counterparty
   substitution, wrong vault/authority/mint/destination, foreign milestone or
   proof, attacker-controlled token accounts.
4. **State-machine integrity.** Eleven legal edges in `LEGAL_EDGES`; terminal
   states absorbing against all 17 instructions; a milestone contract never
   reaching `Completed`.
5. **Value conservation.** `settled_total ≤ amount` across every interleaving;
   `milestone_total == amount` at funding; `remaining()` saturation.
6. **Milestones.** Ordering, repeat approval/rejection, double release,
   overpay, wrong recipient.
7. **Disputes and refunds.** Concession-only resolution; `CannotConcedeToSelf`;
   refund reaching only the buyer, on the seller's signature.
8. **Bounties.** Payee assigned once, by the sponsor, never replaced; nothing
   completes or settles before a payee exists.
9. **Transaction lifecycle.** Signature known before broadcast; no blind resend
   of value-moving transactions; an expected refusal requires a *landed* failed
   transaction; infrastructure failure must never read as protocol refusal.
10. **Governance.** Squads 2-of-3 per program; the devnet-only shared-signer
    exception; upgrade authority on chain versus the committed record.
11. **Proof-lifecycle property and mutation gaps** — see §5.

Per-instruction detail: [04-escrow-attack-surface.md](04-escrow-attack-surface.md).
Ranked checklist: [10-auditor-checklist.md](10-auditor-checklist.md).

## 4. What the team already proved

| Tier | State |
| --- | --- |
| fmt, clippy, typecheck | green |
| 76 host unit tests | green |
| 813 release/tooling tests | 812 pass, 1 skipped, 0 fail |
| Property suite PPV-P1…P10 | green, release tier |
| Mutation qualification | 7 host classes + 4 property mutations, all detected |
| Local validator | green, double build with IDL comparison |
| Devnet custody matrix | RR-6 **CLOSED** — 9 lifecycle families, 43 landed refusals, every vault 0 |
| Reproducible build | built == on-chain binary hash |

CI on the frozen target: run `35560538644`, four of four required jobs.

## 5. Known assurance gaps — attack these

Stated rather than hidden. No property or fuzz infrastructure was added to make
this package look cleaner than it is.

* **The proof lifecycle is outside the randomized property model and outside
  mutation qualification.** `submit_proof`, `approve_proof`, `reject_proof` and
  proof-cited settlement carry deterministic negative tests and live devnet
  evidence, but not the randomized or mutation tier every other custody path
  has. **5 property gaps, 6 unqualified guards.** This is the single
  highest-value target in the codebase.
* **`ppv_core` CPI composition** under adversarial account substitution is not
  property-tested.
* **Upstream dependency advisory status is unverified.** Network egress during
  preparation was scoped to the project repository. Versions come from the
  repository's own lockfiles; whether any carries a published advisory at
  review time is genuinely open.
* **Donated surplus and vault rent are permanently stranded** (RR-3). Payouts
  derive from agreement fields, never `vault.amount`; no instruction closes a
  vault.
* **True concurrency is not simulated** (RR-5).
* **Arbiter-based dispute resolution does not exist** (RR-10); resolution is
  concession-only.

Full detail: [06-test-and-evidence-map.md](06-test-and-evidence-map.md) and
[07-known-risks.md](07-known-risks.md).

## 6. Findings — identifier discipline

| | |
| --- | --- |
| **Internal pre-audit findings** | **`F-01` … `F-09`** — the team's own, already in [finding-register.md](finding-register.md). F-01…F-05 resolved; F-06…F-09 open by design. |
| **Your findings** | **`RR13-001`, `RR13-002`, …** — reserved for you. No internal finding uses these ids, and nothing internal should be read as an independent finding. |

Please report severity, confidence, evidence, exploit or failure path, impact,
remediation and a regression test per finding, and separate confirmed
vulnerabilities from defence-in-depth improvements.

### What closes RR-13

Completing the review does not close RR-13. RR-13 becomes **eligible** for
closure only when all of the following hold:

1. the independent review is complete;
2. every Critical finding is remediated;
3. every High finding is remediated;
4. those Critical and High remediations have been **independently
   re-reviewed**;
5. every Medium finding has an explicit disposition — fixed, accepted with
   rationale, or deferred with an owner;
6. the required review artifacts exist and the final target reconciliation is
   complete.

**Critical and High findings block closure until remediated *and*
independently re-reviewed.** Internal remediation alone is never sufficient.

Two statuses, and only one party may set each:

| Status | Who sets it | Meaning |
| --- | --- | --- |
| `REMEDIATED_PENDING_REVIEW` | the PPV team | a fix has been written and the team believes it addresses the finding |
| `VERIFIED_FIXED` | **the independent reviewer, only** | the fix has been examined and does address the finding |

The PPV team must not mark anything `VERIFIED_FIXED`, and a finding sitting at
`REMEDIATED_PENDING_REVIEW` still blocks closure if it is Critical or High.

## 7. Evidence you can verify independently

| Record | SHA-256 |
| --- | --- |
| `deployments/evidence/ppv-escrow-devnet-231dceb.json` | `7c74113405ec4a537aeb13a931c4c07c00bc476a8e4b899a5fbe2ac79ac15196` |
| `deployments/validation/ppv-escrow-devnet-live-custody-35465469908.json` | `c95943d6a658ee7723c18b5696f543fe98e0a49ad9b4a57269ca3a0b8411ad3c` |

Both are attested in [MANIFEST.sha256](MANIFEST.sha256) alongside the package,
the reviewed program source, the build and identity configuration, the security
documentation this package cites, the two mutation harnesses and the four
documentation/tamper guards the resolved findings rest on.

**Please do not re-run the custody matrix.** It sends roughly 70 value-moving
transactions to re-learn what the committed evidence already records.

## 8. Gate state — what your review does and does not decide

| Gate | State |
| --- | --- |
| RR-6 — custody behaviour reconstructed from chain | CLOSED |
| RR-7 — live Squads decode | CLOSED for the Escrow custody multisig; narrowed to Core/Commerce |
| **RR-13 — independent security review** | **OPEN** — eligible for closure only after the independent review is complete and all closure-blocking findings have been remediated and independently re-reviewed |
| Legal review | **OPEN** |
| Custody gate | **CLOSED** |
| Mainnet authorized | **NO** |

`RR13_AUDIT_ENTRY=READY_FOR_INDEPENDENT_REVIEW` answers one question only: is
the package coherent enough to hand over. It does not mean RR-13 passed, that a
security audit passed, that the system is production ready, or that mainnet is
authorized.
