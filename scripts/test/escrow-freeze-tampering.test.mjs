import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ESCROW_CUSTODY_GOVERNANCE, ESCROW_PERMANENT_ID } from "../lib/identity.mjs";
import { checkPolicy } from "../verify-custody-governance.mjs";
import { REPO } from "./helpers.mjs";

/**
 * The freeze, attacked.
 *
 * Every test above this file asserts that the repository currently agrees with
 * itself. That is necessary and it is not the same claim as "disagreement is
 * detected" — a check that reads a value and compares it to itself passes in
 * every world, including the one where someone changed both. So each test here
 * mutates exactly one identity or governance source in a throwaway copy of the
 * repository and requires the suite to go red.
 *
 * A mutation that leaves the suite green is the finding. These tests fail when
 * the freeze stops being enforced, which is the only time they are interesting.
 */

/**
 * A disposable copy of the repository's tracked files, in working-tree state.
 *
 * Copied from `git ls-files` rather than a hand-written list of the files a
 * test "should" need: a hand-written list silently omits something, the
 * sandbox fails for that reason instead of the mutation, and every tampering
 * test then passes for the wrong reason. node_modules is symlinked, not
 * copied — it is large and nothing here mutates it.
 */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "ppv-freeze-"));
  execFileSync(
    "bash",
    [
      "-c",
      "git -C \"$1\" ls-files -z | tar -C \"$1\" --null -T - -cf - | tar -x -C \"$2\"",
      "bash",
      REPO,
      dir,
    ],
    { stdio: "pipe" },
  );
  symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
  return dir;
}

/**
 * Runs the identity and custody-gate suites in the sandbox. Returns pass/fail.
 *
 * `NODE_TEST_CONTEXT` is stripped from the child's environment. Node sets it
 * for processes it spawns as part of a test run, and a `node --test` that sees
 * it switches to the child reporter — where a failing suite no longer exits
 * non-zero. Inheriting it makes every tampering test below report that the
 * mutation was caught no matter what, which is the exact failure these tests
 * exist to rule out, so it is removed deliberately rather than left to chance.
 */
