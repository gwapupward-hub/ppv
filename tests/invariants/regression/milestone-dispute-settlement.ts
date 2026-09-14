import * as anchor from "@coral-xyz/anchor";

import type { GeneratedAction } from "../actions";
import { buildFixture, type Fixture } from "../fixture";
import { emptyCoverage, InvariantRunner } from "../runner";

/**
 * Deterministic replay: a milestone contract settled by concession pays the
 * whole remaining balance and leaves every tranche unreleased.
 *
 * Origin — the first release run of the milestone model produced this, and
 * what it found was a wrong invariant rather than a wrong program:
 *
 *   seed              : 20260912
 *   violated          : PPV-M5, as originally stated — "a settled milestone
 *                       contract released 0 of 2 tranches"
 *   divergence index  : 4 of 6
 *   minimized to      : createMilestone, createMilestone, fund, dispute,
 *                       resolve, submitMilestone
 *
 * The model and the chain agreed on every observable: settled, settledTotal
 * equal to the amount, vault empty, the seller credited once, conservation
 * exact. The assertion was the thing that was wrong. `resolve_dispute` pays
 * `remaining()` and terminates the agreement whatever the tranche bookkeeping
 * says — the mirror image of a refund on a milestone contract, which returns
 * the tranches nobody earned — and it is safe for the same reason:
 * `require_milestone_active` demands `Funded`, so a terminal agreement can
 * never release another tranche.
 *
 * That is worth pinning rather than merely fixing, because it is a genuine
 * surprise for anyone reading tranche state: a contract can be `Settled` with
 * every milestone still `Pending`, and "milestone 2 was never released" does
 * not mean the money is still there.
 *
 * Seedless and fixed on purpose: a counterexample that lives only in a seed
 * disappears the moment a generator is re-weighted.
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
 * The counterexample itself, plus what must follow it: once the concession has
 * settled the contract, no tranche may move, in any state, from either party.
 */
const CONCEDED_MILESTONE_CONTRACT: GeneratedAction[] = [
  { kind: "createMilestone", actor: "buyer", accounts: { ...CANONICAL }, amount: "planned" },
  {
    kind: "createMilestone",
    actor: "buyer",
    accounts: { ...CANONICAL, milestone: "second" },
    amount: "planned",
  },
  { kind: "fund", actor: "buyer", accounts: { ...CANONICAL } },
  { kind: "dispute", actor: "buyer", accounts: { ...CANONICAL } },
  // The buyer concedes: the whole remaining balance goes to the seller and the
  // agreement terminates with both tranches still pending.
  { kind: "resolve", actor: "buyer", accounts: { ...CANONICAL } },
  // Everything after this must be refused, and must move nothing.
  { kind: "submitMilestone", actor: "seller", accounts: { ...CANONICAL } },
  { kind: "approveMilestone", actor: "buyer", accounts: { ...CANONICAL } },
  { kind: "settleMilestone", actor: "seller", accounts: { ...CANONICAL } },
  {
    kind: "settleMilestone",
    actor: "buyer",
    accounts: { ...CANONICAL, milestone: "second" },
  },
  { kind: "refund", actor: "seller", accounts: { ...CANONICAL, destination: "buyer" } },
] as GeneratedAction[];

/**
 * The other direction of PPV-M5, which *is* an invariant: releasing every
 * tranche must finish the agreement rather than leaving it funded.
 */
const TRANCHES_TO_COMPLETION: GeneratedAction[] = [
  { kind: "createMilestone", actor: "buyer", accounts: { ...CANONICAL }, amount: "planned" },
  {
    kind: "createMilestone",
    actor: "buyer",
    accounts: { ...CANONICAL, milestone: "second" },
    amount: "planned",
  },
  { kind: "fund", actor: "buyer", accounts: { ...CANONICAL } },
  { kind: "submitMilestone", actor: "seller", accounts: { ...CANONICAL } },
  { kind: "approveMilestone", actor: "buyer", accounts: { ...CANONICAL } },
  { kind: "settleMilestone", actor: "seller", accounts: { ...CANONICAL } },
  // Releasing the same tranche again must be refused (PPV-M3).
  { kind: "settleMilestone", actor: "seller", accounts: { ...CANONICAL } },
  {
    kind: "submitMilestone",
    actor: "seller",
    accounts: { ...CANONICAL, milestone: "second" },
  },
  {
    kind: "approveMilestone",
    actor: "buyer",
    accounts: { ...CANONICAL, milestone: "second" },
  },
  {
    kind: "settleMilestone",
    actor: "seller",
    accounts: { ...CANONICAL, milestone: "second" },
  },
  // The last release finishes the agreement; nothing may follow it.
  { kind: "settleMilestone", actor: "buyer", accounts: { ...CANONICAL } },
  { kind: "refund", actor: "seller", accounts: { ...CANONICAL, destination: "buyer" } },
] as GeneratedAction[];

describe("invariant regressions: milestone terminal compatibility", function () {
  this.timeout(10 * 60 * 1000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const escrow = anchor.workspace.PpvEscrow as any;

  let runner: InvariantRunner;
  let fixture: Fixture;

  before(async () => {
    fixture = await buildFixture(provider, escrow, 6);
    // A private id range, so a regression replay can never collide with an
    // agreement the property gate created in the same validator session.
    runner = new InvariantRunner(fixture, 920_000n);
  });

  it("settles a milestone contract by concession, leaving no tranche releasable", async () => {
    await runner.runSequence(
      0,
      { flavour: "milestone", actions: CONCEDED_MILESTONE_CONTRACT },
      emptyCoverage(),
    );
  });

  it("finishes the agreement on the last tranche, and refuses a second release", async () => {
    await runner.runSequence(
      0,
      { flavour: "milestone", actions: TRANCHES_TO_COMPLETION },
      emptyCoverage(),
    );
  });
});
