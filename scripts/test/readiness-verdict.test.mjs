import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("the verdict is NO-GO, and says so before it says anything else", () => {
  assert.match(VERDICT, /^# PPV ESCROW DEVNET DEPLOYMENT READINESS: NO-GO$/m);
  // The opposite string must not appear anywhere: a document containing both
  // is a document nobody can act on.
  assert.doesNotMatch(
    VERDICT,
    /DEVNET DEPLOYMENT READINESS: GO/,
    "the verdict document also contains a GO",
  );
});

test("both blockers are named, and both are marked as blocking in the register", () => {
  assert.match(VERDICT, /### Blocker 1 — milestones and bounties are not modelled under randomized adversarial execution/);
  assert.match(VERDICT, /### Blocker 2 — the randomized layer is not mutation-qualified/);
  assert.match(VERDICT, /Tracked as \*\*RR-1\*\*/);
  assert.match(VERDICT, /Tracked as \*\*RR-8\*\*/);

  // And the register agrees, so the two documents cannot drift apart.
  assert.match(REGISTER, /### RR-1 — .*— \*\*BLOCKS GO\*\*/);
  assert.match(REGISTER, /### RR-8 — .*— \*\*BLOCKS GO\*\*/);
  assert.match(REGISTER, /NO-GO/);
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
  assert.match(GATES, /PPV ESCROW DEVNET DEPLOYMENT READINESS: NO-GO/);
  assert.match(GATES, /security\/ppv-escrow-readiness-verdict\.md/);
});

test("the matrix does not read as a verdict, and Sprint 2's GO is marked superseded", () => {
  assert.match(MATRIX, /readiness verdict is\s*\n?\[\*\*NO-GO\*\*\]/);
  // Sprint 2 answered "should the next sprint be a security sprint", and its
  // GO must not be mistaken for a deployment-readiness verdict.
  assert.match(SPRINT2, /> \*\*Superseded in part\.\*\*/);
  assert.match(SPRINT2, /ppv-escrow-readiness-verdict\.md/);
});
