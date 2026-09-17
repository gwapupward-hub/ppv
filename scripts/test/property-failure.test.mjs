import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { REPO } from "./helpers.mjs";
import {
  INFRASTRUCTURE_PATTERNS,
  INVARIANT_MARKER,
  KINDS,
  NON_INVARIANT_MARKER,
  PROGRAM_ERROR_PATTERNS,
  classifyPropertyLog,
} from "../lib/property-failure.mjs";

/**
 * Which property-suite failures may buy a retry, and which may never.
 *
 * The mutation gate runs the randomized suite against a real local validator
 * for the better part of an hour. Two failures look identical from the outside
 * — an invariant assertion firing, and the validator ceasing to serve — and
 * until now they were reported identically too: every failure was headed "PPV
 * protocol invariant violated", including a `SendTransactionError: Blockhash
 * not found` whose empty log array proves the transaction never reached the
 * program.
 *
 * Retrying the first would be unforgivable: it is the finding the suite exists
 * to produce. Not retrying the second throws away a completed forty-minute
 * qualification because a machine hiccuped. So the distinction has to be exact,
 * and it has to fail closed — which is what these tests are about.
 *
 * None of this needs a validator. That is deliberate: a guard against a flake
 * must not itself be flaky.
 */

const CLASSIFIER = join(REPO, "scripts", "lib", "property-failure.mjs");
const SCRIPT = readFileSync(join(REPO, "scripts", "mutation-qualify-property.sh"), "utf8");
const INVARIANT_TEST = readFileSync(
  join(REPO, "tests", "invariants", "protocol.invariant.ts"),
  "utf8",
);

/** A log the way the suite writes one when no invariant assertion fired. */
const nonInvariant = (body) =>
  [
    "",
    NON_INVARIANT_MARKER,
    "  No invariant assertion fired. This is not, on its own, a custody",
    "  seed            : 20260912",
    "  runs executed   : 101",
    body,
  ].join("\n");

/** A log the way the suite writes one when an invariant really did fire. */
const invariantFailure = (body = "PPV-P1 custody conservation violated") =>
  ["", INVARIANT_MARKER, "  seed            : 20260912", body].join("\n");

/* ------------------------------------------- the markers cannot drift apart */

test("the markers the suite prints are the markers the classifier reads", () => {
  // They are literals in two languages; the only thing keeping them equal is
  // this assertion.
  assert.ok(
    INVARIANT_TEST.includes(`"${NON_INVARIANT_MARKER}"`),
    "protocol.invariant.ts no longer prints the non-invariant marker the classifier looks for",
  );
  assert.ok(
    INVARIANT_TEST.includes(`"${INVARIANT_MARKER}"`),
    "protocol.invariant.ts no longer prints the invariant marker",
  );
  assert.notEqual(NON_INVARIANT_MARKER, INVARIANT_MARKER);
});

