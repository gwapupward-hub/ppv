import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The aggregator is the part of the invariant gate that decides whether the
 * budget was spent. The release tier runs one seed per validator precisely
 * because a single validator could not survive the whole run, and the failure
 * that forced that change was two seeds attempting zero operations while the
 * gate still reported a number. So the case that matters most here is a seed
 * that produced nothing at all.
 */

const SCRIPT = fileURLToPath(new URL("../sum-invariant-coverage.mjs", import.meta.url));

/** A seed that did ordinary work: enough of every state to satisfy the floors. */
function coverage(attempted) {
  return {
    attempted,
    succeeded: Math.floor(attempted / 4),
    refused: attempted - Math.floor(attempted / 4),
    refusedNonCanonical: 5,
    fundings: 5,
    completions: 4,
    settlements: 3,
    cancellations: 2,
    refunds: 3,
    disputes: 4,
    resolutions: 2,
    postTerminalAttempts: 6,
    sequences: 100,
    escrowSequences: 40,
    milestoneSequences: 30,
    bountySequences: 30,
    milestoneActions: 120,
    milestonesScheduled: 20,
    milestoneReleases: 8,
    milestoneDuplicateReleaseAttempts: 5,
    milestoneForeignAccountAttempts: 9,
    milestonePostTerminalAttempts: 4,
    bountyActions: 90,
    winnerSelections: 12,
    winnerReplacementAttempts: 7,
    bountyPayouts: 6,
    bountyUnassignedPayoutAttempts: 11,
  };
}

let dir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "ppv-coverage-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(seed, body) {
  writeFileSync(join(dir, `${seed}.json`), JSON.stringify(body));
}

function run(...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

describe("sum-invariant-coverage", () => {
  test("sums every seed and passes when the run clears the floor", () => {
    write(1, coverage(3000));
    write(2, coverage(3000));
    write(3, coverage(3000));
    const result = run(dir, "8000", "1", "2", "3");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /run total: 9000 operations attempted/);
    assert.match(result.stdout, /budget met: 9000 >= 8000/);
  });

  test("fails when the summed operations fall below the floor", () => {
    const result = run(dir, "12000", "1", "2", "3");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /expected at least 12000 attempted operations, ran 9000/);
  });

  test("fails when a seed wrote no coverage at all", () => {
    // The Sprint 2 failure exactly: seeds that never ran. Summing what is
    // present would report 9000 and call an incomplete run green.
    const result = run(dir, "8000", "1", "2", "3", "4", "5");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no coverage was written for seed\(s\) 4, 5/);
  });

  test("fails when the run never reached a state the invariants are about", () => {
    const unreached = { ...coverage(9000), settlements: 0 };
    writeFileSync(join(dir, "9.json"), JSON.stringify(unreached));
    const result = run(dir, "8000", "9");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no settlement ever succeeded/);
  });

  test("fails when a whole lifecycle family was never exercised", () => {
    // A generator that stopped producing disputes would still clear every
    // floor that existed before disputes were modelled, so each family needs
    // its own.
    const noDisputes = { ...coverage(9000), disputes: 0 };
    writeFileSync(join(dir, "10.json"), JSON.stringify(noDisputes));
    const result = run(dir, "8000", "10");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no dispute was ever opened/);
  });

  test("fails when a lifecycle exists in the generator but was never reached", () => {
    // RR-1's failure mode exactly: the action kinds are present, nothing ever
    // selected them, and every older floor still passes.
    const neverReleased = { ...coverage(9000), milestoneReleases: 0 };
    writeFileSync(join(dir, "11.json"), JSON.stringify(neverReleased));
    const result = run(dir, "8000", "11");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no milestone was ever released/);

    const noBounties = { ...coverage(9000), bountySequences: 0 };
    writeFileSync(join(dir, "12.json"), JSON.stringify(noBounties));
    const second = run(dir, "8000", "12");
    assert.equal(second.status, 1);
    assert.match(second.stderr, /no bounty was ever generated/);
  });

  test("refuses a non-positive floor rather than passing everything", () => {
    const result = run(dir, "0", "1");
    assert.equal(result.status, 2);
    assert.match(result.stderr, /min-operations must be a positive integer/);
  });
});
