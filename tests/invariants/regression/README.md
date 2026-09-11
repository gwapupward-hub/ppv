# Deterministic invariant regressions

Every real bug the property harness finds lands here as a fixed, seedless
replay, or in the existing deterministic suite when that is the more natural
home for it. A counterexample that only exists as a seed is a counterexample
that disappears the first time a generator is re-weighted.

Rules for this directory:

* **No randomness.** The action sequence is written out. These tests run in the
  deterministic F1 suite (`npm run test:f1`), not in the property gate, so they
  execute on every pull request at a fixed cost.
* **One case per finding**, named for the protocol fact it pins, not for the
  seed that happened to produce it.
* **The same engine.** Replays go through `runner.ts`, so every invariant in
  `assertions.ts` is asserted after every action, exactly as in the property
  run. A regression that checked only the one thing that broke would stop
  noticing when the fix broke something else.

Record the origin of each case in its file: seed, the shrink path, and the
invariant that failed.
