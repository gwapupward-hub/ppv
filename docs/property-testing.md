# Property Testing and Protocol Invariants

The deterministic suites answer "does the escrow kernel do the right thing on
the paths we thought of". This one answers a different question: *what happens
when nobody is thinking*. It plays randomized valid and invalid instruction
sequences at the escrow state machine and checks every protocol invariant after
every attempted action — the ones that succeed and, especially, the ones that do
not.

It extends the existing gates rather than replacing them. The deterministic Rust
state-machine tests, the adversarial suite in `tests/escrow.ts`, F1
(`npm run test:f1`) and the devnet release verification all stand unchanged; the
invariant gate runs on the same local-validator architecture, after them.

## Architecture

```text
tests/invariants/
  model.ts                    independent reference model of an ordinary escrow
  actions.ts                  the vocabulary of generated operations
  generators.ts               sequence and account-relationship generation
  snapshots.ts                the one canonical chain-observation function
  assertions.ts               PPV-P1 … PPV-P10, asserted after every action
  execute.ts                  generated action -> Anchor transaction
  fixture.ts                  wallets, mints, token accounts, unrelated agreement
  runner.ts                   the core execution loop
  protocol.invariant.ts       the property gate itself (budgets, seeds, coverage)
  regression/                 deterministic, seedless replays of real findings
```

Four properties of this layout are load-bearing.

**The model is independent.** `model.ts` imports no state-transition helper from
`programs/ppv_escrow` and is not transcribed from one. It is written from
`docs/invariants.md` and `docs/state-machines.md`. Two copies of the same
mistake agree with each other; a model derived from the specification does not.

**The chain is observed, never inferred.** `snapshotProtocolState` reads the
agreement account, both vaults, and every token balance back from the validator
in a single `getMultipleAccountsInfo` at one commitment. Nothing is taken from
the transaction helper that just executed — a helper that reports what it
*meant* to do is exactly the witness a custody bug would fool.

**Invalid actions are the point.** Roughly a third of generated actions present
a correctly formed account in the wrong relationship, and most generated actions
fail. A refused attack is not wasted coverage: it is a `PPV-P8` atomicity case,
and every one of them is checked.

**The loop asserts between every pair of actions.** Thousands of operations are
never run with only the final state inspected; the first corrupting action has
to be identifiable, and the failure report names its index.

### The execution loop

```text
snapshot BEFORE
  -> reference model predicts success or failure
  -> execute the Anchor transaction
  -> record actual success or failure
snapshot AFTER
  -> compare predicted result with actual result
  -> compare the expected model with the chain
  -> assert every applicable invariant
  -> continue the sequence
```

A prediction/chain disagreement is an immediate property failure, reported as
`PPV-MODEL`.

## Scope

Deliberately narrow, and stated so it cannot be overclaimed.

| Covered now | Not covered |
| --- | --- |
| `AgreementType::Escrow`, `MilestoneContract` and `Bounty` | `Invoice`, `Contract`, `ProofOnly` — refused at initialization, so unreachable |
| `fund`, `mark_completed`, `settle`, `cancel`, `refund`, `open_dispute`, `resolve_dispute`, `select_counterparty`, `create_milestone`, `submit_milestone`, `approve_milestone`, `reject_milestone`, `settle_milestone` | **`submit_proof`, `approve_proof`, `reject_proof`, and settlement citing an approved proof** |
| buyer, seller, attacker, outsider, and wrong-mint variants of buyer and seller | arbiters, third-party cranks |
| classic SPL Token | **Token-2022 and its extensions** |
| single-payment settlement, partial payouts, and `settled_total` accounting across tranches | fee math (no fee path exists) |
| one program | **`ppv_core` CPI composition**, `ppv_commerce`, Marketplace |
| the live schema | migrations (no migration instruction exists yet) |

Nothing in this document claims coverage of a row in the right-hand column.

The left-hand column is generated from `ActionKind` in
`tests/invariants/actions.ts` and `AgreementFlavour`'s three members; the
`scripts/test/coverage-docs.test.mjs` guard fails if this table and those
declarations disagree, in either direction. Understating coverage is a defect
here too: it sends a reviewer to attack a path that is already modelled and
away from one that is not.

**The proof lifecycle is the gap that matters.** It is not untested — the
deterministic suite asserts `CannotDecideOwnProof`, `ProofAlreadyDecided`,
`ProofNotApproved`, `ProofAgreementMismatch` and `CoreProofMismatch` against a
real validator, and the RR-6 live run carries two escrow `Proof` PDAs, two
`ppv_core` records and a proof-backed settlement. What it lacks is the
randomized tier and the mutation tier that every other custody path now has.
See `docs/security/rr13/06-test-and-evidence-map.md`.

## The invariants

Ten properties, asserted after **every** attempted action of **every** generated
sequence. `docs/invariants.md` carries the full mapping of each one to its model
rule, its chain observation, its generator coverage, and its deterministic
counterpart.

