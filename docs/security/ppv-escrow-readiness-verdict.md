# PPV Escrow devnet deployment readiness — verdict

# PPV ESCROW DEVNET DEPLOYMENT READINESS: GO

Issued at the close of Sprint 3.1. This document is the authoritative readiness
verdict for `ppv_escrow`. Where any other document in this repository implies a
different one, this document wins and the other is stale.

## What this GO means, and what it does not

It means the implementation has passed the security and readiness criteria of
Sprints 3 and 3.1, and may enter a **separately controlled deployment sprint**.

It does **not** mean the program can be deployed now. Three prerequisites are
open, and none of them is code:

- there is no permanent `ppv_escrow` identity (**RR-12**),
- the separate custody multisig the gate requires does not exist (**RR-11**),
- no independent security review has been done (**RR-13**).

`ppv_escrow` was not deployed during Sprint 3.1, is not deployed now, and the
custody gate in [deployment-gates.md](../deployment-gates.md) is closed and did
not move. **SECURITY QUALIFICATION GO is not READY TO DEPLOY.**

## Why the verdict changed

Sprint 3 returned NO-GO on two blockers. Both are closed with evidence.

### RR-1 — milestones and bounties are now attacked under randomized execution

The release-tier run, 5 seeds × 200 sequences, **17,607 attempted operations and
zero invariant violations**:

| | escrow | milestone | bounty |
| --- | --- | --- | --- |
| sequences | 362 | 315 | 323 |
| lifecycle actions | — | 4,998 | 5,577 |

Milestones: 576 tranches scheduled, 169 released, 348 duplicate-release
attempts, 362 foreign-account substitutions, 1,185 post-terminal attempts.
Bounties: 306 winners named, 1,081 replacement attempts, 144 payout attempts
against a bounty with no winner.

It did not close on the first attempt. The first run failed its own coverage
floor — tranches scheduled, none released — because reaching a release needs six
ordered actions and the expected sequence length to get there was about 47
against a budget of 32. That is the fictional coverage RR-1 was about, caught by
the floor rather than by inspection.

### RR-8 — the randomized suite is now mutation-qualified

Four defects injected one at a time, each requiring **the property suite** to
fail, each reverted, with the clean suite green afterwards:

| Mutation | Class | Detected |
| --- | --- | --- |
| an already-settled tranche may be released again | milestone lifecycle finality | yes |
| a tranche may be paid to any account of the right mint | destination binding | yes |
| a tranche pays out everything the vault still owes | custody conservation | yes |
| a bounty sponsor may replace the winner after naming one | bounty lifecycle finality | yes |

Two survived their first run. The cause was the generator, not the assertions:
the agreement's own second tranche shared the foreign account's weight, tranches
were always released in the same order, and prefix lengths were biased toward
"barely started". No mutation was made easier and no assertion was weakened.

### What the sprint found along the way

One invariant was wrong, and the suite caught it: **PPV-M5 asserted that a
settled milestone contract has released every tranche.** It does not have to. A
buyer who concedes a disputed milestone contract hands over the whole remaining
balance and the contract terminates with both tranches pending — the mirror
image of a refund, and safe for the same reason. The model and the chain agreed
on every observable; the assertion was the defect. PPV-M5 now states the
direction that can be violated, and both directions are pinned as regressions.

**No protocol defect was found in Sprint 3.1, and no protocol code changed.**

## Statements of record

These are the facts this sprint establishes. They are asserted by
`scripts/test/custody-gate.test.mjs` and `scripts/test/attack-matrix.test.mjs`,
so a change that makes one of them untrue fails CI rather than going unnoticed.

### PPV Escrow is not deployed and cannot be deployed by this repository

`ppv_escrow` is absent from `[programs.devnet]`, from the devnet deploy
workflow's program choices, from `record-deployment.sh`, and from the permanent
program-identity table. The deploy workflow holds no escrow signing material of
any kind. **PPV ESCROW DEPLOYED: NO. PPV ESCROW CUSTODY GATE: CLOSED.**

### `7BECot7zFqH2oCxTu9uLmmwvzQSBtxWro47jMa2MqUdR` is a build/local placeholder

It is **not** an approved permanent deployment identity and must never be
represented as one. It appears only in `declare_id!` and
`[programs.localnet]`, so the workspace builds and the local validator suites
run. No permanent `ppv_escrow` identity exists, and no `ppv_escrow` keypair
exists anywhere in this repository — which is the safest state an unreleased
identity can be in, because a key that does not exist cannot leak and an address
that is not claimed cannot be occupied by accident.

Creating one is a deliberate ceremony belonging to a future deployment sprint.
It was explicitly out of scope for Sprint 3 and for this closeout. Tracked as
**RR-12**.

