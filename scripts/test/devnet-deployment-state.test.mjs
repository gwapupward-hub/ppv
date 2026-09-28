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

test("Commerce has a frozen identity but is not recorded as deployed before its first release", () => {
  assert.equal(
    PERMANENT_PROGRAM_IDS.ppv_commerce,
    "GmRDoFuPrBrsxnvTX751WK5rLu14JXe4sgjh6vNwHzr3",
  );
  assert.equal(DEVNET_DEPLOYED_PROGRAMS.includes("ppv_commerce"), false);
  assert.equal(evidencePrograms().has("ppv_commerce"), false);

  const candidate = JSON.parse(
    readFileSync(
      join(REPO, "deployments", "release-candidates", "ppv_commerce.json"),
      "utf8",
    ),
  );
  assert.equal(candidate.program, "ppv_commerce");
  assert.equal(candidate.programId, PERMANENT_PROGRAM_IDS.ppv_commerce);
  assert.equal(candidate.status, "awaiting-approvals");
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