| ID | Property |
| --- | --- |
| PPV-P1 | Custody conservation across the controlled token population, measured from a baseline taken once setup minting is complete. |
| PPV-P2 | Terminal finality — after `Settled` or `Cancelled`, no later action causes a lifecycle transition and no observable changes. |
| PPV-P3 | Single settlement — `settlementCount <= 1`, and the seller is never paid the escrow amount twice. |
| PPV-P4 | Canonical settlement destination — a successful settlement may increase only a token account owned by the canonical seller. |
| PPV-P5 | Canonical custody authority — assets never leave through a substituted vault or authority. |
| PPV-P6 | Party immutability — for an ordinary escrow, `creator` and `counterparty` never change. |
| PPV-P7 | Mint immutability — `agreement.mint` never changes. |
| PPV-P8 | Failed-action atomicity — a refused action leaves every relevant observable byte-identical. |
| PPV-P9 | Account relationship integrity — correctly formed accounts in the wrong relationship are refused, and an unrelated agreement is never reachable. |
| PPV-P10 | State-machine legality — the only successful edges are `Open → Funded`, `Open → Cancelled`, `Funded → Completed`, `Completed → Settled`. |

`PPV-P6` is written for an ordinary escrow on purpose and must **not** be
applied unchanged to `Bounty`, whose counterparty is intentionally assignable
exactly once (Invariant 12j).

### Receipts

There is no on-chain "receipt PDA uniqueness" test here, because PPV has no
on-chain receipt account. Receipts are projections reconstructed from committed
events (`docs/receipts.md`, Invariants 15–17). The protocol fact underneath them
is what this harness carries instead:

> one agreement admits at most one canonical settlement transition, and no
> history can represent two.

`PPV-P3` and `PPV-P10` together are that property. Receipt and indexer coverage
belongs in PPV's actual replay architecture — `sdk/src/escrow/receipts.ts` and
`scripts/replay-agreement.mts` — and will be added there rather than by
inventing an account the program does not have.

## Budgets and tiers

```bash
npm run test:invariants:pr        # the CI gate
npm run test:invariants:release   # the release gate
PPV_INVARIANT_SEED=20260912 npm run test:invariants:seed   # replay
```

| Tier | Sequences per seed | Actions per sequence | Seeds | Floor asserted |
| --- | --- | --- | --- | --- |
| `pr` | 100 | up to 20 | 3 fixed | 2,000 attempted operations |
| `release` | 200 | up to 32 | 5 fixed | 12,000 attempted operations |
| `seed` | 100 | up to 20 | one, from `PPV_INVARIANT_SEED` | 1 |

Sequence length is *generated*, not fixed, because a counterexample has to be
able to shrink toward the shortest sequence that still violates the property.
A generated sequence therefore averages about half its maximum. The budget is
consequently stated and enforced as **total attempted operations**: the gate
counts what it actually ran and fails if it did not clear the floor. The PR tier
runs three seeds so that the 2,000-operation minimum is cleared with margin
rather than by luck.

### One validator per seed

The gate runs each seed against its own `solana-test-validator`, resetting the
ledger between seeds, and sums the per-seed coverage afterwards
(`scripts/sum-invariant-coverage.mjs`) to assert the tier's floor.

This is not a budget concession — same seeds, same sequence count, same sequence
length, same floor. It exists because a single validator instance does not
survive the release budget everywhere the gate runs. On a GitHub-hosted runner,
one instance took roughly 7,500 transactions over about ten minutes and then
stayed up, kept answering RPC, and rejected every subsequent transaction with
`Blockhash not found` — so the two seeds that had not yet started attempted zero
operations. The PR budget finishes below that ceiling, which is why the release
tier was the first to find it. The warm-machine numbers below were measured
before the split and are unchanged by it.

Because the budget is now spent across several processes, no single one can
assert it, and the summing step is therefore part of the gate rather than a
report: it fails if the total falls below the floor, if a state the invariants
are about was never reached, **or if any seed produced no coverage file at all**.
That last case is the one that matters — a seed that never ran is exactly what a
sum over the files that happen to exist would otherwise hide.

Every knob is overridable:

```bash
PPV_INVARIANT_SEQUENCES=250 PPV_INVARIANT_ACTIONS=40 \
PPV_INVARIANT_SEEDS=1,2,3 npm run test:invariants:release
```

The gate is not a six-hour test. Measured on a warm local validator, at roughly
100 ms per attempted operation including both snapshots:

| Tier | Sequences run | Operations attempted | Wall clock (transactions only) |
| --- | --- | --- | --- |
| `pr` | 300 | 2,744 | ~4.6 min |
| `release` | 1,000 | 15,337 | ~18 min |

Both sit on top of the `anchor build` the gate shares with F1.

