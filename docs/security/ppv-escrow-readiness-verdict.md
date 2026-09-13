# PPV Escrow devnet deployment readiness — Sprint 3 verdict

# PPV ESCROW DEVNET DEPLOYMENT READINESS: NO-GO

Issued at the close of Sprint 3, the security and custody qualification sprint.
This document is the authoritative readiness verdict for `ppv_escrow`. Where any
other document in this repository implies a different one, this document wins
and the other is stale.

**This verdict authorises nothing and forbids nothing new.** `ppv_escrow` was
not deployed during Sprint 3 and is not deployed now. The custody gate in
[deployment-gates.md](../deployment-gates.md) is closed and did not move.

## Why NO-GO

Not because anything is known broken. Zero CRITICAL and zero HIGH residual risks
remain, and no path was found to unauthorized value movement, double payout,
wrong-recipient payout, account substitution, terminal-state resurrection, or
cross-agreement release.

NO-GO because one qualification criterion is factually unmet, and a criterion is
not met more by being wanted badly.

### Blocker 1 — milestones and bounties are not modelled under randomized adversarial execution

The release qualification suite was required to carry model domains for
disputes/refunds, milestones, bounties, and cross-program bindings. Disputes and
refunds were added in this sprint and are attacked by 15,337 randomized
operations across five seeds. **Milestones and bounties are not in the
randomized suite.**

They are not unexamined: both lifecycles are walked exhaustively at the
authorization and state layer by `state/lifecycle_model.rs` (1,008 cells), and
covered by 18 deterministic local-validator tests. Their payouts run through
`pay_out_of_vault`, the same function the randomized suite does attack.

What is missing is randomized attack on the lifecycles *around* those payouts —
and `settle_milestone` is the one value-moving instruction whose amount comes
from a separate account rather than from the agreement's own `remaining()`. That
is a distinct custody surface, and randomized sequence testing is what finds
defects in it.

Tracked as **RR-1**.

### Blocker 2 — the randomized layer is not mutation-qualified

`scripts/mutation-qualify.sh` breaks seven defences and requires the suite to
fail. All seven are detected. **It exercises the host model only.**

So for the randomized property suite — precisely the layer that would have to
catch a milestone or bounty custody defect once Blocker 1 is closed — there is
no evidence it would detect an injected defect at all. A suite whose detection
power is unmeasured cannot be the thing that closes the other blocker.

Tracked as **RR-8**.

### Why these were not waived

Sprint 3 found two custody defects in a program that had passed every gate
before it, one of which was visible only by enumerating all 1,008 guard
configurations. A surface that yields defects to closer attention is not a
surface to stop attacking because the remaining budget is inconvenient.

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

## What Sprint 3 did establish

| | |
| --- | --- |
| Custody findings opened and closed | 2 |
| Governance findings opened and closed | 1 |
| Exhaustive state-machine cells | 1,008, zero divergences |
| Randomized operations, release tier | 15,337 across 5 seeds |
| Invariant violations | **0** |
| Mutations injected and detected | 7 of 7 |
| Terminal-state attacks | 4,890 |
| Wrong-relationship refusals | 5,578 |

The findings are recorded in the
[attack matrix](ppv-escrow-attack-matrix.md) as S-9/B-5, C-3 and G-5. The
instruction surface and the real state graph are in
[ppv-escrow-surface.md](ppv-escrow-surface.md). Everything unresolved is in the
[residual-risk register](ppv-escrow-residual-risk.md).

## What would change this verdict

A narrowly scoped sprint:

1. Milestone and bounty action kinds in `tests/invariants/`, with per-milestone
   model state — closes **RR-1**.
2. Custody mutations run against the property suite at the PR budget — closes
   **RR-8**.
3. Re-run release qualification and re-issue this verdict.

Nothing else in the residual-risk register blocks a GO. RR-11, RR-12 and RR-13
are deployment-sprint prerequisites rather than qualification blockers: they
must be satisfied before `ppv_escrow` reaches a cluster, and none of them is
work this qualification could have done.