### PPV-X1, PPV-X2 and PPV-X3 are NOT APPLICABLE — they do not pass

Agreement binding, party binding and terms binding describe a relationship
between `ppv_escrow` and `ppv_commerce` that **does not exist in the
implementation**. `ppv_escrow` does not reference `ppv_commerce` anywhere; it
carries its own parties and its own `terms_hash`, and its only cross-program
dependency is the proof CPI into `ppv_core`.

"Escrow cannot be tricked into moving assets for a different logical agreement"
is therefore true trivially, because escrow has no concept of an upstream
agreement to confuse. Reporting a trivially-true invariant as *verified* is how
a design gap becomes a surprise during a deployment sprint, so these three are
recorded as NOT APPLICABLE and are excluded from the passing set.

PPV-X4 — program identity separation — does apply and does pass. Tracked as
**RR-4**.

### The separate custody multisig required by policy does not exist

The custody gate requires `ppv_escrow`'s upgrade authority to be held by a
multisig **separate** from the non-custodial programs, so that compromising one
cannot reach the other. There is one Squads 2-of-3 vault today
(`B6tcsTrMCKTZV5vi3rRCnA3FMPeeWACSHuuTSz5XQgnX`), holding Core and Commerce. A
second, independent multisig has not been created.

This is a prerequisite with real lead time — new keys, new holders, new
threshold policy — and no code sprint produces it. Tracked as **RR-11**.

### PPV Core and PPV Commerce remain verified and unchanged

**PPV CORE DEVNET RELEASE: VERIFIED. PPV COMMERCE DEVNET RELEASE: VERIFIED.**

Neither was redeployed. Neither had its permanent identity, upgrade authority,
or security invariants changed by this sprint. Both are re-verified against live
devnet on every run of the "Verify deployed PPV programs" workflow, which was
green on the commit this verdict was issued from.

The only protocol code Sprint 3 changed is
`programs/ppv_escrow/src/state/agreement.rs`.

## What the two sprints established

| | Sprint 3 | Sprint 3.1 |
| --- | --- | --- |
| Custody findings opened and closed | 2 | 0 |
| Governance findings opened and closed | 1 | 0 |
| Protocol code changed | `state/agreement.rs` | none |
| Exhaustive state-machine cells | 1,008, zero divergences | unchanged |
| Randomized operations, release tier | 15,337 across 5 seeds | **17,607** across 5 seeds |
| Agreement types attacked randomly | 1 | **3** |
| Invariant violations | 0 | **0** |
| Host-model mutations detected | 7 of 7 | 7 of 7 |
| Property-suite mutations detected | not measured | **4 of 4** |
| Terminal-state attacks | 4,890 | 6,028 |
| Wrong-relationship refusals | 5,578 | 4,856 |

The findings are recorded in the
[attack matrix](ppv-escrow-attack-matrix.md) as S-9/B-5, C-3 and G-5. The
instruction surface and the real state graph are in
[ppv-escrow-surface.md](ppv-escrow-surface.md). Everything unresolved is in the
[residual-risk register](ppv-escrow-residual-risk.md).

## What a deployment sprint must still do

Nothing in the residual-risk register blocks this GO. Three entries block a
*deployment*, and each is an operator task rather than an engineering one. The
ceremony is written out step by step in
[the release runbook](../ppv-escrow-release-runbook.md).

1. **RR-12** — generate the permanent `ppv_escrow` identity, in the same kind of
   ceremony that produced Core's and Commerce's, and freeze it across every
   identity source in one commit. No keypair exists today, which is the safest
   state an unreleased identity can be in.
   `scripts/test/escrow-identity.test.mjs` enforces both states and refuses a
   half-entered transition.
2. **RR-11** — create the dedicated custody multisig, so that compromising the
   non-custodial programs' governance cannot reach Escrow's vault.
   `scripts/verify-custody-governance.mjs` proves a configuration satisfies
   policy before it is given authority over anything, from public facts alone.
3. **RR-13** — obtain an independent security review of the custody path. Two
   sprints of self-review found three custody-relevant defects, which is
   evidence that the surface rewards attention, not a substitute for someone
   else attacking it.

Then the deployment itself: one initial deploy at the permanent address,
immediate authority transfer to the custody vault, binary provenance proved by
byte-equal hashes, a frozen evidence record, live custody validation, and only
then the custody gate.

`ppv_escrow` is deliberately absent from `[programs.devnet]`, from the deploy
workflow's program choices and from `record-deployment.sh`, and stays absent
until the identity freeze. Wiring a deploy path before a permanent identity
exists would create a button pointing at the build-only placeholder — an address
nobody chose, on the one program that holds value.