The coverage those budgets actually bought, from the release run recorded in
this document:

```json
{"attempted":15337,"succeeded":1580,"refused":13757,"refusedNonCanonical":5541,
 "fundings":566,"completions":463,"settlements":302,"cancellations":249,
 "postTerminalAttempts":6180,"sequences":1000}
```

### What a coverage floor does not tell you

When disputes and refunds joined the model, the first release run produced:

```json
{"fundings":456,"completions":204,"settlements":151,"cancellations":239,
 "refunds":8,"disputes":260,"resolutions":100}
```

Every floor passed. Eight successful refunds out of 15,337 operations is still
close to no evidence about `PPV-D3` and `PPV-D4`.

The cause was in the generator rather than in the program: `destination` was
weighted ten-to-one toward the seller's account, which is the canonical
destination for a settlement and the *wrong* one for a refund. A refund
therefore succeeded only on the roughly one draw in fourteen that picked the
buyer. The fix is `destinationArbitrary(kind)` — the favoured destination is
chosen per instruction, the deviations are unchanged, and the wrong-destination
attack on a refund is still generated.

The lesson generalises past this one weight. A floor of "greater than zero"
catches a family that vanished; it does not catch one that is present and
barely exercised. When a family's success count is an order of magnitude below
its siblings', the generator is the first place to look.

### And what a floor of "greater than zero" cannot catch at all

When milestones and bounties joined the model, the first release run failed a
floor outright: tranches scheduled, none released. Reaching a release needs six
ordered actions — schedule, schedule, fund, submit, approve, release — each with
the right actor and canonical accounts, and at the weights in use each step
landed with probability 0.04 to 0.12 per slot. The expected sequence length to
reach one release was about 47 actions against a budget of 32: reachable in
principle, unreachable in practice.

Three generator defects were behind it, and each is a shape worth recognising:

* **A deviation weight applied to something that is not a deviation.**
  `weighted("first", "second", "foreign")` gave the agreement's *own* second
  tranche the same one-in-twelve share as an account belonging to a different
  contract. Only `foreign` is a deviation.
* **A fixed order where the program has none.** Tranches were always released
  smallest-last, so the state where a repeat release fits inside the remaining
  balance never arose — and a missing single-release guard stayed masked by the
  custody cap.
* **`fc.nat` is biased toward small values.** Prefix lengths drawn with it
  concentrated on "barely started", so the deep states the prefix exists to
  reach were under-sampled by the run meant to reach them.

The structural answer is a generated *prefix* of each flavour's canonical
lifecycle, followed by a randomized attack on whatever state it reached. The
prefix length is generated and shrinks toward zero, so a counterexample still
minimizes to the shortest setup that breaks the property, and a zero-length
prefix is the pure random walk the suite always did.

Nothing in the prefix is assumed to succeed: every prefix action goes through
the same model prediction and the same assertions as a random one. The prefix
decides what is attempted, never what is true. A separate assertion keeps it
honest — acceptance must stay under 40% of attempted actions, or the setup has
taken over and the attack has been diluted into a happy-path walk.

### Reachability is now a millisecond question

`tests/invariants/reachability.test.ts` walks sampled scenarios through the
model alone and asserts that every lifecycle the coverage floors demand is
actually reached, with margin. It proves nothing about the program — it assumes
the chain agrees with the model, which is the one thing it cannot check — but it
answers the question that used to cost forty minutes of CI, and every generator
defect above was found with it rather than by waiting.

The release-tier coverage after all of it, 5 seeds × 200 sequences:

```json
{"attempted":17607,"succeeded":3532,"refused":14075,"refusedNonCanonical":4856,
 "escrowSequences":362,"milestoneSequences":315,"bountySequences":323,
 "milestoneActions":4998,"milestonesScheduled":576,"milestoneReleases":169,
 "milestoneDuplicateReleaseAttempts":348,"milestoneForeignAccountAttempts":362,
 "milestonePostTerminalAttempts":1185,"bountyActions":5577,
 "winnerSelections":306,"winnerReplacementAttempts":1081,"bountyPayouts":93,
 "bountyUnassignedPayoutAttempts":144,"postTerminalAttempts":6028}
```

## Does the suite detect defects, or only pass correct code?

Two harnesses, because an answer about one layer says nothing about the other.
`scripts/mutation-qualify.sh` breaks seven defences and requires the *host*
suite to fail. `scripts/mutation-qualify-property.sh` breaks four and requires
*this* suite to fail, pinned to `tests/invariants/**/*.invariant.ts` so no
deterministic test can be what noticed.

Two of the four survived their first run, for the generator reasons above rather
than for anything in the assertions. The budget was then measured rather than
guessed — at 90 sequences the generator produced a single wrong-destination
window in the entire run — and the harness now runs 300. Both are recorded in
[security/ppv-escrow-attack-matrix.md](security/ppv-escrow-attack-matrix.md).
