#!/usr/bin/env node
/**
 * Telling a broken validator apart from a broken protocol.
 *
 * The randomized property suite attacks real custody against a real local
 * validator, so a run can fail for two completely different reasons:
 *
 *   * an invariant assertion fired — a custody finding, the thing the suite
 *     exists to produce;
 *   * the validator stopped being able to serve transactions — a finding about
 *     the machine, and about nothing else.
 *
 * Until now the two were indistinguishable at the top: `protocol.invariant.ts`
 * headed every failure "PPV protocol invariant violated", so a
 * `SendTransactionError: Blockhash not found` with an empty log array — a
 * transaction that never reached the program — was reported as a custody
 * violation. `scripts/mutation-qualify-property.sh` then saw only "the suite
 * failed" and had nothing to reason with.
 *
 * This module is the one place that decides. It is deliberately not clever:
 * every rule fails closed, and "retry" is returned only when the evidence
 * positively says infrastructure and says nothing else.
 *
 *   node scripts/lib/property-failure.mjs <logfile>
 *
 * prints `<kind>:<reason>` and exits 0. The shell reads that and nothing else.
 */

import { readFileSync } from "node:fs";

/**
 * Printed by the property suite when a failure did not come from an invariant
 * assertion. Duplicated as a literal in `tests/invariants/protocol.invariant.ts`
 * — the two are asserted equal in `scripts/test/property-failure.test.mjs`, so
 * they cannot drift apart silently.
 */
export const NON_INVARIANT_MARKER = "PPV PROPERTY SUITE FAILED WITHOUT AN INVARIANT VIOLATION.";

/** The header the suite prints when an invariant assertion really did fire. */
export const INVARIANT_MARKER = "PPV protocol invariant violated.";

/**
 * Failures of the validator rather than of the program.
 *
 * Each one names a state in which the node could not accept or simulate a
 * transaction at all. None of them can be produced by escrow logic: a program
 * that misbehaves returns a program error, and a program error is not on this
 * list and never will be.
 *
 * Kept tight on purpose. A pattern added here is a pattern that can buy a
 * retry, so anything ambiguous belongs in `unknown`, which retries nothing.
 */
export const INFRASTRUCTURE_PATTERNS = Object.freeze([
  // The blockhash the client attached expired, or the node had not yet seen
  // it, before the transaction was simulated. The transaction did not run.
  { pattern: /Blockhash not found/i, reason: "blockhash-not-found" },
  { pattern: /BlockhashNotFound/, reason: "blockhash-not-found" },
  { pattern: /failed to get recent blockhash/i, reason: "blockhash-unavailable" },
  // The validator was not listening: it died, was still starting, or the
  // harness tore it down underneath the suite.
  { pattern: /ECONNREFUSED/, reason: "validator-unreachable" },
  { pattern: /connect ECONNREFUSED 127\.0\.0\.1:8899/, reason: "validator-unreachable" },
  { pattern: /socket hang up/i, reason: "validator-unreachable" },
  { pattern: /fetch failed/i, reason: "validator-unreachable" },
  // The node answered, but not with a result.
  { pattern: /503 Service Unavailable/i, reason: "validator-unavailable" },
  { pattern: /Node is behind by \d+ slots/i, reason: "validator-behind" },
]);

/**
 * Evidence that the failure came from the program, not the plumbing.
 *
 * Present for two reasons. It keeps an Anchor or program error from ever being
 * classified as infrastructure — and, because classification fails closed, a
 * log carrying both a program error and an infrastructure symptom is treated
 * as a program failure and gets no retry.
 */
export const PROGRAM_ERROR_PATTERNS = Object.freeze([
  /AnchorError/,
  /custom program error/i,
  /Error Code: \w+\. Error Number: \d+/,
  /Program \w+ failed/,
  /InvariantViolation/,
]);

export const KINDS = Object.freeze({
  INVARIANT: "invariant",
  PROGRAM: "program",
  INFRASTRUCTURE: "infrastructure",
  UNKNOWN: "unknown",
});

/**
 * What a failed property-suite log says went wrong.
 *
 * Order is the safety property, not a style choice:
 *
 *   1. An invariant violation is an invariant violation, whatever else the log
 *      also contains. Nothing downgrades it.
 *   2. A program error is a program error for the same reason.
 *   3. Only then may a positively matched infrastructure symptom count.
 *   4. Anything else is unknown, and unknown is never retried.
 */
export function classifyPropertyLog(log) {
  const text = String(log ?? "");

  if (text.includes(INVARIANT_MARKER)) {
    return { kind: KINDS.INVARIANT, reason: "invariant-assertion", retryable: false };
  }
  for (const pattern of PROGRAM_ERROR_PATTERNS) {
    if (pattern.test(text)) {
      return { kind: KINDS.PROGRAM, reason: "program-error", retryable: false };
    }
  }
  // An infrastructure symptom only counts when the suite itself said the
  // failure was not an invariant one. Without that marker the log is some
  // other shape entirely, and guessing is how a real finding gets retried away.
  if (text.includes(NON_INVARIANT_MARKER)) {
    for (const { pattern, reason } of INFRASTRUCTURE_PATTERNS) {
      if (pattern.test(text)) {
        return { kind: KINDS.INFRASTRUCTURE, reason, retryable: true };
      }
    }
  }
  return { kind: KINDS.UNKNOWN, reason: "unclassified", retryable: false };
}

/** The same question asked of a file. */
export function classifyPropertyLogFile(path) {
  return classifyPropertyLog(readFileSync(path, "utf8"));
}

if (process.argv[1] && process.argv[1].endsWith("property-failure.mjs")) {
  const path = process.argv[2];
  if (!path) {
    process.stderr.write("usage: property-failure.mjs <logfile>\n");
    process.exit(2);
  }
  let verdict;
  try {
    verdict = classifyPropertyLogFile(path);
  } catch (error) {
    // An unreadable log is not evidence of anything, least of all of a machine
    // that deserves another go.
    process.stdout.write(`${KINDS.UNKNOWN}:unreadable-log\n`);
    process.exit(0);
  }
  process.stdout.write(`${verdict.kind}:${verdict.reason}\n`);
}
