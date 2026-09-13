# PPV Escrow residual-risk register

**Readiness verdict: PPV ESCROW DEVNET DEPLOYMENT READINESS: NO-GO.** The
blocking entries are **RR-1** (milestones and bounties are not modelled under
randomized adversarial execution) and **RR-8** (the randomized layer is not
mutation-qualified). See
[ppv-escrow-readiness-verdict.md](ppv-escrow-readiness-verdict.md) for the full
verdict and its statements of record.

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

### RR-1 — Milestones and bounties are not randomly attacked — **BLOCKS GO**

The model-based property suite attacks `fund`, `mark_completed`, `settle`,
`cancel`, `refund`, `open_dispute` and `resolve_dispute` — the ordinary-escrow
custody surface, including everything this sprint added. `create_milestone`,
`submit_milestone`, `approve_milestone`, `reject_milestone`,
`settle_milestone`, `select_counterparty`, `submit_proof`, `approve_proof` and
`reject_proof` are covered by 31 deterministic local-validator tests and by the
exhaustive host model, and by no randomized adversarial sequence.

*Why it is not HIGH:* the milestone and bounty payout paths do not have their
own custody code. Every one of them releases money through `pay_out_of_vault`,
the same function the randomized suite attacks, under the same PDA signing and
the same exact-amount assertion. What is unattacked is the *lifecycle around*
those payouts, and the host model walks that exhaustively at the authorization
and state layer.

*What would close it:* milestone and bounty action kinds in
`tests/invariants/`, with a model that tracks per-milestone state.

### RR-2 — Milestone release order is unconstrained by design

A buyer can approve and release tranche 2 before tranche 1. Each tranche has
its own submission and its own approval, and nothing sequences them.

*Why it is not a defect:* no invariant is broken — `PPV-M1` and `PPV-M2` bound
the totals, `PPV-M3` bounds each tranche to one release, and every release
needs the buyer's approval. A schedule where later work is approved first is a
schedule the buyer chose.

*Why it is listed:* it is a reasonable thing to assume is enforced, and it is
not. Anyone integrating against milestones needs to know that "milestone 3 was
paid" does not imply 1 and 2 were.

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

### RR-8 — The property suite is not mutation-qualified — **BLOCKS GO**

`scripts/mutation-qualify.sh` breaks seven defences and requires the host
suite to fail. It does not run the local-validator property suite, because each
mutation would cost a full build and a multi-minute validator run.

*Consequence:* the randomized custody assertions — conservation, exact-amount
transfers, account substitution — are not proven to detect an injected defect
the way the state-machine assertions are.

*What would close it:* a scheduled job that runs two or three custody mutations
against the PR-tier property budget.

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

### RR-11 — A second, independent upgrade multisig does not exist

The custody gate requires Escrow's upgrade authority to be held by a multisig
**separate** from the non-custodial programs, so compromising one cannot reach
the other. There is one Squads 2-of-3 vault today
(`B6tcsTrMCKTZV5vi3rRCnA3FMPeeWACSHuuTSz5XQgnX`), holding Core and Commerce.

This is a prerequisite for deployment with real lead time — new keys, new
holders, new threshold policy — and it is not something a code sprint can
produce.

### RR-12 — No permanent Escrow identity exists

`ppv_escrow` carries a build-only placeholder
(`7BECot7zFqH2oCxTu9uLmmwvzQSBtxWro47jMa2MqUdR`), present only in
`[programs.localnet]`. All identity sources agree on this, and
`scripts/lib/identity.mjs` names escrow unreleased explicitly rather than
omitting it.

This is the safest state an unreleased identity can be in: no keypair exists,
so none can leak and no address can be occupied by accident. Generating one is
a deliberate ceremony belonging to the deployment sprint.

### RR-13 — No independent security review

The custody gate requires an independent Solana security review of the custody
path, with all critical and high findings remediated and re-reviewed. This
sprint is a self-review. It found and fixed two custody defects, which is
evidence that the surface rewards attention, not a substitute for someone else
attacking it.
