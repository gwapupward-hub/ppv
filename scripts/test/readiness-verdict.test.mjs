import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { REPO } from "./helpers.mjs";

/**
 * The Sprint 3 readiness verdict, asserted rather than trusted.
 *
 * A verdict in a markdown file is exactly as durable as everyone's memory of
 * it. These tests make each statement of record something a change has to
 * break on purpose: flipping the verdict, quietly dropping a blocker, claiming
 * the placeholder is a permanent identity, or reporting the inapplicable
 * cross-program invariants as passing all fail here.
 *
 * They check what the record *says*, not whether it is true — the truth of it
 * is what the rest of the suite is for. A document and a repository that
 * disagree is the failure this catches.
 */

const read = (...parts) => readFileSync(join(REPO, ...parts), "utf8");

const VERDICT = read("docs", "security", "ppv-escrow-readiness-verdict.md");
const REGISTER = read("docs", "security", "ppv-escrow-residual-risk.md");
const MATRIX = read("docs", "security", "ppv-escrow-attack-matrix.md");
const GATES = read("docs", "deployment-gates.md");
const SPRINT2 = read("docs", "releases", "ppv-escrow-readiness-assessment.md");

const PLACEHOLDER = "7BECot7zFqH2oCxTu9uLmmwvzQSBtxWro47jMa2MqUdR";
const SQUADS_VAULT = "B6tcsTrMCKTZV5vi3rRCnA3FMPeeWACSHuuTSz5XQgnX";

