import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { REPO } from "./helpers.mjs";

/**
 * The security-invariant gate substitutes program ids in a working checkout,
 * exactly as the F1 harness does, so it carries exactly the same obligations:
 * restore every identity file on every exit path, and prove the restoration
 * rather than assume it. These tests pin that, plus the budget the gate claims
 * to spend — a gate whose PR tier quietly dropped to three sequences would
 * still print a green line.
 */

const GATE = readFileSync(join(REPO, "scripts", "verify-invariants.sh"), "utf8");
const PACKAGE = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const CI = readFileSync(join(REPO, ".github", "workflows", "ci.yml"), "utf8");
const MOCHARC = readFileSync(join(REPO, ".mocharc.cjs"), "utf8");

function programsWithIdentities() {
  return readdirSync(join(REPO, "programs"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => {
      try {
        return readFileSync(
          join(REPO, "programs", entry.name, "src", "lib.rs"),
          "utf8",
        ).includes("declare_id!(");
      } catch {
        return false;
      }
    })
    .map((entry) => entry.name);
}

test("every program's identity file is restored by the invariant gate", () => {
  for (const program of programsWithIdentities()) {
    assert.match(
      GATE,
      new RegExp(`programs/${program}/src/lib\\.rs`),
      `verify-invariants.sh must restore programs/${program}/src/lib.rs`,
    );
  }
  assert.match(GATE, /^\s+Anchor\.toml$/m);
});

test("the invariant gate restores identities on every exit path and proves it", () => {
  assert.match(GATE, /trap cleanup EXIT/, "restoration must not depend on success");
  assert.match(GATE, /verify-devnet-readiness\.sh --repo-only/);
  assert.match(GATE, /did not restore the permanent program identities cleanly/);
  // The original exit status must survive the added assertion.
  assert.match(GATE, /status=\$\?/);
  assert.match(GATE, /exit "\$\{status\}"/);
});

test("the invariant gate pins the same toolchain F1 pins", () => {
  assert.match(GATE, /expected_anchor="anchor-cli 0\.30\.1"/);
  assert.match(GATE, /expected_solana="solana-cli 1\.18\.17"/);
  assert.match(GATE, /RUSTUP_TOOLCHAIN="\$\{PPV_IDL_TOOLCHAIN:-nightly-2024-06-15\}"/);
});

test("the gate runs against a real local validator, never a mock", () => {
  assert.match(GATE, /solana-test-validator --reset/);
  assert.match(GATE, /anchor test --skip-build --skip-local-validator/);
  assert.doesNotMatch(GATE, /--skip-deploy/);
});

test("each seed gets its own validator, and none is reused", () => {
  // The release budget killed a single shared validator part way through: it
  // kept answering RPC and refused every transaction with "Blockhash not
  // found", so two seeds attempted zero operations. Restarting per seed is
  // what makes the budget spendable; nothing about the budget changed.
  assert.match(GATE, /for seed in "\$\{run_seeds\[@\]\}"/);
  assert.match(GATE, /start_validator "\$\{ledger\}"/);
  assert.match(GATE, /stop_validator/);
  assert.match(GATE, /ledger="\$\{workdir\}\/test-ledger-\$\{seed\}"/);
  // A per-seed ledger that is never removed reintroduces the disk growth the
  // restart exists to avoid.
  assert.match(GATE, /rm -rf "\$\{ledger\}"/);
});

test("the run's budget is asserted over every seed, not per process", () => {
  // No single execution can assert a floor it only spends a fifth of.
  assert.match(GATE, /PPV_INVARIANT_COVERAGE_OUT="\$\{coverage_dir\}\/\$\{seed\}\.json"/);
  assert.match(
    GATE,
    /node scripts\/sum-invariant-coverage\.mjs[\s\\]+"\$\{coverage_dir\}" "\$\{PPV_INVARIANT_MIN_OPERATIONS\}" "\$\{run_seeds\[@\]\}"/,
  );
  // The aggregator must run before the green line, or the line means nothing.
  assert.ok(
    GATE.indexOf("sum-invariant-coverage.mjs") < GATE.indexOf("SECURITY_INVARIANTS_GREEN"),
    "the budget is summed after the gate already declared itself green",
  );
});

test("a dead validator is diagnosed rather than reported as a protocol failure", () => {
  assert.match(GATE, /dump_validator_state "\$\{ledger\}"/);
  assert.match(GATE, /validator\.log/);
  // The validator logs at INFO, so a raw tail is banking-stage metrics and
  // none of the failure. What it complained about is the signal.
  assert.match(GATE, /grep -E ' \(WARN\|ERROR\) '/);
  // Free space is reported per seed: a seed that dies early having spent 61 of
  // its usual 3,209 operations did so with 7.6G of 72G left, and nothing in
  // the output said so.
  assert.match(GATE, /report_headroom "seed \$\{seed\}"/);
  assert.match(GATE, /disk headroom before/);
});

test("the property suite emits the coverage the aggregator sums", () => {
  const suite = readFileSync(
    join(REPO, "tests", "invariants", "protocol.invariant.ts"),
    "utf8",
  );
  assert.match(suite, /PPV_INVARIANT_COVERAGE_OUT/);
  // In `after`, so a failing seed still reports what it spent.
  assert.match(suite, /after\(function \(\) \{[\s\S]*?PPV_INVARIANT_COVERAGE_OUT/);
});

test("the destination the generator favours depends on the instruction", () => {
  // A settlement pays the seller and a refund pays the buyer. One canonical
  // destination for every kind makes the correct destination for the other a
  // one-in-fourteen draw: the first release run of the extended suite produced
  // 151 settlements and 8 refunds from the same 15,337 operations. Eight
  // successes clear a coverage floor and prove very little about PPV-D3/D4.
  const generators = readFileSync(
    join(REPO, "tests", "invariants", "generators.ts"),
    "utf8",
  );
  assert.match(generators, /function destinationArbitrary\(kind: ActionKind\)/);
  assert.match(generators, /kind === "refund" \? "buyer" : "seller"/);
  // The account variant must be drawn per kind, or the kind cannot inform it.
  assert.match(generators, /kindArbitrary\(flavour\)\.chain\(\(kind\)/);
  // And the wrong-destination attack must still be generated: the weighting
  // moved, the option set did not.
  assert.match(generators, /\.filter\(\(ref\) => ref !== canonical\)/);
});

test("every agreement type is generated, with its own lifecycle weighted", () => {
  // RR-1: a milestone or bounty action kind that exists and is never selected
  // closes nothing. The weights are per flavour so each lifecycle is walked
  // inside a generated sequence rather than merely being reachable.
  const generators = readFileSync(
    join(REPO, "tests", "invariants", "generators.ts"),
    "utf8",
  );
  assert.match(generators, /KIND_WEIGHTS: Record<AgreementFlavour/);
  for (const flavour of ["escrow", "milestone", "bounty"]) {
    assert.ok(
      new RegExp(`^  ${flavour}: \\{`, "m").test(generators),
      `the generator has no weights for ${flavour}`,
    );
  }
  assert.match(generators, /export function scenarioArbitrary/);
  assert.match(generators, /constantFrom\(\.\.\.AGREEMENT_FLAVOURS\)/);

  // And the suite must refuse a run that did not reach them.
  const suite = readFileSync(
    join(REPO, "tests", "invariants", "protocol.invariant.ts"),
    "utf8",
  );
  for (const floor of [
    "milestonesScheduled",
    "milestoneReleases",
    "milestoneForeignAccountAttempts",
    "winnerSelections",
    "bountyUnassignedPayoutAttempts",
  ]) {
    assert.ok(
      suite.includes(`coverage.${floor} > 0`),
      `the suite has no coverage floor for ${floor}`,
    );
  }
});

test("the randomized property suite is itself mutation-qualified", () => {
  // RR-8. The host-model qualification proves nothing about the layer that
  // attacks real custody against a real validator, and that is the layer a
  // milestone or bounty defect would have to be caught by.
  const script = readFileSync(join(REPO, "scripts", "mutation-qualify-property.sh"), "utf8");

  // Only the property suite may run, or a deterministic test could be what
  // "detected" the mutation.
  assert.match(script, /PPV_ANCHOR_TEST_GLOB="tests\/invariants\/\*\*\/\*\.invariant\.ts"/);

  // The required classes: custody conservation, destination binding, and
  // lifecycle finality for both milestones and bounties.
  for (const mutation of [
    "milestone-double-release",
    "milestone-recipient",
    "milestone-overpay",
    "bounty-winner-replacement",
  ]) {
    assert.ok(script.includes(mutation), `no ${mutation} mutation`);
  }

  // A mutation that does not compile, or a validator that never started, is a
  // broken mutation rather than a detection.
  assert.match(script, /MUTATION DID NOT COMPILE — not a qualification/);
  assert.match(script, /validator did not start; this is not a result/);

  // The suite must be green again afterwards, or "it detected the mutation"
  // could just mean "it fails on everything".
  assert.match(script, /clean rerun \(no mutation\)/);
  assert.match(script, /CLEAN PROPERTY SUITE FAILED after reverting every mutation/);

  // And no mutation may survive into the tree.
  assert.match(script, /SECURITY: a mutation was left in the working tree/);
});

test("CI runs the property mutation qualification as its own job", () => {
  assert.match(CI, /^  property-mutation:$/m);
  assert.match(CI, /\.\/scripts\/mutation-qualify-property\.sh/);
  // The job must prove the tree is clean after it, independently of the
  // script's own trap.
  assert.match(CI, /git diff --exit-code -- programs\//);
});

test("the PR tier spends the adversarial budget the docs claim", () => {
  const tier = GATE.split(/^\s+pr\)$/m)[1]?.split(/;;/)[0] ?? "";
  assert.match(tier, /PPV_INVARIANT_SEQUENCES:=100\b/, "PR tier must run 100 sequences");
  assert.match(tier, /PPV_INVARIANT_ACTIONS:=20\b/, "PR tier must allow 20 actions per sequence");
  assert.match(
    tier,
    /PPV_INVARIANT_MIN_OPERATIONS:=2000\b/,
    "PR tier must assert a floor of 2,000 adversarial operations",
  );
  const seeds = /PPV_INVARIANT_SEEDS:=([0-9,]+)/.exec(tier);
  assert.ok(seeds, "PR tier must pin deterministic CI seeds");
  assert.ok(
    seeds[1].split(",").filter(Boolean).length >= 2,
    "PR tier must pin more than one deterministic seed",
  );
});

test("the release tier is strictly larger than the PR tier", () => {
  const pr = GATE.split(/^\s+pr\)$/m)[1].split(/;;/)[0];
  const release = GATE.split(/^\s+release\)$/m)[1].split(/;;/)[0];
  const number = (block, name) => Number(new RegExp(`${name}:=([0-9]+)`).exec(block)[1]);
  const seedCount = (block) =>
    /PPV_INVARIANT_SEEDS:=([0-9,]+)/.exec(block)[1].split(",").filter(Boolean).length;

  assert.ok(
    number(release, "PPV_INVARIANT_SEQUENCES") > number(pr, "PPV_INVARIANT_SEQUENCES"),
    "the release tier must run more sequences",
  );
  assert.ok(
    number(release, "PPV_INVARIANT_ACTIONS") > number(pr, "PPV_INVARIANT_ACTIONS"),
    "the release tier must run longer sequences",
  );
  assert.ok(seedCount(release) > seedCount(pr), "the release tier must run more seeds");
});

test("the seed tier refuses to run without an explicit seed", () => {
  assert.match(GATE, /PPV_INVARIANT_SEED must be set for the seed tier/);
});

test("every tier is reachable from npm", () => {
  for (const script of ["test:invariants:pr", "test:invariants:release", "test:invariants:seed"]) {
    assert.ok(PACKAGE.scripts[script], `package.json must define ${script}`);
    assert.match(PACKAGE.scripts[script], /verify-invariants\.sh/);
  }
  assert.match(PACKAGE.scripts["test:invariants:pr"], /PPV_INVARIANT_TIER=pr\b/);
  assert.match(PACKAGE.scripts["test:invariants:release"], /PPV_INVARIANT_TIER=release\b/);
  assert.match(PACKAGE.scripts["test:invariants:seed"], /PPV_INVARIANT_TIER=seed\b/);
});

test("fast-check is pinned through the committed lockfile", () => {
  const pinned = PACKAGE.devDependencies["fast-check"];
  assert.ok(pinned, "fast-check must be a declared devDependency");
  assert.match(pinned, /^\d+\.\d+\.\d+$/, "fast-check must be pinned exactly, not floated");

  const lock = JSON.parse(readFileSync(join(REPO, "package-lock.json"), "utf8"));
  const entry = lock.packages["node_modules/fast-check"];
  assert.ok(entry, "fast-check must be present in the committed lockfile");
  assert.equal(entry.version, pinned);
  assert.ok(entry.integrity, "the lockfile entry must carry an integrity hash");
});

test("the deterministic suite runs the invariant regressions and not the property gate", () => {
  // The property gate is budgeted separately. F1 must pick up the deterministic
  // replays under regression/ and must not silently inherit a 2,000-operation
  // property run.
  assert.match(MOCHARC, /tests\/invariants\/regression\/\*\.ts/);
  assert.doesNotMatch(MOCHARC, /protocol\.invariant/);
  assert.match(MOCHARC, /PPV_ANCHOR_TEST_GLOB/);
  assert.match(GATE, /PPV_ANCHOR_TEST_GLOB="tests\/invariants\/\*\*\/\*\.invariant\.ts"/);
});

test("CI runs the invariant gate after the deterministic gate", () => {
  const anchorJob = CI.slice(CI.indexOf("\n  anchor:"));
  const f1 = anchorJob.indexOf("npm run test:f1");
  const invariants = anchorJob.indexOf('npm run "test:invariants:${TIER}"');
  assert.ok(f1 >= 0 && invariants >= 0, "both gates must run in the validator job");
  assert.ok(
    f1 < invariants,
    "the invariant gate runs after deterministic correctness is established",
  );
});

test("the release budget runs where it is needed and the PR budget everywhere else", () => {
  // The release tier is too slow for every pull request, and a gate nobody ever
  // runs is not a gate. It runs on the weekly schedule, on demand, and — the
  // case that matters for a deployment — on the pull request that declares a
  // program a release candidate. Never neither.
  const anchorJob = CI.slice(CI.indexOf("\n  anchor:"));
  assert.match(anchorJob, /inputs\.invariant_tier/);
  assert.match(anchorJob, /github\.event_name == 'schedule' && 'release'/);
  assert.match(anchorJob, /steps\.candidate\.outputs\.release_candidate == 'true' && 'release'/);
  assert.match(anchorJob, /\|\| 'pr' \}\}/, "the budget must always resolve to something");
  assert.match(CI, /schedule:\n\s+- cron:/);
  assert.match(CI, /options: \[pr, release\]/);
  // The job has to be allowed to run for the events that raise the budget.
  assert.match(anchorJob, /github\.event_name == 'schedule'/);
  assert.match(anchorJob, /github\.event_name == 'workflow_dispatch'/);
});

