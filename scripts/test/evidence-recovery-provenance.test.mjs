import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { PERMANENT_PROGRAM_IDS } from "../lib/identity.mjs";
import { REPO } from "./helpers.mjs";

/**
 * Two ways a recovered release record can lie, and the tests that stop them.
 *
 * The first is the one that caused this whole recovery: an evidence recorder
 * with its own private identity table that knows Core and Commerce and not
 * Escrow. It passed every deployment gate and failed at the last step, after
 * the irreversible part, and the deployment could not be repeated to produce
 * the evidence it never wrote.
 *
 * The second is subtler and only exists *because* of the recovery. Evidence
 * reconstructed later is produced by a different commit than the one that built
 * the deployed program — and the recovery commit is the one checked out while
 * the reconstruction runs, so it is the one a careless `git rev-parse HEAD`
 * would pick up. A record naming it as the deployed source would be wrong in
 * the single field the whole record exists to establish, and wrong in a way
 * that reads as perfectly ordinary.
 */

const COLLECTOR = readFileSync(join(REPO, "scripts", "collect-deployment-evidence.mjs"), "utf8");
const RECORDER = readFileSync(join(REPO, "scripts", "record-deployment.sh"), "utf8");
const DEPLOYED_SOURCE = "231dceb91c141e1afe6e57ef48fafb199da5c678";

/** Commits that carry recovery tooling and built nothing that is deployed. */
const RECOVERY_COMMITS = [
  "175143c24ebc0128623621b6fe663b14240c45b5",
  "fbb81bf0d5c64588f1fe8712e9ff2c3af4707852",
  "816027f072b07d57eaa890a7d912235199489929",
];

/* ------------------------------ no second identity table, anywhere */

test("no evidence tool carries its own permanent-identity table", () => {
  // The original defect, generalised: the failure was not "escrow was
  // forgotten" but "two lists existed and one drifted".
  const code = RECORDER.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  assert.doesNotMatch(code, /declare\s+-A\s+PERMANENT_IDS/);
  assert.doesNotMatch(code, /PERMANENT_IDS\[/);
  // And the collector resolves identity from the canonical table too.
  assert.doesNotMatch(COLLECTOR, /declare\s+-A|PERMANENT_IDS\s*=/);
});

test("recording escrow through a Core/Commerce-only table cannot succeed", () => {
  // Stated as the property rather than the symptom: every released program must
  // resolve from the one table, so a table missing any of them is a test
  // failure rather than a runtime surprise after a deployment.
  for (const program of ["ppv_core", "ppv_commerce", "ppv_escrow"]) {
    assert.ok(
      PERMANENT_PROGRAM_IDS[program],
      `${program} has no permanent identity in the canonical table`,
    );
  }
  assert.equal(PERMANENT_PROGRAM_IDS.ppv_escrow, "7U1bCHQcr8Jg6J8G69JGaAWCRtsrZB1RYx4zo1sNEVF4");
});

/* ------------------------- the recovery commit is not the deployed source */

test("the collector refuses a recovery commit equal to the release commit", () => {
  assert.match(
    COLLECTOR,
    /PPV_EVIDENCE_RECOVERY_COMMIT equals PPV_RELEASE_COMMIT/,
    "the collector does not refuse a recovery commit posing as the deployed source",
  );
  assert.match(COLLECTOR, /would falsify the/);
  assert.match(COLLECTOR, /recoveryCommit === releaseCommit/);
});

test("the release commit is never taken from the checked-out HEAD", () => {
  // The hazard is that evidence is generated from a later commit, so whatever
  // HEAD happens to be is exactly the wrong answer.
  assert.match(COLLECTOR, /const releaseCommit = env\.PPV_RELEASE_COMMIT/);
  assert.doesNotMatch(COLLECTOR, /rev-parse/, "the collector reads a commit from git");
  assert.doesNotMatch(COLLECTOR, /execFileSync|execSync|spawnSync/, "the collector shells out");
});

test("recovery provenance is its own field, not folded into the release commit", () => {
  assert.match(COLLECTOR, /evidenceRecovery: recovery/);
  assert.match(COLLECTOR, /recoveredAfterFailedRecording: true/);
  assert.match(COLLECTOR, /recoveryCommit,/);
  // Absent entirely for a record written by its own deployment.
  assert.match(COLLECTOR, /: null;/);
});

test("a malformed recovery commit is refused", () => {
  assert.match(COLLECTOR, /is not a full 40-character git sha/);
});

/* ------------------------------- any committed escrow record stays honest */

test("a committed escrow evidence record names the deployed source, not a recovery commit", (t) => {
  const dir = join(REPO, "deployments", "evidence");
  const records = existsSync(dir)
    ? readdirSync(dir).filter((name) => name.endsWith(".json"))
    : [];
  const escrow = records
    .map((name) => ({ name, body: JSON.parse(readFileSync(join(dir, name), "utf8")) }))
    .filter((entry) => entry.body.program === "ppv_escrow");

  if (escrow.length === 0) {
    t.skip("no escrow evidence record is committed yet; this guards the one that lands");
    return;
  }

  for (const { name, body } of escrow) {
    assert.equal(body.releaseCommit, DEPLOYED_SOURCE, `${name} names the wrong deployed source`);
    for (const commit of RECOVERY_COMMITS) {
      assert.notEqual(
        body.releaseCommit,
        commit,
        `${name} records recovery tooling ${commit} as the source that produced the program`,
      );
    }
    // The program it claims, and the governance it was released under.
    assert.equal(body.programId, PERMANENT_PROGRAM_IDS.ppv_escrow);
    assert.equal(body.upgradeAuthority, "FD2spnsMVgsuddPSRWAe3ee4DMbgDx5ivpvVfvKcNrLE");
    assert.equal(body.upgradeAuthorityThreshold, 2);
    assert.equal(body.cluster, "devnet");
    assert.equal(body.genesisHash, "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
    // Escrow is governed separately; the Core/Commerce vault must never appear.
    assert.notEqual(body.upgradeAuthority, "B6tcsTrMCKTZV5vi3rRCnA3FMPeeWACSHuuTSz5XQgnX");
    // Deployment and authority transfer are distinct facts.
    assert.notEqual(
      body.deploymentSignature,
      body.authorityTransferSignature,
      `${name} records one signature as both the deploy and the transfer`,
    );
    // And if it was recovered, it says so and says by what.
    if (body.evidenceRecovery) {
      assert.equal(body.evidenceRecovery.recoveredAfterFailedRecording, true);
      assert.match(body.evidenceRecovery.recoveryCommit, /^[0-9a-f]{40}$/);
      assert.notEqual(body.evidenceRecovery.recoveryCommit, body.releaseCommit);
    }
  }
});

test("no committed record carries key material", () => {
  const dir = join(REPO, "deployments", "evidence");
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".json"))) {
    const body = readFileSync(join(dir, name), "utf8");
    assert.doesNotMatch(body, /(\d+,\s*){20,}\d+/, `${name} contains a key array`);
    assert.doesNotMatch(body, /secretKey|mnemonic|seed phrase|PRIVATE KEY/i, `${name} names secret material`);
  }
});
