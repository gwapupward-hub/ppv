import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  DEVNET_DEPLOYED_PROGRAMS,
  PERMANENT_PROGRAM_IDS,
} from "../lib/identity.mjs";
import { REPO } from "./helpers.mjs";

function evidencePrograms() {
  const dir = join(REPO, "deployments", "evidence");
  if (!existsSync(dir)) return new Set();
  return new Set(
    readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")))
      .filter((record) => record.cluster === "devnet")
      .map((record) => record.program),
  );
}

test("Commerce is recorded as deployed only with committed release evidence", () => {
  assert.equal(
    PERMANENT_PROGRAM_IDS.ppv_commerce,
    "GmRDoFuPrBrsxnvTX751WK5rLu14JXe4sgjh6vNwHzr3",
  );
  assert.equal(DEVNET_DEPLOYED_PROGRAMS.includes("ppv_commerce"), true);
  assert.equal(evidencePrograms().has("ppv_commerce"), true);
  assert.equal(
    existsSync(
      join(REPO, "deployments", "release-candidates", "ppv_commerce.json"),
    ),
    false,
  );

  const evidence = JSON.parse(
    readFileSync(
      join(
        REPO,
        "deployments",
        "evidence",
        "ppv-commerce-devnet-83b5e88.json",
      ),
      "utf8",
    ),
  );
  assert.equal(evidence.releaseCommit, "83b5e8843b5492f4c1b596cb5d4be5d997eb87e4");
  assert.equal(evidence.programId, PERMANENT_PROGRAM_IDS.ppv_commerce);
  assert.equal(evidence.binaryHashesMatch, true);
  assert.equal(
    evidence.upgradeAuthority,
    "B6tcsTrMCKTZV5vi3rRCnA3FMPeeWACSHuuTSz5XQgnX",
  );
  assert.equal(evidence.upgradeAuthorityThreshold, 2);
});

test("every program currently recorded as deployed has committed devnet evidence", () => {
  const evidence = evidencePrograms();
  for (const program of DEVNET_DEPLOYED_PROGRAMS) {
    assert.ok(
      evidence.has(program),
      `${program} is marked deployed but has no committed devnet release evidence`,
    );
  }
});