test("a release candidate is detected from the checkout, with nothing that can fail", () => {
  // This gate once downgraded itself silently. It asked git whether the pull
  // request touched deployments/release-candidates/, which on a shallow
  // checkout fails with "no merge base"; the command sat inside an `if`, so the
  // failure answered "no" and the release budget never ran on the change that
  // declared a release.
  //
  // Presence needs no history, no base branch and no network, so there is
  // nothing left to fail. These assertions keep it that way.
  const anchorJob = CI.slice(CI.indexOf("\n  anchor:"));
  const step = anchorJob.slice(
    anchorJob.indexOf("- name: Detect a declared release candidate"),
    anchorJob.indexOf("- name: Security invariants"),
  );
  assert.match(step, /candidates=\(deployments\/release-candidates\/\*\.json\)/);

  // Comments removed first: this step's comment explains the git-based version
  // it replaced, and matching that prose would make the explanation fail the
  // test it explains.
  const commands = step
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  assert.doesNotMatch(commands, /\bgit\b/, "detection must not depend on git history");
  assert.doesNotMatch(commands, /curl|\bfetch\b/, "detection must not depend on the network");
  assert.doesNotMatch(commands, /github\.base_ref/, "detection must not depend on a base branch");
  assert.ok(
    anchorJob.indexOf("- name: Detect a declared release candidate") <
      anchorJob.indexOf("- name: Security invariants"),
    "detection must precede the gate that reads it",
  );
});

test("a declared release candidate exists, so the release budget is what runs", () => {
  // While this holds, every commit is a candidate for the one that gets
  // deployed, and all of them are held to the release budget.
  const declared = readdirSync(join(REPO, "deployments", "release-candidates")).filter((entry) =>
    entry.endsWith(".json"),
  );
  assert.ok(
    declared.length > 0,
    "expected a declared release candidate; delete this expectation when none is queued",
  );
});