test("the suite reports a non-invariant failure under a different header", () => {
  // The specific regression: one header for both kinds of failure.
  assert.match(
    INVARIANT_TEST,
    /if \(!violation\) \{/,
    "the reporter no longer branches on whether an InvariantViolation was thrown",
  );
  assert.match(INVARIANT_TEST, /const violation = cause instanceof InvariantViolation/);
});

/* ------------------------------------------------ infrastructure: one retry */

test("Blockhash not found is classified as infrastructure and is retryable", () => {
  const verdict = classifyPropertyLog(
    nonInvariant(
      [
        "Error: Simulation failed. ",
        "Message: Transaction simulation failed: Blockhash not found. ",
        "Logs: ",
        "[]. ",
      ].join("\n"),
    ),
  );
  assert.equal(verdict.kind, KINDS.INFRASTRUCTURE);
  assert.equal(verdict.reason, "blockhash-not-found");
  assert.equal(verdict.retryable, true);
});

test("every declared infrastructure pattern classifies as retryable", () => {
  assert.ok(INFRASTRUCTURE_PATTERNS.length >= 5);
  for (const { pattern, reason } of INFRASTRUCTURE_PATTERNS) {
    // A sample the pattern actually matches, built from the pattern's own
    // source so the test cannot drift from the rule it checks.
    const sample = pattern.source
      .replace(/\\d\+/g, "7")
      .replace(/\\\./g, ".")
      .replace(/[\\^$]/g, "");
    const verdict = classifyPropertyLog(nonInvariant(sample));
    assert.equal(verdict.kind, KINDS.INFRASTRUCTURE, `${pattern} did not classify as infra`);
    assert.equal(verdict.reason, reason);
    assert.equal(verdict.retryable, true);
  }
});

/* --------------------------------------------- invariant failures: no retry */

test("an invariant violation is never retryable", () => {
  const verdict = classifyPropertyLog(invariantFailure());
  assert.equal(verdict.kind, KINDS.INVARIANT);
  assert.equal(verdict.retryable, false);
});

test("an invariant violation stays un-retryable even alongside a blockhash error", () => {
  // Fails closed. A validator that also misbehaved does not launder a custody
  // finding into a retry — this is the assertion that matters most here.
  const verdict = classifyPropertyLog(
    [
      invariantFailure("PPV-P3 no double settlement violated"),
      "Message: Transaction simulation failed: Blockhash not found.",
      NON_INVARIANT_MARKER,
    ].join("\n"),
  );
  assert.equal(verdict.kind, KINDS.INVARIANT);
  assert.equal(verdict.retryable, false);
});

/* ----------------------------------------------- program errors: no retry */

test("an Anchor or program error is never retryable", () => {
  for (const sample of [
    "AnchorError occurred. Error Code: CustodyMismatch. Error Number: 6012",
    "Transaction failed: custom program error: 0x1774",
    "Program 7U1bCHQcr8Jg6J8G69JGaAWCRtsrZB1RYx4zo1sNEVF4 failed: instruction error",
  ]) {
    const verdict = classifyPropertyLog(nonInvariant(sample));
    assert.equal(verdict.kind, KINDS.PROGRAM, `${sample} was not classified as a program error`);
    assert.equal(verdict.retryable, false);
  }
  assert.ok(PROGRAM_ERROR_PATTERNS.length >= 4);
});

test("a program error alongside a blockhash symptom is still a program error", () => {
  const verdict = classifyPropertyLog(
    nonInvariant("AnchorError: ...\nMessage: Transaction simulation failed: Blockhash not found."),
  );
  assert.equal(verdict.kind, KINDS.PROGRAM);
  assert.equal(verdict.retryable, false);
});

/* ------------------------------------------------------- unknown: no retry */

test("an unrecognised failure is not retryable", () => {
  for (const sample of ["", "1) some mocha test failed", nonInvariant("out of memory")]) {
    const verdict = classifyPropertyLog(sample);
    assert.equal(verdict.retryable, false, `${JSON.stringify(sample)} was treated as retryable`);
  }
});

test("a blockhash error without the suite's own marker is not retryable", () => {
  // The marker is the suite saying "no invariant fired". Without it the log is
  // some other shape, and guessing is how a real finding gets retried away.
  const verdict = classifyPropertyLog("Message: Transaction simulation failed: Blockhash not found.");
  assert.equal(verdict.kind, KINDS.UNKNOWN);
  assert.equal(verdict.retryable, false);
});

/* ------------------------------------------------------------- the CLI path */

function classifyFile(contents) {
  const dir = mkdtempSync(join(tmpdir(), "ppv-property-failure-"));
  const path = join(dir, "run.log");
  writeFileSync(path, contents);
  return execFileSync(process.execPath, [CLASSIFIER, path], { encoding: "utf8" }).trim();
}

test("the CLI prints kind:reason, which is what the shell branches on", () => {
  assert.equal(
    classifyFile(nonInvariant("Message: Transaction simulation failed: Blockhash not found.")),
    "infrastructure:blockhash-not-found",
  );
  assert.equal(classifyFile(invariantFailure()), "invariant:invariant-assertion");
  assert.equal(classifyFile(nonInvariant("AnchorError")), "program:program-error");
});

test("an unreadable log classifies as unknown rather than as a free retry", () => {
  const out = execFileSync(process.execPath, [CLASSIFIER, "/nonexistent/run.log"], {
    encoding: "utf8",
  }).trim();
  assert.equal(out, "unknown:unreadable-log");
});

/* ------------------------------------- the script honours all of the above */

test("the script retries only on the infrastructure classification", () => {
  assert.match(SCRIPT, /verdict="\$\(node scripts\/lib\/property-failure\.mjs/);
  assert.match(SCRIPT, /if \[\[ "\$\{kind\}" != "infrastructure" \]\]; then/);
  // The non-infrastructure branch exits; it does not fall through to a retry.
  const guard = SCRIPT.slice(SCRIPT.indexOf('if [[ "${kind}" != "infrastructure" ]]'));
  assert.match(guard.slice(0, 400), /exit 1/);
});

test("the retry is bounded at one and tears the validator down first", () => {
  assert.equal(
    (SCRIPT.match(/clean_attempt "/g) ?? []).length,
    2,
    "there must be exactly one first attempt and one retry",
  );
  assert.match(SCRIPT, /run-clean-retry\.log/);
  assert.match(SCRIPT, /stop_validator \|\| true\n\s*rm -rf "\$\{workdir\}\/ledger"/);
  // A failed retry is terminal, whatever it is classified as.
  assert.match(SCRIPT, /one retry is the limit/);
});

test("a second infrastructure failure is still a hard failure", () => {
  const retry = SCRIPT.slice(SCRIPT.indexOf('if ! clean_attempt "${workdir}/run-clean-retry.log"'));
  const block = retry.slice(0, 600);
  assert.match(block, /exit 1/);
  assert.ok(
    !/clean_attempt/.test(block.slice(block.indexOf("exit 1"))),
    "nothing may run another attempt after the retry fails",
  );
});

test("mutations must all be detected before the clean rerun can run at all", () => {
  // Otherwise a retried clean run could stand in for a mutation the suite
  // missed, which would invert the whole point of the gate.
  const undetectedGate = SCRIPT.indexOf("PROPERTY MUTATION QUALIFICATION FAILED — undetected");
  const cleanRerun = SCRIPT.indexOf('echo "  clean rerun (no mutation)"');
  assert.ok(undetectedGate > -1 && cleanRerun > -1);
  assert.ok(
    undetectedGate < cleanRerun,
    "the undetected-mutation gate must come before the clean rerun",
  );
  const gate = SCRIPT.slice(undetectedGate, cleanRerun);
  assert.match(gate, /exit 1/, "an undetected mutation must exit before the clean rerun");
});

test("the retry cannot turn an assertion failure green, by construction", () => {
  // The end-to-end statement of the safety property: for every log shape that
  // represents a real finding, the classifier the script consults says no.
  for (const log of [
    invariantFailure("PPV-P1 custody conservation violated"),
    invariantFailure("PPV-P4 destination binding violated"),
    nonInvariant("AnchorError: Error Code: DestinationNotOwnedBySeller. Error Number: 6010"),
    nonInvariant("custom program error: 0x1770"),
  ]) {
    assert.equal(classifyPropertyLog(log).retryable, false);
    assert.notEqual(classifyFile(log).split(":")[0], "infrastructure");
  }
});