test("the verdict is GO, and says so before it says anything else", () => {
  assert.match(VERDICT, /^# PPV ESCROW DEVNET DEPLOYMENT READINESS: GO$/m);
  // The opposite string must not appear anywhere: a document containing both
  // is a document nobody can act on.
  assert.doesNotMatch(
    VERDICT,
    /DEVNET DEPLOYMENT READINESS: NO-GO/,
    "the verdict document also contains a NO-GO",
  );
});

test("the GO is bounded: qualification is not permission to deploy", () => {
  // The failure this guards is a GO read as a deploy button. Three
  // prerequisites are open and none of them is code.
  assert.match(VERDICT, /## What this GO means, and what it does not/);
  assert.match(VERDICT, /separately controlled\*{0,2} deployment sprint/);
  assert.match(VERDICT, /SECURITY QUALIFICATION GO is not READY TO DEPLOY/);
  for (const prerequisite of ["RR-11", "RR-12", "RR-13"]) {
    assert.ok(
      VERDICT.includes(prerequisite),
      `the verdict does not name ${prerequisite} as a deployment prerequisite`,
    );
  }
});

test("neither former blocker may quietly reappear as blocking", () => {
  // RR-1 and RR-8 are closed with evidence. If either is ever marked BLOCKS GO
  // again, the verdict above is stale and must not stay GO.
  assert.match(REGISTER, /### RR-1 — .*— \*\*CLOSED\*\*/);
  assert.match(REGISTER, /### RR-8 — .*— \*\*CLOSED\*\*/);
  assert.doesNotMatch(
    REGISTER,
    /BLOCKS GO/,
    "a residual risk is marked BLOCKS GO while the verdict says GO",
  );
  assert.match(REGISTER, /READINESS: GO/);
});

test("the evidence that closed each blocker is recorded, not just the outcome", () => {
  // A CLOSED with no numbers behind it is an assertion, not evidence.
  // RR-1: every lifecycle must show randomized counts.
  for (const counter of [
    "milestoneSequences",
    "bountySequences",
    "milestoneReleases",
    "winnerSelections",
    "bountyUnassignedPayoutAttempts",
  ]) {
    assert.ok(REGISTER.includes(counter), `RR-1 records no ${counter} count`);
  }
  // RR-8: every mutation must name its class and its seed.
  assert.match(REGISTER, /mutation-qualify-property\.sh/);
  for (const cls of [
    "milestone lifecycle finality",
    "destination binding",
    "custody conservation",
    "bounty lifecycle finality",
  ]) {
    assert.ok(REGISTER.includes(cls), `RR-8 records no ${cls} mutation`);
  }
  // And the harnesses that produce that evidence must still exist.
  for (const script of ["mutation-qualify-property.sh", "mutation-qualify.sh"]) {
    assert.ok(
      existsSync(join(REPO, "scripts", script)),
      `${script} is gone, but the verdict cites it`,
    );
  }
  assert.ok(
    existsSync(join(REPO, "tests", "invariants", "reachability.test.ts")),
    "the reachability guard is gone, but RR-1 cites it",
  );
});

test("the randomized suite still carries the lifecycles that closed RR-1", () => {
  // The closure is only true while the actions exist and the floors demand
  // them. Deleting either turns the GO into a claim about nothing.
  const actions = read("tests", "invariants", "actions.ts");
  for (const kind of [
    "createMilestone",
    "submitMilestone",
    "approveMilestone",
    "rejectMilestone",
    "settleMilestone",
    "selectWinner",
  ]) {
    assert.ok(actions.includes(kind), `the property suite lost the ${kind} action`);
  }
  const suite = read("tests", "invariants", "protocol.invariant.ts");
  for (const floor of [
    "milestonesScheduled",
    "milestoneReleases",
    "milestoneForeignAccountAttempts",
    "winnerSelections",
    "bountyUnassignedPayoutAttempts",
  ]) {
    assert.ok(suite.includes(`coverage.${floor} > 0`), `the suite lost the ${floor} floor`);
  }
});

test("the placeholder id is never represented as an approved permanent identity", () => {
  assert.match(VERDICT, new RegExp(`\`${PLACEHOLDER}\` is a build/local placeholder`));
  assert.match(VERDICT, /\*\*not\*\* an approved permanent deployment identity/);
  assert.match(VERDICT, /No permanent `ppv_escrow` identity exists/);

  // The repository must still agree: the id lives in exactly two places, and
  // the permanent-identity table is not one of them.
  const identity = read("scripts", "lib", "identity.mjs");
  const permanent = identity.match(/PERMANENT_PROGRAM_IDS = Object\.freeze\(\{([\s\S]*?)\}\)/);
  assert.ok(permanent, "identity.mjs declares no permanent program table");
  assert.ok(
    !permanent[1].includes(PLACEHOLDER) && !permanent[1].includes("ppv_escrow"),
    "the placeholder or ppv_escrow appears in the permanent identity table",
  );
});

test("the cross-program invariants are recorded as not applicable, not as passing", () => {
  assert.match(VERDICT, /PPV-X1, PPV-X2 and PPV-X3 are NOT APPLICABLE — they do not pass/);
  assert.match(VERDICT, /does not reference `ppv_commerce` anywhere/);

  // The matrix rows for them must say NOT APPLICABLE, and must not say pass.
  const rows = MATRIX.split("\n").filter(
    (line) => line.startsWith("| X-6 ") || line.startsWith("| X-7 "),
  );
  assert.equal(rows.length, 2, "the matrix is missing the cross-program binding rows");
  for (const row of rows) {
    assert.match(row, /NOT APPLICABLE/);
    assert.doesNotMatch(row, /\| pass \|/, "an inapplicable invariant is reported as passing");
  }

  // And the claim is only true while the program really has no such reference.
  const escrowSources = read("programs", "ppv_escrow", "src", "lib.rs");
  assert.doesNotMatch(escrowSources, /ppv_commerce/);
});

test("the missing separate custody multisig is recorded", () => {
  assert.match(VERDICT, /### The separate custody multisig required by policy does not exist/);
  assert.match(VERDICT, new RegExp(`\`${SQUADS_VAULT}\``));
  assert.match(VERDICT, /A\s*\n?second, independent multisig has not been created/);
  assert.match(VERDICT, /Tracked as\s*\n?\*\*RR-11\*\*/);
});

test("Core and Commerce are recorded as verified and unchanged", () => {
  assert.match(VERDICT, /\*\*PPV CORE DEVNET RELEASE: VERIFIED\. PPV COMMERCE DEVNET RELEASE: VERIFIED\.\*\*/);
  assert.match(VERDICT, /Neither was redeployed/);
});

test("escrow is recorded as undeployed with the custody gate closed", () => {
  assert.match(VERDICT, /\*\*PPV ESCROW DEPLOYED: NO\. PPV ESCROW CUSTODY GATE: CLOSED\.\*\*/);
  // The gate document must point at the verdict, or an operator reading the
  // gates never learns one was issued.
  assert.match(GATES, /PPV ESCROW DEVNET DEPLOYMENT READINESS: GO/);
  // The gate is closed independently of the verdict, and must say so.
  assert.match(GATES, /a GO\s*\n?does not open it/);
  assert.match(GATES, /security\/ppv-escrow-readiness-verdict\.md/);
});

test("the matrix does not read as a verdict, and Sprint 2's GO is marked superseded", () => {
  assert.match(MATRIX, /readiness verdict is\s*\n?\[\*\*GO\*\*\]/);
  // And the matrix must say what the GO is bounded to, so a reader who starts
  // there does not conclude the program is deployable.
  assert.match(MATRIX, /separately controlled deployment sprint and nothing else/);
  // Sprint 2 answered "should the next sprint be a security sprint", and its
  // GO must not be mistaken for a deployment-readiness verdict.
  assert.match(SPRINT2, /> \*\*Superseded in part\.\*\*/);
  assert.match(SPRINT2, /ppv-escrow-readiness-verdict\.md/);
});
