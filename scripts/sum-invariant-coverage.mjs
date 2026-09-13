#!/usr/bin/env node
/**
 * Sums the coverage of one invariant-gate run and asserts the tier's floor.
 *
 * The property suite runs one seed per validator, so the tier's budget is spent
 * across several processes and no single one can assert it. This does, over
 * every seed the gate was asked to run — and it fails if a seed produced no
 * coverage file at all, because a seed that vanished is exactly the failure a
 * summed total would otherwise hide.
 *
 *   node scripts/sum-invariant-coverage.mjs <dir> <min-operations> <seed...>
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const [dir, minimum, ...seeds] = process.argv.slice(2);

if (!dir || !minimum || seeds.length === 0) {
  process.stderr.write(
    "usage: sum-invariant-coverage.mjs <coverage-dir> <min-operations> <seed...>\n",
  );
  process.exit(2);
}

const minOperations = Number(minimum);
if (!Number.isInteger(minOperations) || minOperations <= 0) {
  process.stderr.write(`min-operations must be a positive integer, got ${minimum}\n`);
  process.exit(2);
}

/** Counters that sum across executions. Everything else is per-execution. */
const COUNTERS = [
  "attempted",
  "succeeded",
  "refused",
  "refusedNonCanonical",
  "fundings",
  "completions",
  "settlements",
  "cancellations",
  "postTerminalAttempts",
  "sequences",
];

const total = Object.fromEntries(COUNTERS.map((name) => [name, 0]));
const missing = [];

process.stdout.write("Invariant coverage\n");

for (const seed of seeds) {
  let entry;
  try {
    entry = JSON.parse(readFileSync(join(dir, `${seed}.json`), "utf8"));
  } catch {
    missing.push(seed);
    process.stdout.write(`  seed ${seed}: NO COVERAGE WRITTEN\n`);
    continue;
  }
  for (const name of COUNTERS) total[name] += Number(entry[name] ?? 0);
  process.stdout.write(
    `  seed ${seed}: ${entry.attempted} attempted ` +
      `(${entry.succeeded} accepted, ${entry.refused} refused)\n`,
  );
}

process.stdout.write(`  run total: ${total.attempted} operations attempted\n`);
process.stdout.write(`  ${JSON.stringify(total)}\n`);

const failures = [];
if (missing.length > 0) {
  failures.push(`no coverage was written for seed(s) ${missing.join(", ")}`);
}
if (total.attempted < minOperations) {
  failures.push(`expected at least ${minOperations} attempted operations, ran ${total.attempted}`);
}
// The same reach floors the suite asserts per execution, restated over the sum.
// A gate can only claim an invariant about a state the run actually reached.
for (const [name, message] of [
  ["fundings", "no funding ever succeeded"],
  ["completions", "no completion ever succeeded"],
  ["settlements", "no settlement ever succeeded — PPV-P3 and PPV-P4 were never exercised"],
  ["cancellations", "no cancellation ever succeeded — PPV-P2 was only half exercised"],
  [
    "postTerminalAttempts",
    "nothing was attempted against a terminal agreement — PPV-P2 was never exercised",
  ],
  [
    "refusedNonCanonical",
    "no wrong-relationship account was ever refused — PPV-P9 was never exercised",
  ],
]) {
  if (total[name] === 0) failures.push(message);
}

if (failures.length > 0) {
  process.stderr.write("\nThe invariant gate did not spend the budget it claims:\n");
  for (const failure of failures) process.stderr.write(`  ${failure}\n`);
  process.exit(1);
}

process.stdout.write(`  budget met: ${total.attempted} >= ${minOperations}\n`);