function suitePasses(dir) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  try {
    execFileSync(
      process.execPath,
      [
        "--test",
        join(dir, "scripts", "test", "escrow-identity.test.mjs"),
        join(dir, "scripts", "test", "custody-gate.test.mjs"),
      ],
      { cwd: dir, stdio: "pipe", env },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Guards the guard: proves a sandbox with no mutation is green and that
 * `suitePasses` can actually report red. Without this, a `suitePasses` that
 * always returned false would make every tampering test below pass.
 */
test("the tampering harness can tell green from red", () => {
  const dir = sandbox();
  try {
    assert.ok(suitePasses(dir), "an untouched sandbox must be green");
    writeFileSync(
      join(dir, "scripts", "lib", "identity.mjs"),
      'export const ESCROW_PERMANENT_ID = null;\n',
    );
    assert.ok(!suitePasses(dir), "suitePasses never reports red, so it proves nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const edit = (dir, relative, mutate) => {
  const path = join(dir, relative);
  writeFileSync(path, mutate(readFileSync(path, "utf8")));
};

/**
 * Asserts a single-source mutation is caught. The sandbox is verified green
 * first, so a test cannot pass because the copy was broken to begin with.
 */
function tampering(name, relative, mutate) {
  test(`tampering is rejected: ${name}`, () => {
    const dir = sandbox();
    try {
      assert.ok(suitePasses(dir), "the untampered sandbox must be green first");
      edit(dir, relative, mutate);
      assert.ok(!suitePasses(dir), `${name} left the suite green`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

const OTHER_ID = "8VQ1ZLiTPPvVgtKcWAP2iLMbcSyKGrLPSjrHS3fJUKGN";
const PLACEHOLDER = "7BECot7zFqH2oCxTu9uLmmwvzQSBtxWro47jMa2MqUdR";
const IDENTITY = join("scripts", "lib", "identity.mjs");

/* -------------------------------------------------- identity tampering */

tampering("the program ID changes alone", IDENTITY, (s) =>
  s.replace(`export const ESCROW_PERMANENT_ID = "${ESCROW_PERMANENT_ID}"`,
            `export const ESCROW_PERMANENT_ID = "${OTHER_ID}"`));

tampering("Anchor.toml changes alone", "Anchor.toml", (s) =>
  s.replace(`ppv_escrow = "${ESCROW_PERMANENT_ID}"`, `ppv_escrow = "${OTHER_ID}"`));

tampering("declare_id! changes alone", join("programs", "ppv_escrow", "src", "lib.rs"), (s) =>
  s.replace(`declare_id!("${ESCROW_PERMANENT_ID}")`, `declare_id!("${OTHER_ID}")`));

tampering("the placeholder is restored", IDENTITY, (s) =>
  s.replace(`export const ESCROW_PERMANENT_ID = "${ESCROW_PERMANENT_ID}"`,
            `export const ESCROW_PERMANENT_ID = "${PLACEHOLDER}"`));

tampering("escrow is returned to the unreleased list", IDENTITY, (s) =>
  s.replace("export const UNRELEASED_PROGRAMS = Object.freeze([]);",
            'export const UNRELEASED_PROGRAMS = Object.freeze(["ppv_escrow"]);'));

/* ------------------------------------------------ governance tampering */

tampering("the custody multisig changes", IDENTITY, (s) =>
  s.replace(ESCROW_CUSTODY_GOVERNANCE.multisig, OTHER_ID));

tampering("the custody vault changes", IDENTITY, (s) =>
  s.replace(ESCROW_CUSTODY_GOVERNANCE.vault, "B6tcsTrMCKTZV5vi3rRCnA3FMPeeWACSHuuTSz5XQgnX"));

tampering("the threshold drops to 1", IDENTITY, (s) =>
  s.replace("  threshold: 2,", "  threshold: 1,"));

tampering("a member is removed", IDENTITY, (s) =>
  s.replace(`    "${ESCROW_CUSTODY_GOVERNANCE.members[1]}",\n`, ""));

tampering("a member is duplicated", IDENTITY, (s) =>
  s.replace(`    "${ESCROW_CUSTODY_GOVERNANCE.members[1]}",`,
            `    "${ESCROW_CUSTODY_GOVERNANCE.members[0]}",`));

tampering("a second shared signer is added", IDENTITY, (s) =>
  s.replace(`    "${ESCROW_CUSTODY_GOVERNANCE.members[0]}",`,
            '    "58kuGbxpvaamvYE44WYkyipBB6FVKt2qT9u3vAKtyKYV",'));

tampering("governance is removed entirely", IDENTITY, (s) =>
  s.replace(/export const ESCROW_CUSTODY_GOVERNANCE = Object\.freeze\(\{[\s\S]*?\n\}\);/,
            "export const ESCROW_CUSTODY_GOVERNANCE = null;"));

/* ---------------------------------------------- deployment-path tampering */

tampering("the frozen-id check is removed from the deploy workflow",
  join(".github", "workflows", "deploy-devnet.yml"), (s) =>
    s.replace(/is not the frozen permanent id \$\{frozen_id\}/, "is fine"));

tampering("escrow governance resolution falls back to the shared variables",
  join(".github", "workflows", "deploy-devnet.yml"), (s) =>
    s.replace("EXPECTED_AUTHORITY: ${{ steps.governance.outputs.vault }}",
              "EXPECTED_AUTHORITY: ${{ vars.PPV_SQUADS_VAULT_PDA }}"));

tampering("the devnet-only exception documentation is removed",
  join("docs", "deployment-gates.md"), (s) =>
    s.replace(/\*\*Approved exception — one shared signer, devnet only\.\*\*/, "Note:"));

tampering("the custody gate is marked open", join("docs", "deployment-gates.md"), (s) =>
  s.replace("**CUSTODY GATE: CLOSED.**", "**CUSTODY GATE: OPEN.**"));

/* ----------------------- the verifier itself, attacked without the sandbox */

test("a second shared signer is refused even with the devnet override", () => {
  // The override accepts the one approved overlap. It is not a switch that
  // turns the separation requirement off: two shared signers can reach a
  // 2-of-3 threshold between them, and that is a different risk entirely.
  const twoShared = [
    "58kuGbxpvaamvYE44WYkyipBB6FVKt2qT9u3vAKtyKYV",
    "BJmFM4k7Q32CiCYSdoYkAhXdD5Sk3BegMh2cbEAsgSwJ",
    ESCROW_CUSTODY_GOVERNANCE.members[0],
  ];
  const refused = checkPolicy({
    multisig: ESCROW_CUSTODY_GOVERNANCE.multisig,
    vault: ESCROW_CUSTODY_GOVERNANCE.vault,
    threshold: 2,
    members: twoShared,
  });
  assert.ok(refused.some((failure) => failure.includes("2 member(s) also govern")));
});

test("the non-custodial vault cannot be reused as the custody vault", () => {
  const failures = checkPolicy({
    multisig: ESCROW_CUSTODY_GOVERNANCE.multisig,
    vault: "B6tcsTrMCKTZV5vi3rRCnA3FMPeeWACSHuuTSz5XQgnX",
    threshold: 2,
    members: [...ESCROW_CUSTODY_GOVERNANCE.members],
    allowSharedSigners: true,
  });
  assert.ok(failures.some((failure) => failure.includes("already governs the non-custodial")));
});
