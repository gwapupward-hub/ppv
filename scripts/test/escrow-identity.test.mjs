import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  ESCROW_CUSTODY_GOVERNANCE,
  ESCROW_PERMANENT_ID,
  ESCROW_PLACEHOLDER_ID,
  PERMANENT_PROGRAM_IDS,
  UNRELEASED_PROGRAMS,
} from "../lib/identity.mjs";
import { isAddress, isOnCurve } from "../lib/pubkey.mjs";
import { REPO } from "./helpers.mjs";

/**
 * The `ppv_escrow` identity freeze, enforced in both of its states.
 *
 * Before the ceremony there is no permanent id, and the thing to guarantee is
 * that nothing anywhere pretends otherwise — the build-only placeholder must
 * not appear in a release record, a permanent-identity table, or a deployment
 * path. After the ceremony there is exactly one, and the thing to guarantee is
 * that every source names it.
 *
 * Both are asserted here, selected by whether `ESCROW_PERMANENT_ID` is set, so
 * the transition cannot be half-entered: setting the constant without updating
 * `declare_id!` fails, and updating `declare_id!` without the constant fails.
 * That is what makes this a freeze rather than a convention.
 */

const read = (...parts) => readFileSync(join(REPO, ...parts), "utf8");
const ESCROW_LIB = read("programs", "ppv_escrow", "src", "lib.rs");
const ANCHOR = read("Anchor.toml");

function anchorSection(cluster) {
  const heading = new RegExp(
    `^\\[programs\\.${cluster}\\]$([\\s\\S]*?)(?=^\\[|$(?![\\s\\S]))`,
    "m",
  );
  return ANCHOR.match(heading)?.[1] ?? "";
}

function declaredId() {
  return ESCROW_LIB.match(/declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)/)?.[1] ?? null;
}

test("the two identity states are mutually exclusive and both are described", () => {
  // `null` is a fact about the world — no keypair exists — not a blank to fill
  // in casually. Whichever state we are in, exactly one set of rules applies.
  if (ESCROW_PERMANENT_ID !== null) {
    assert.ok(
      isAddress(ESCROW_PERMANENT_ID),
      `ESCROW_PERMANENT_ID is ${ESCROW_PERMANENT_ID}, which is not a Solana address`,
    );
    assert.notEqual(
      ESCROW_PERMANENT_ID,
      ESCROW_PLACEHOLDER_ID,
      "the permanent id was set to the build-only placeholder",
    );
  }
});

test("the placeholder is never treated as a permanent identity", () => {
  // True in both states: the placeholder is a build convenience and must not
  // reach a permanent-identity table, a release record, or a deploy path.
  assert.ok(
    !Object.values(PERMANENT_PROGRAM_IDS).includes(ESCROW_PLACEHOLDER_ID),
    "the placeholder appears in the permanent identity table",
  );
  const deploy = read(".github", "workflows", "deploy-devnet.yml");
  assert.ok(!deploy.includes(ESCROW_PLACEHOLDER_ID), "the placeholder appears in the deploy workflow");

  const evidenceDir = join(REPO, "deployments", "evidence");
  if (existsSync(evidenceDir)) {
    for (const entry of readdirSync(evidenceDir)) {
      if (!entry.endsWith(".json")) continue;
      const record = readFileSync(join(evidenceDir, entry), "utf8");
      assert.ok(
        !record.includes(ESCROW_PLACEHOLDER_ID),
        `${entry} records the build-only placeholder as a deployed id`,
      );
    }
  }
});

test("before the ceremony, escrow is unreleased in every source", (t) => {
  if (ESCROW_PERMANENT_ID !== null) {
    t.skip("the permanent identity exists; the released-state checks below apply");
    return;
  }
  // Escrow must be named as unreleased rather than omitted: silence is how a
  // program ends up deployed with an id nothing checks.
  assert.ok(UNRELEASED_PROGRAMS.includes("ppv_escrow"));
  assert.ok(!("ppv_escrow" in PERMANENT_PROGRAM_IDS));

  // The workspace still builds, so the placeholder stays on localnet only.
  assert.equal(declaredId(), ESCROW_PLACEHOLDER_ID);
  assert.match(anchorSection("localnet"), new RegExp(`ppv_escrow = "${ESCROW_PLACEHOLDER_ID}"`));
  assert.doesNotMatch(anchorSection("devnet"), /ppv_escrow/);

  // And no governance may be recorded for a program that has no identity: a
  // release cannot be assembled against a vault nobody has created.
  assert.equal(
    ESCROW_CUSTODY_GOVERNANCE,
    null,
    "custody governance is recorded for an escrow release that has no identity",
  );
});

test("after the ceremony, every identity source names exactly the permanent id", (t) => {
  if (ESCROW_PERMANENT_ID === null) {
    t.skip("no permanent identity yet; the unreleased-state checks above apply");
    return;
  }
  // The freeze. Any one of these disagreeing is an identity drift, and the
  // only safe response is to reconcile deliberately — never to regenerate.
  assert.equal(declaredId(), ESCROW_PERMANENT_ID, "declare_id! does not name the permanent id");
  assert.match(
    anchorSection("devnet"),
    new RegExp(`ppv_escrow = "${ESCROW_PERMANENT_ID}"`),
    "Anchor.toml [programs.devnet] does not name the permanent id",
  );
  assert.match(
    anchorSection("localnet"),
    new RegExp(`ppv_escrow = "${ESCROW_PERMANENT_ID}"`),
    "Anchor.toml [programs.localnet] does not name the permanent id",
  );
  assert.equal(
    PERMANENT_PROGRAM_IDS.ppv_escrow,
    ESCROW_PERMANENT_ID,
    "the permanent identity table does not name the permanent id",
  );
  assert.ok(
    !UNRELEASED_PROGRAMS.includes("ppv_escrow"),
    "escrow still lists as unreleased while carrying a permanent id",
  );

  // A program id is a public key on the curve. An off-curve "program id" is a
  // PDA, which nothing can deploy to.
  assert.ok(isOnCurve(ESCROW_PERMANENT_ID), "the permanent id is not a valid program address");

  // Governance must exist too: an identity without custody governance is a
  // program that can be deployed and then cannot be safely governed.
  assert.notEqual(
    ESCROW_CUSTODY_GOVERNANCE,
    null,
    "a permanent escrow identity exists with no custody governance recorded",
  );
});

test("the identity table stays exhaustive over the workspace", () => {
  // Adding a fourth program must fail here until someone decides which list it
  // belongs in, rather than defaulting to invisible.
  const programs = readdirSync(join(REPO, "programs"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const accounted = new Set([...Object.keys(PERMANENT_PROGRAM_IDS), ...UNRELEASED_PROGRAMS]);
  for (const program of programs) {
    assert.ok(accounted.has(program), `${program} is in neither identity list`);
  }
});
