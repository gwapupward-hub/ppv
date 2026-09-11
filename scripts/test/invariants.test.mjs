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

test("CI runs the PR invariant gate after the deterministic gate", () => {
  assert.match(CI, /npm run test:invariants:pr/, "CI must run the PR invariant tier");
  const anchorJob = CI.slice(CI.indexOf("\n  anchor:"));
  const f1 = anchorJob.indexOf("npm run test:f1");
  const invariants = anchorJob.indexOf("npm run test:invariants:pr");
  assert.ok(f1 >= 0 && invariants >= 0, "both gates must run in the validator job");
  assert.ok(
    f1 < invariants,
    "the invariant gate runs after deterministic correctness is established",
  );
});
