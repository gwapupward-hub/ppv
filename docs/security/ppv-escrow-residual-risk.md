# PPV Escrow residual-risk register

**Readiness verdict: PPV ESCROW DEVNET DEPLOYMENT READINESS: GO** (Sprint 3.1).
**RR-1** and **RR-8**, the two entries that blocked Sprint 3's verdict, are
CLOSED with the evidence recorded below. Nothing else changed severity. See
[ppv-escrow-readiness-verdict.md](ppv-escrow-readiness-verdict.md) for the full
verdict and its statements of record — including what a GO does and does not
authorise.

What Sprint 3 did not resolve, classified honestly. Every entry here is
referenced from the [attack matrix](ppv-escrow-attack-matrix.md), so a risk
cannot exist in one document and not the other.

**Classification rule.** A risk is CRITICAL or HIGH if a path to it ends with
value moving to someone not entitled to it, value moving twice, or value that
cannot be recovered. It is MEDIUM or LOW if it ends with a weaker claim than
the repository makes — coverage that does not exist, evidence that is asserted
rather than read — without a known path to any of those outcomes. Severity is
about what an attacker can do, not about how much work the fix is.

## CRITICAL

**None.**

## HIGH affecting custody correctness

**None.**

Two custody findings were opened and closed inside this sprint. They are
recorded in the attack matrix as S-9/B-5 and C-3 rather than here, because they
are fixed, regression-tested and mutation-qualified:

- An unclaimed bounty could be disputed into a state with no exit, whose only
  reachable "resolution" sent custody to a token account owned by the default
  address. Only the sponsor could reach it, with its own money, and it was
  still a way for the vault to lose custody with no recovery.
- `record_payout` wrote its running total before validating it. Anchor unwinds
  the account on a returned error, so it was not exploitable as the program
  stood; it is recorded as the defect it was rather than the vulnerability it
  was not.

## MEDIUM

RR-1 and RR-8 are recorded here in place, marked CLOSED, rather than removed:
the identifiers are cited from the attack matrix and from two sprint verdicts,
and an entry that vanishes is indistinguishable from one nobody wrote down.

### RR-1 — Milestones and bounties are not randomly attacked — **CLOSED**

*Closed in Sprint 3.1.* Milestone contracts and bounties are now attacked by the
randomized model-based suite, not only by deterministic tests and the exhaustive
host model. A sequence carries an agreement flavour, and six action kinds joined
the model: `createMilestone`, `submitMilestone`, `approveMilestone`,
`rejectMilestone`, `settleMilestone`, `selectWinner`.

The release-tier run that closed it, 5 seeds × 200 sequences:

```json
{"attempted":17607,"succeeded":3532,"refused":14075,"refusedNonCanonical":4856,
 "escrowSequences":362,"milestoneSequences":315,"bountySequences":323,
 "milestoneActions":4998,"milestonesScheduled":576,"milestoneReleases":169,
 "milestoneDuplicateReleaseAttempts":348,"milestoneForeignAccountAttempts":362,
 "milestonePostTerminalAttempts":1185,
 "bountyActions":5577,"winnerSelections":306,"winnerReplacementAttempts":1081,
 "bountyPayouts":93,"bountyUnassignedPayoutAttempts":144}
```

Zero invariant violations.

**It did not close on the first try, and the reasons are worth keeping.** The
first run failed its own coverage floor — tranches scheduled, none released —
because reaching a release needs six ordered actions and the expected sequence
length to get there was about 47 against a budget of 32. Reachable in principle,
unreachable in practice, which is the fictional coverage this entry was about.
Three generator defects were behind it: the agreement's own second tranche
shared the *foreign* account's one-in-twelve weight, tranches were always
released in the same order, and `fc.nat` biased prefix lengths toward "barely
started".

Coverage floors now make this a gate rather than a claim: an action kind that
exists in the generator and is never selected fails the run, in the suite and in
the cross-seed aggregator.
`tests/invariants/reachability.test.ts` asserts the same reachability against
the model alone in milliseconds, so a generator change that closes a window
fails locally rather than after forty minutes of CI.

*What remains:* the randomized suite attacks one agreement per sequence, so
interactions *between* two live agreements of different types are still covered
only by the cross-agreement isolation tests. No path to one is known — every
instruction re-derives its accounts from the agreement it names — and it is not
tracked as a separate risk because PPV-P9 covers the substitution directly.

### RR-2 — Milestone state does not mean what a reader assumes

Two things about milestone contracts are true, deliberate, and not what someone
reading tranche state would guess.

**Release order is unconstrained.** A buyer can approve and release tranche 2
before tranche 1. Each tranche has its own submission and its own approval, and
nothing sequences them.

**A settled contract may have every tranche unreleased.** `resolve_dispute`
pays the whole remaining balance and terminates the agreement whatever the
tranche bookkeeping says, so a contract conceded by its buyer ends `Settled`
with both tranches `Pending`. The same is true of `refund`, which returns the
tranches nobody earned.

