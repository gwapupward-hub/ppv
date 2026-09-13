import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { REPO } from "./helpers.mjs";

/**
 * The `ppv_escrow` custody gate, asserted rather than described.
 *
 * Escrow is the one PPV program that will hold value, and it is deliberately
 * absent from every path that can put a program on a cluster: the deploy
 * workflow's program choices, the release-record writer, `[programs.devnet]`,
 * and the permanent-identity table. That absence is a security boundary, and
 * until now it existed only as prose in docs/deployment-gates.md and as the
 * fact that nobody had added the line.
 *
 * Prose does not fail CI. These tests do. Every one of them is a claim the
 * Sprint 3 readiness assessment makes, restated as something a pull request
 * that quietly re-enabled escrow deployment would break.
 *
 * None of this is an opinion about whether escrow is *ready*. It is the much
 * narrower statement that nothing in this repository can deploy it today.
 */

const read = (...parts) => readFileSync(join(REPO, ...parts), "utf8");

const DEPLOY = read(".github", "workflows", "deploy-devnet.yml");
const RECORD = read("scripts", "record-deployment.sh");
const ANCHOR = read("Anchor.toml");
const IDENTITY = read("scripts", "lib", "identity.mjs");
const ESCROW_LIB = read("programs", "ppv_escrow", "src", "lib.rs");

/** The build-only placeholder. Not a permanent identity, and never deployed. */
const PLACEHOLDER = "7BECot7zFqH2oCxTu9uLmmwvzQSBtxWro47jMa2MqUdR";

/** The `[programs.<cluster>]` section of Anchor.toml, or "" when absent. */
function anchorSection(cluster) {
  const heading = new RegExp(
    `^\\[programs\\.${cluster}\\]$([\\s\\S]*?)(?=^\\[|$(?![\\s\\S]))`,
    "m",
  );
  return ANCHOR.match(heading)?.[1] ?? "";
}

test("the deploy workflow cannot be asked to deploy escrow", () => {
  // A workflow_dispatch choice list is the whole attack surface here: an
  // operator can only pick what the list offers.
  const options = DEPLOY.match(/options:\s*\[([^\]]*)\]/);
  assert.ok(options, "deploy-devnet.yml declares no program choices");
  const choices = options[1].split(",").map((entry) => entry.trim());
  assert.deepEqual(choices, ["ppv_core", "ppv_commerce"]);
  assert.ok(
    !choices.includes("ppv_escrow"),
    "ppv_escrow is selectable in the devnet deploy workflow",
  );
});

test("the deploy workflow holds no escrow signing material", () => {
  // Even an unreachable branch that fetches an escrow keypair would mean the
  // secret exists and the workflow knows its name.
  assert.doesNotMatch(DEPLOY, /ppv_escrow/i);
});

test("the release-record writer refuses escrow", () => {
  assert.match(RECORD, /ppv_core \| ppv_commerce\) ;;/);
  assert.doesNotMatch(RECORD, /ppv_escrow/);
});

test("escrow is absent from the devnet program table and present only on localnet", () => {
  const devnet = anchorSection("devnet");
  const localnet = anchorSection("localnet");
  assert.ok(devnet.length > 0, "[programs.devnet] is missing entirely");
  assert.doesNotMatch(devnet, /ppv_escrow/, "ppv_escrow appears in [programs.devnet]");
  assert.match(localnet, /ppv_escrow = "/, "ppv_escrow must still build on localnet");
});

test("escrow carries no permanent identity, and says so in every source", () => {
  // The three places an id lives agree that this one is a placeholder. They
  // agreeing is the point: a permanent id that appeared in one of them and not
  // the others is the ambiguity that makes a release unqualifiable.
  assert.match(ESCROW_LIB, new RegExp(`declare_id!\\("${PLACEHOLDER}"\\)`));
  assert.match(ESCROW_LIB, /Build-only placeholder/);
  assert.match(anchorSection("localnet"), new RegExp(`ppv_escrow = "${PLACEHOLDER}"`));

  // The permanent-identity table names the two released programs and not this
  // one, and names escrow explicitly as unreleased rather than omitting it —
  // an omission reads the same as an oversight.
  const permanent = IDENTITY.match(
    /PERMANENT_PROGRAM_IDS = Object\.freeze\(\{([\s\S]*?)\}\)/,
  );
  assert.ok(permanent, "identity.mjs declares no permanent program table");
  assert.doesNotMatch(permanent[1], /ppv_escrow/);
  assert.match(IDENTITY, /UNRELEASED_PROGRAMS = Object\.freeze\(\["ppv_escrow"\]\)/);
});

test("no permanent escrow keypair is committed anywhere in the repository", () => {
  // The safest state an unreleased identity can be in is not existing: a
  // keypair that does not exist cannot leak and cannot be deployed by accident.
  // Checked as a tracked-file question rather than by reading any key material.
  const tracked = read(".gitignore");
  assert.match(tracked, /target\//, "the build directory must stay ignored");
  assert.doesNotMatch(
    IDENTITY,
    /ppv_escrow[^\n]*keypair/i,
    "identity tooling references an escrow keypair",
  );
});

test("the custody gate is documented as closed where deployment gates are read", () => {
  // The executable checks above are the evidence; this one keeps the document
  // that operators actually read from drifting away from them.
  const gates = read("docs", "deployment-gates.md");
  assert.match(gates, /Custody gate — `ppv_escrow`/);
  assert.match(gates, /deliberately absent from `\[programs\.devnet\]`/);
});
