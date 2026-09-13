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
| `AgreementType::Escrow` only | milestone contracts, bounties, invoices, proof-only agreements |
| `fund`, `mark_completed`, `settle`, `cancel` | `open_dispute`, `resolve_dispute`, `refund`, proofs and proof decisions, milestone instructions, `select_counterparty` |
| buyer, seller, attacker | arbiters, sponsors, third-party cranks |
| classic SPL Token | Token-2022 and its extensions |
| single-payment settlement | partial payouts, `settled_total` accounting across tranches, fee math |
| one program | Marketplace / `ppv_core` / `ppv_commerce` CPI composition |
| the live schema | migrations (no migration instruction exists yet) |

Nothing in this document claims coverage of a row in the right-hand column.

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

About 10% of generated actions are accepted and about 36% present a correctly
formed account in the wrong relationship — the balance the generator weights
exist to hold: deep enough to reach `Settled` inside the budget, adversarial
enough that most of the run is an attack.

## Coverage floors

A property suite whose generator quietly stops producing settlements still
prints a green line. This one does not: after the run it asserts that it
actually reached the states its invariants are about — at least one successful
funding, completion, settlement and cancellation, at least one action attempted
against a terminal agreement, and at least one wrong-relationship account
refused. It also prints the whole coverage record, so a drift is visible in the
log before it becomes a hole in the gate.

## Seeds, replay, and shrinking

Every execution is seeded and every failure is reproducible. A failure reports:

* the random seed,
* fast-check's shrink path,
* the minimized action sequence,
* the index of the action where divergence first occurred,
* the expected model state,
* the observed chain state,
* the relevant balances (both snapshots, plus the conservation arithmetic),
* the violated invariant ID,
* and a copy-pasteable replay command.

```text
  violated invariant : PPV-P10
  seed               : 20260912
  replay             : PPV_INVARIANT_SEED=20260912 npm run test:invariants:seed
  divergence index   : 1 of 2
  action sequence    :
       [0] fund(buyer) [canonical]
    >> [1] settle(seller) [canonical]
```

Shrinking is enabled (`endOnFailure: false`). Every arbitrary lists its
canonical option first, because fast-check shrinks toward the first entry — so a
minimized counterexample is the *most honest* sequence that still breaks the
property, not an arbitrary pile of substituted accounts. A seven-action sequence
such as

```text
fund, complete, settle, cancel, fund, settle, settle
```

reduces toward the two actions that actually matter.

To replay one exact counterexample rather than a whole seed:

```bash
PPV_INVARIANT_SEED=<seed> PPV_INVARIANT_PATH=<path> npm run test:invariants:seed
```

Random failures that cannot be reproduced are not accepted as findings.

## Regressions

Every real bug the harness finds becomes a permanent deterministic test under
`tests/invariants/regression/`, or joins the existing deterministic suite when
that is the more natural home. Regressions are seedless, written out action by
action, and run in the F1 suite on every pull request — a counterexample that
lives only in a seed disappears the first time a generator is re-weighted.

Replays go through the same `runner.ts` as the property gate, so all ten
invariants are asserted after every action of a regression, not just the one
that originally broke.

## Mutation evidence

A harness that passes against correct code has proved nothing. This one was
qualified by deliberately breaking the program and confirming the suite finds
it.

**Mutation.** In `programs/ppv_escrow/src/state/agreement.rs`,
`require_settleable` was changed to accept `Funded` as well as `Completed` —
removing the completion requirement from normal settlement:

```rust
-        require!(
-            self.state == AgreementState::Completed,
-            EscrowError::BadState
-        );
+        require!(
+            matches!(
+                self.state,
+                AgreementState::Completed | AgreementState::Funded
+            ),
+            EscrowError::BadState
+        );
```

**Result.** `PPV_INVARIANT_SEED=20260912 PPV_INVARIANT_SEQUENCES=40 npm run
test:invariants:seed` found it on the third generated sequence and shrank it in
three steps:

```text
PPV protocol invariant violated.
  seed            : 20260912
  shrink path     : 2:4:4:8
  replay          : PPV_INVARIANT_SEED=20260912 PPV_INVARIANT_PATH=2:4:4:8 npm run test:invariants:seed
  runs executed   : 3
  shrinks applied : 3
  minimized to    : 3 action(s)
    [0] fund(buyer) [canonical]
    [1] settle(seller) [canonical]
    [2] complete(seller) [canonical]

  violated invariant : PPV-MODEL
  detail             : the chain accepted an action the model says is illegal
  divergence index   : 1 of 3
  prediction         : FAIL — settlement requires state completed, model is funded
  chain outcome      : SUCCEEDED
  expected model     : state funded,  vaultBalance 1000000, sellerBalance 17000000
  observed chain     : state settled, vault 0,              seller 18000000
```

| | |
| --- | --- |
| Seed | `20260912` |
| Shrink path | `2:4:4:8` |
| Minimized sequence | `fund(buyer)`, `settle(seller)`, `complete(seller)` |
| Divergence index | 1 |
| Invariant violated | `PPV-MODEL`, the prediction/chain disagreement that guards `PPV-P10` |

The `Funded -> Settled` edge is not in `LEGAL_EDGES`, so `PPV-P10` would have
caught the same mutation on its own; `PPV-MODEL` simply fires first, at the
moment the chain accepts an action the model refused. The run also failed its
coverage floor — with settlement reachable from `Funded`, most sequences ended
before ever cancelling anything — which is the second, independent signal that
something about the state machine had changed.

The mutation was reverted before anything was committed, and the clean tree was
proved with `git diff --exit-code` and
`./scripts/verify-devnet-readiness.sh --repo-only`.

## Current limitations

* **One agreement type.** Ordinary `Escrow` only.
* **Four instructions.** Everything in the "not covered" table above is
  untested by this harness, and the deterministic suite remains its only cover.
* **One concurrency model.** Actions are executed and confirmed one at a time.
  Transaction ordering and same-slot races are not explored here; that is
  Lesson 13 territory.
* **No compute or rent adversary.** Compute-budget exhaustion, account-size
  griefing and rent manipulation are not modelled.
* **No Token-2022.** Transfer hooks, transfer fees and confidential transfers
  would each break assumptions this model makes about balance deltas, which is
  exactly why they need their own phase rather than a flag here.
* **Balances only for the escrowed mint.** Lamport accounting is out of scope;
  the stranded-donation limitation in `docs/security-model.md` is unchanged.

## Expansion plan

Each phase lands only once the phase before it is green, and each arrives with
its own generators, model rules and invariant rows — an invariant listed before
its generator exists documents a check nothing performs.

| Phase | Adds |
| --- | --- |
| B | `open_dispute`, `resolve_dispute`, `refund`, terminal `Refunded`, concession semantics |
| C | proofs, proof-decision finality, the settlement/evidence relationship |
| D | the milestone child state machine, partial payouts, `settled_total <= amount`, remaining-balance invariants |
| E | bounty one-time counterparty selection (and the `PPV-P6` exception it requires) |
| F | cross-program PPV Core / Escrow / Commerce relationships |
| G | migrations, if and when migration instructions exist |
| H | adversarial transaction engineering (Lesson 13) |

## Release gate

The release tier is a named gate, `SECURITY_INVARIANTS_GREEN`, in the devnet
release progression. See `docs/devnet-release-readiness.md`. Passing it proves
the escrow state machine survived randomized attack at the stated budget. It
authorizes nothing on its own, and it does not move the custody gate in
`docs/deployment-gates.md`: `ppv_escrow` still ships no further than a local
validator.