*Why neither is a defect:* no invariant is broken. `PPV-M1` and `PPV-M2` bound
the totals, `PPV-M3` bounds each tranche to one release, every release needs the
buyer's approval, and a terminal agreement can never release another tranche
because `require_milestone_active` demands `Funded`. Custody conserves in every
case.

*Evidence, since Sprint 3.1:* the randomized suite now releases tranches in a
generated order rather than always smallest-last, and the concession path is
pinned as a deterministic regression in
`tests/invariants/regression/milestone-dispute-settlement.ts` alongside its
converse. Neither produced a violation.

*Why it is listed:* "milestone 2 was never released" does not mean the money is
still there, and "milestone 3 was paid" does not imply 1 and 2 were. Anyone
integrating against milestones needs both facts.

### RR-3 — Donated surplus is stranded

Anyone can transfer tokens into an agreement's vault address. Payout paths move
`remaining()`, which is derived from `amount` and `settled_total`, so a
donation is never paid out and never returned.

*Why it is not HIGH:* the surplus was never the protocol's, no party's escrowed
funds are affected, and the alternative is worse — sweeping the vault at
settlement would let one lamport of donation, timed between two instructions,
change what a settlement pays. This is recorded as a deliberate trade in
[security-model.md](../security-model.md) and predates this sprint.

*What would close it:* an explicit recovery instruction, which has to be
designed rather than added, because it is a second way for money to leave a
vault.

### RR-4 — Escrow has no binding to Commerce

`ppv_escrow` does not reference `ppv_commerce` anywhere. It carries its own
parties and its own `terms_hash`, and its only cross-program dependency is the
proof CPI into `ppv_core`.

The `PPV-X1`, `PPV-X2` and `PPV-X3` invariants — agreement binding, party
binding, terms binding — therefore describe a relationship that does not exist
in this implementation, and are marked NOT APPLICABLE rather than passing.

*Why it is not a vulnerability:* "Escrow cannot be tricked into moving assets
for a different logical agreement" holds trivially, because escrow has no
concept of an upstream agreement to confuse. A client that wants an escrow to
correspond to a Commerce agreement does that by putting the same `terms_hash`
in both, which is checkable off chain and enforced by neither program.

*Why it matters:* it is a design gap, not a bug, and it should be a deliberate
decision rather than something discovered during a deployment sprint. If
on-chain binding is wanted, it is a protocol change with its own review.

### RR-5 — True concurrency is not simulated

Adversarial orderings are tested by executing both serialisations. Two
transactions landing in the same slot are not simulated.

*Why it is not HIGH:* Solana serialises writes to the same account, and every
value-moving instruction here takes the agreement account as writable. Two
racing payouts cannot both execute against the same pre-state.

*What would close it:* nothing available in a local-validator harness; this is
a property of the runtime rather than of the program.

### RR-6 — Reconstruction is not proven for every lifecycle family

`escrow.ts` reconstructs agreement and proof history from chain data.
Milestone, refund, dispute and bounty histories are emitted as events and
decoded by the SDK, but no test rebuilds a complete projection from them and
compares it to chain state.

*Why it is not HIGH:* this is an observability claim, not a custody one. A
reconstruction gap cannot move money; it can mislead whoever reads the index.

### RR-7 — The Squads threshold is declared, not read from chain

Verification proves the upgrade authority is the recorded vault address and is
off-curve (so it is a PDA rather than a wallet). It does not read the Squads
multisig account to confirm the threshold is 2, or who the members are. The
threshold and member list come from the deployment environment and are checked
against policy — at least 2, enough distinct members, no duplicates, and the
vault is not its own member, the last two added this sprint.

*Why it is not HIGH for Escrow specifically:* Escrow is not deployed and has no
upgrade authority yet. This is inherited from the Core and Commerce releases
and applies to them today.

*What would close it:* deriving and decoding the Squads multisig account.
Attempted in Sprint 1 against two candidate program ids without a match; not
guessed at since.

### RR-8 — The property suite is not mutation-qualified — **CLOSED**

*Closed in Sprint 3.1.* `scripts/mutation-qualify-property.sh` breaks one
defence at a time and requires **the randomized property suite** to fail. The
run is pinned to `tests/invariants/**/*.invariant.ts`, so a deterministic test
cannot be what noticed; a mutation that does not compile is reported as a broken
mutation rather than a detection; a validator that never started is not a
result; and the clean suite must be green again afterwards.

| Mutation | Class | Detected | Seed | First violation |
| --- | --- | --- | --- | --- |
| an already-settled tranche may be released again | milestone lifecycle finality (PPV-M3) | yes | 20260912 | PPV-MODEL |
| a tranche may be paid to any account of the right mint | destination binding (PPV-M4 / PPV-P4) | yes | 20260912 | PPV-MODEL |
| a tranche pays out everything the vault still owes | custody conservation (PPV-P1 / PPV-M2) | yes | 20260912 | PPV-MODEL |
| a bounty sponsor may replace the winner after naming one | bounty lifecycle finality (PPV-B1) | yes | 20260912 | PPV-MODEL |

