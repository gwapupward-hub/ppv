import * as anchor from "@coral-xyz/anchor";

import type { GeneratedAction } from "../actions";
import { buildFixture, type Fixture } from "../fixture";
import { emptyCoverage, InvariantRunner } from "../runner";

/**
 * Deterministic replay: settlement is gated on `Completed`, and a settled
 * agreement settles exactly once.
 *
 * Origin — this is the minimized counterexample the property harness produces
 * against the mutation used to qualify it (the `Completed` requirement removed
 * from `require_settleable`). Against the unmutated program both sequences must
 * refuse the settlement and leave every observable untouched.
 *
 *   mutation      : `require_settleable` accepts `Funded` as well as `Completed`
 *   seed          : 20260912
 *   shrink path   : 2:4:4:8
 *   violated      : PPV-MODEL — the chain accepted an action the model refused;
 *                   `funded -> settled` is not in PPV-P10's legal edge table
 *   minimized to  : fund(buyer), settle(seller), complete(seller)
 *   divergence at : index 1
 *
 * The replay runs through the same engine as the property gate, so all ten
 * invariants are asserted after both actions rather than only the one that
 * originally broke. Seedless and fixed on purpose: a counterexample that lives
 * only in a seed disappears the moment a generator is re-weighted.
 */

const CANONICAL = {
  agreement: "canonical",
  mint: "canonical",
  vault: "canonical",
  vaultAuthority: "canonical",
  source: "buyer",
  destination: "seller",
  milestone: "first",
} as const;

/**
 * The minimized counterexample itself. Funded, then settled: the settlement
 * must be refused, and the completion that follows it must then still be legal
 * — which is the part that proves the refusal left the agreement exactly where
 * it was rather than merely failing loudly.
 */
const SETTLE_BEFORE_COMPLETION: GeneratedAction[] = [
  { kind: "fund", actor: "buyer", accounts: { ...CANONICAL } },
  { kind: "settle", actor: "seller", accounts: { ...CANONICAL } },
  { kind: "complete", actor: "seller", accounts: { ...CANONICAL } },
  // And a second refusal on the same grounds, from the other party.
  { kind: "settle", actor: "attacker", accounts: { ...CANONICAL } },
];

/** The honest lifecycle, then three attempts to settle it again. */
const SETTLE_TWICE: GeneratedAction[] = [
  { kind: "fund", actor: "buyer", accounts: { ...CANONICAL } },
  { kind: "complete", actor: "seller", accounts: { ...CANONICAL } },
  { kind: "settle", actor: "seller", accounts: { ...CANONICAL } },
  { kind: "settle", actor: "seller", accounts: { ...CANONICAL } },
  { kind: "settle", actor: "buyer", accounts: { ...CANONICAL } },
  { kind: "cancel", actor: "buyer", accounts: { ...CANONICAL } },
];

describe("invariant regressions: settlement state gate", function () {
  this.timeout(10 * 60 * 1000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const escrow = anchor.workspace.PpvEscrow as any;

  let runner: InvariantRunner;
  let fixture: Fixture;

  before(async () => {
    fixture = await buildFixture(provider, escrow, 4);
    // A private id range, so a regression replay can never collide with an
    // agreement the property gate created in the same validator session.
    runner = new InvariantRunner(fixture, 900_000n);
  });

  it("refuses settlement before completion and leaves custody untouched", async () => {
    await runner.runSequence(0, { flavour: "escrow", actions: SETTLE_BEFORE_COMPLETION }, emptyCoverage());
  });

  it("settles exactly once and refuses everything afterwards", async () => {
    await runner.runSequence(0, { flavour: "escrow", actions: SETTLE_TWICE }, emptyCoverage());
  });
});
