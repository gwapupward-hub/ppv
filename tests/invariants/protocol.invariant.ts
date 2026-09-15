import * as anchor from "@coral-xyz/anchor";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import * as fc from "fast-check";

import type { GeneratedAction } from "./actions";
import { describeAction } from "./actions";
import { InvariantViolation } from "./assertions";
import { buildFixture, type Fixture } from "./fixture";
import { scenarioArbitrary } from "./generators";
import { emptyCoverage, InvariantRunner } from "./runner";

/**
 * PPV Lesson 12 — model-based property testing of the escrow state machine.
 *
 * Scope is ordinary `AgreementType::Escrow` and four instructions: `fund`,
 * `mark_completed`, `settle` and `cancel`, attacked by a buyer, a seller and an
 * outsider. Disputes, refunds, milestones, bounties, proofs, migrations,
 * Marketplace composition, Token-2022 extensions and fee math are **not**
 * covered here and are not claimed to be; docs/property-testing.md carries the
 * phased expansion plan.
 *
 * Budgets and seeds come from the environment so the tier is a property of the
 * gate that invoked the suite, never a number buried in a test file:
 *
 *   PPV_INVARIANT_SEQUENCES        property runs per seed
 *   PPV_INVARIANT_ACTIONS          maximum actions in one generated sequence
 *   PPV_INVARIANT_SEEDS            comma-separated deterministic seeds
 *   PPV_INVARIANT_SEED             one seed, for replaying a counterexample
 *   PPV_INVARIANT_PATH             fast-check shrink path, for exact replay
 *   PPV_INVARIANT_MIN_OPERATIONS   floor this execution must clear
 *   PPV_INVARIANT_COVERAGE_OUT     file to write this execution's coverage to
 *
 * One execution is not necessarily one gate. A local validator degrades under
 * sustained load, so the release tier runs one seed per validator and sums the
 * coverage files afterwards; `scripts/verify-invariants.sh` owns that loop and
 * asserts the tier's full floor across it.
 */

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  assert.ok(
    Number.isInteger(value) && value > 0,
    `${name} must be a positive integer, got ${JSON.stringify(raw)}`,
  );
  return value;
}

function seedsFromEnv(): number[] {
  const single = (process.env.PPV_INVARIANT_SEED ?? "").trim();
  if (single !== "") {
    const value = Number(single);
    assert.ok(Number.isFinite(value), `PPV_INVARIANT_SEED must be numeric, got ${single}`);
    return [value];
  }
  const list = (process.env.PPV_INVARIANT_SEEDS ?? "").trim();
  if (list === "") return [1];
  return list
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const value = Number(entry);
      assert.ok(Number.isFinite(value), `PPV_INVARIANT_SEEDS entry is not numeric: ${entry}`);
      return value;
    });
}

const SEQUENCES = envInt("PPV_INVARIANT_SEQUENCES", 100);
const ACTIONS = envInt("PPV_INVARIANT_ACTIONS", 20);
const SEEDS = seedsFromEnv();
/**
 * Sequence length is generated rather than fixed, because a counterexample has
 * to shrink toward the shortest sequence that still breaks the property. The
 * budget is therefore stated and asserted as total attempted operations, not
 * assumed from the run count.
 */
const MIN_OPERATIONS = envInt("PPV_INVARIANT_MIN_OPERATIONS", 2_000);
const REPLAY_PATH = process.env.PPV_INVARIANT_PATH?.trim() || undefined;