Each records its minimized counterexample, so the evidence is a sequence rather
than an exit code.

**Two of the four survived the first run**, and the cause was the generator
rather than the assertions — the same three defects RR-1 records. Both were
then caught through the *second* tranche, which is what confirms the weight fix
was the enabler. The budget was also measured rather than guessed: at 90
sequences the generator produced a single wrong-destination window in the whole
run, so the harness runs 300.

No mutation was made easier and no assertion was weakened to close this.

*What remains:* four mutations across four classes is a sample, not a proof of
detection power in general. The classes chosen are the ones a custody defect
would fall into, and the host-model qualification covers seven more; neither is
a substitute for an independent review (RR-13).

## LOW

### RR-9 — `AgreementType::Invoice`, `Contract` and `ProofOnly` are unimplemented

`initialize_agreement` refuses them, so they cannot be created. They exist in
the enum to keep the wire format stable.

*Consequence:* none today. Listed so that adding one is understood to be a
lifecycle addition needing its own model rows, not a config change.

### RR-10 — Dispute resolution is concession-only

A dispute ends only when one party surrenders its claim. If neither concedes,
the agreement stays `Disputed` and the money stays in the vault indefinitely.
There is no arbiter, deliberately, because the protocol has not decided who may
be one.

*Consequence:* funds can be locked by mutual stubbornness. No party can take
them, and either can end it unilaterally in the other's favour at any time.

## DEFERRED

### RR-11 — A dedicated custody multisig does not exist

The custody gate requires Escrow's upgrade authority to be held by a multisig
**separate** from the non-custodial programs, so compromising one cannot reach
the other. There is one Squads 2-of-3 vault today
(`B6tcsTrMCKTZV5vi3rRCnA3FMPeeWACSHuuTSz5XQgnX`), holding Core and Commerce.

*Unchanged in severity, now closeable.* Sprint 4 added
`scripts/verify-custody-governance.mjs`, which proves a proposed custody
multisig satisfies policy **before** it is given authority over anything, using
only public facts — no key material, so anyone can run it, before the ceremony
and after. It refuses a threshold of one, duplicate members, a vault on the
ed25519 curve, a vault or multisig among its own members, and the non-custodial
vault reused as the custody vault.

It also refuses **shared signers** by default. Two multisigs at different
addresses held by the same people fall to one compromise of those people, so
"separate" is a claim about people as well as addresses. The override exists and
has to be taken deliberately.

*Closure condition:* a multisig exists on devnet, the verifier prints
`PPV_CUSTODY_GOVERNANCE_VALID` against it, and `ESCROW_CUSTODY_GOVERNANCE` in
`scripts/lib/identity.mjs` records it. Step 2 of
[the release runbook](../ppv-escrow-release-runbook.md).

*Why it is still open:* creating it requires funded wallets held by the people
who will hold the threshold. That is a decision about who governs custody, not
a task an agent can perform.

### RR-12 — No permanent Escrow identity exists

`ppv_escrow` carries a build-only placeholder
(`7BECot7zFqH2oCxTu9uLmmwvzQSBtxWro47jMa2MqUdR`), present only in
`[programs.localnet]`. All identity sources agree on this, and
`scripts/lib/identity.mjs` names escrow unreleased explicitly rather than
omitting it.

This is the safest state an unreleased identity can be in: no keypair exists, so
none can leak and no address can be occupied by accident.

*Unchanged in severity, now closeable.* `ESCROW_PERMANENT_ID` and
`ESCROW_CUSTODY_GOVERNANCE` are `null` in the identity table, and
`scripts/test/escrow-identity.test.mjs` enforces **both** states: while the id is
`null`, escrow must be unreleased everywhere and the placeholder must not appear
in any release record or deploy path; once it is set, `declare_id!`,
`Anchor.toml` (both sections), the permanent-identity table and the governance
record must all agree. A half-entered freeze cannot be committed — setting the
constant alone fails, changing `declare_id!` alone fails, and setting the
constant to the placeholder fails.

*Closure condition:* step 1 and step 3 of
[the release runbook](../ppv-escrow-release-runbook.md).

*Why it is still open:* generating the keypair produces permanent key material
whose only legitimate home is the `PPV_ESCROW_PROGRAM_KEYPAIR` repository
secret. An agent that generated it would have nowhere to put it — printing or
committing it is forbidden, and this session cannot write repository secrets —
so generating it would mean creating a key that must immediately be destroyed or
leaked. Not generating it is strictly safer.

### RR-13 — No independent security review

The custody gate requires an independent Solana security review of the custody
path, with all critical and high findings remediated and re-reviewed. This
sprint is a self-review. It found and fixed two custody defects, which is
evidence that the surface rewards attention, not a substitute for someone else
attacking it.