describe("PPV protocol invariants (property-based)", function () {
  // Thousands of on-chain transactions against a local validator is not a unit
  // test. The budget is bounded and printed; the timeout follows from it.
  this.timeout(180 * 60 * 1000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const escrow = anchor.workspace.PpvEscrow as any;

  const coverage = emptyCoverage();
  let fixture: Fixture;
  let runner: InvariantRunner;

  before(async function () {
    this.timeout(10 * 60 * 1000);
    // Shrinking re-executes sequences, so a run can create several times the
    // nominal number of agreements. Size the wallet for that, not for the
    // happy case.
    fixture = await buildFixture(provider, escrow, SEQUENCES * SEEDS.length * 3);
    runner = new InvariantRunner(fixture);
  });

  for (const seed of SEEDS) {
    it(`holds every invariant over ${SEQUENCES} sequences of <=${ACTIONS} actions (seed ${seed})`, async () => {
      const before = coverage.attempted;
      try {
        await fc.assert(
          fc.asyncProperty(scenarioArbitrary(ACTIONS), async (scenario) => {
            await runner.runSequence(seed, scenario, coverage);
          }),
          {
            seed,
            numRuns: SEQUENCES,
            path: REPLAY_PATH,
            // Shrinking is the point: a twenty-action counterexample nobody can
            // read is a bug report nobody acts on.
            endOnFailure: false,
            reporter: (out) => {
              if (!out.failed) return;
              const cause: unknown = (out as { errorInstance?: unknown }).errorInstance;
              const detail =
                cause instanceof InvariantViolation ? cause.message : String(out.error ?? cause);
              const scenario = out.counterexample?.[0] as
                | { flavour: string; actions: GeneratedAction[] }
                | undefined;
              const minimized = scenario?.actions ?? [];
              throw new Error(
                [
                  "",
                  "PPV protocol invariant violated.",
                  `  seed            : ${seed}`,
                  `  shrink path     : ${out.counterexamplePath}`,
                  `  replay          : PPV_INVARIANT_SEED=${seed} PPV_INVARIANT_PATH=${out.counterexamplePath} npm run test:invariants:seed`,
                  `  runs executed   : ${out.numRuns}`,
                  `  shrinks applied : ${out.numShrinks}`,
                  `  agreement type  : ${scenario?.flavour ?? "unknown"}`,
                  `  minimized to    : ${minimized.length} action(s)`,
                  ...minimized.map((action, index) => `    [${index}] ${describeAction(action)}`),
                  detail,
                ].join("\n"),
              );
            },
          },
        );
      } finally {
        // What this seed actually spent, printed whether it passed or failed.
        // A property suite that silently shrinks its own coverage is worse than
        // no property suite.
        console.log(
          `    seed ${seed}: ${coverage.attempted - before} operations attempted ` +
            `(${coverage.succeeded} accepted, ${coverage.refused} refused, run total ${coverage.attempted})`,
        );
      }
    });
  }

  it("spent the adversarial budget it claims and reached every state it covers", () => {
    assert.ok(
      coverage.attempted >= MIN_OPERATIONS,
      `expected at least ${MIN_OPERATIONS} attempted operations, ran ${coverage.attempted}`,
    );
    // Coverage floors, not statistics. Each names a state the invariant set is
    // only meaningful about if the run actually got there. A generator bias
    // that quietly stopped producing settlements fails here rather than
    // reporting a green gate over an unexercised state machine.
    assert.ok(coverage.fundings > 0, "no funding ever succeeded");
    assert.ok(coverage.completions > 0, "no completion ever succeeded");
    assert.ok(
      coverage.settlements > 0,
      "no settlement ever succeeded — PPV-P3 and PPV-P4 were never exercised",
    );
    assert.ok(
      coverage.cancellations > 0,
      "no cancellation ever succeeded — PPV-P2 was only half exercised",
    );
    assert.ok(
      coverage.postTerminalAttempts > 0,
      "nothing was attempted against a terminal agreement — PPV-P2 was never exercised",
    );
    assert.ok(
      coverage.refusedNonCanonical > 0,
      "no wrong-relationship account was ever refused — PPV-P9 was never exercised",
    );
    // The Phase 5 paths get their own floors rather than riding on the totals
    // above: a generator that stopped producing disputes would still clear
    // every floor that existed before they were modelled.
    assert.ok(
      coverage.refunds > 0,
      "no refund ever succeeded — PPV-D3 and PPV-D4 were never exercised",
    );
    assert.ok(
      coverage.disputes > 0,
      "no dispute was ever opened — PPV-D1 and PPV-D2 were never exercised",
    );
    // PPV-D5, floored on the whole concession surface rather than on one
    // total. Seed 20260913 passed every floor that existed before these and
    // still resolved nothing: `resolutions` was the only dispute-outcome
    // number, and a generator that reached `Disputed` only by coincidence
    // could clear it on a lucky seed and miss on an unlucky one. Each of the
    // five below names a distinct way the dispute path can quietly die.
    assert.ok(
      coverage.resolutions > 0,
      "no dispute was ever resolved — PPV-D5 was never exercised",
    );
    assert.ok(
      coverage.resolutionAttempts > 0,
      "no resolution was ever attempted — PPV-D5 was never reached",
    );
    assert.ok(
      coverage.invalidResolutionAttempts > 0,
      "every resolution attempted was legal — the wrong-role, wrong-account and " +
        "wrong-state attacks on a concession were never generated",
    );
    // Both legal edges out of `Disputed`. A run that only ever conceded toward
    // the seller left `Disputed -> Refunded` unexercised, which is what every
    // seed did before the dispute path was generated.
    assert.ok(
      coverage.resolutionsToSeller > 0,
      "no dispute was ever conceded to the seller — the Disputed -> Settled edge was never taken",
    );
    assert.ok(
      coverage.resolutionsToBuyer > 0,
      "no dispute was ever conceded to the buyer — the Disputed -> Refunded edge was never taken",
    );
    assert.ok(
      coverage.postResolutionAttempts > 0,
      "nothing was attempted after a dispute was conceded — the replay surface " +
        "specific to a resolved agreement was never attacked",
    );
    // RR-1's closure condition, stated as a gate rather than as a claim.
    //
    // A milestone or bounty action kind that exists in the generator and is
    // never selected closes nothing: the point of adding them was that those
    // lifecycles be *reached*. Each floor below names a thing the run has to
    // have actually done, and the two release floors ask for more than one
    // occurrence because a single accidental success is not coverage either.
    assert.ok(
      coverage.milestoneSequences > 0 && coverage.bountySequences > 0,
      `not every agreement type was generated (escrow ${coverage.escrowSequences}, ` +
        `milestone ${coverage.milestoneSequences}, bounty ${coverage.bountySequences})`,
    );
    assert.ok(
      coverage.milestonesScheduled > 0,
      "no milestone was ever scheduled — PPV-M1 was never exercised",
    );
    assert.ok(
      coverage.milestoneReleases > 0,
      "no milestone was ever released — PPV-M2, PPV-M3 and PPV-M4 were never exercised",
    );
    assert.ok(
      coverage.milestoneForeignAccountAttempts > 0,
      "no foreign milestone account was ever presented — PPV-M4 was never attacked",
    );
    assert.ok(
      coverage.winnerSelections > 0,
      "no bounty winner was ever named — PPV-B1 was never exercised",
    );
    assert.ok(
      coverage.bountyUnassignedPayoutAttempts > 0,
      "no payout was ever attempted on an unclaimed bounty — PPV-B3 was never attacked",
    );
    console.log(`    coverage: ${JSON.stringify(coverage)}`);
  });

  // Written whatever the outcome, so an aggregate over several executions
  // counts what actually ran rather than what was supposed to. A gate that
  // loses the losing run's numbers cannot report its own budget honestly.
  after(function () {
    const out = process.env.PPV_INVARIANT_COVERAGE_OUT?.trim();
    if (!out) return;
    writeFileSync(
      out,
      JSON.stringify(
        { ...coverage, config: { sequences: SEQUENCES, actions: ACTIONS, seeds: SEEDS } },
        null,
        2,
      ),
    );
  });
});
