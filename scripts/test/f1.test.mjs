import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { REPO } from "./helpers.mjs";
import { PERMANENT_PROGRAM_IDS, PROGRAM_NAMES, UNRELEASED_PROGRAMS } from "../lib/identity.mjs";

/**
 * The F1 harness is the only thing permitted to substitute a program id in a
 * working checkout: it generates throwaway keypairs, syncs them for a
 * local-validator run, and restores the tracked files. These tests pin the two
 * ways that can go wrong — a program the harness forgets to restore, and a
 * restoration nobody checks.
 */

const F1 = readFileSync(join(REPO, "scripts", "verify-f1.sh"), "utf8");
const PREPARE = readFileSync(join(REPO, "scripts", "prepare-ephemeral-program-ids.sh"), "utf8");

/** Every program in the workspace that carries a `declare_id!`. */
function programsWithIdentities() {
  return readdirSync(join(REPO, "programs"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => {
      const lib = join(REPO, "programs", entry.name, "src", "lib.rs");
      try {
        return readFileSync(lib, "utf8").includes("declare_id!(");
      } catch {
        return false;
      }
    })
    .map((entry) => entry.name);
}

test("the permanent identity table matches the workspace exactly", () => {
  // A program in neither list is a program no tool here checks. Adding one to
  // the workspace must fail here until it is classified: permanent id, or
  // explicitly not released yet.
  assert.deepEqual(
    programsWithIdentities().sort(),
    [...PROGRAM_NAMES, ...UNRELEASED_PROGRAMS].sort(),
  );
  for (const program of UNRELEASED_PROGRAMS) {
    assert.equal(
      PERMANENT_PROGRAM_IDS[program],
      undefined,
      `${program} cannot be both unreleased and hold a permanent id`,
    );
  }
});

test("an unreleased program is not listed for any deployable cluster", () => {
  // `[programs.localnet]` is where F1 runs it. Appearing under a real cluster
  // is what would put it in front of `anchor deploy`.
  const anchorToml = readFileSync(join(REPO, "Anchor.toml"), "utf8");
  const clusters = anchorToml.split(/^\[programs\.(\w+)\]$/m);
  for (let index = 1; index < clusters.length; index += 2) {
    const cluster = clusters[index];
    if (cluster === "localnet") continue;
    for (const program of UNRELEASED_PROGRAMS) {
      assert.doesNotMatch(
        clusters[index + 1],
        new RegExp(`^${program}\\b`, "m"),
        `${program} has no permanent id and must not be listed under ${cluster}`,
      );
    }
  }
});

test("every program's identity file is restored by the F1 harness", () => {
  for (const program of programsWithIdentities()) {
    assert.match(
      F1,
      new RegExp(`programs/${program}/src/lib\\.rs`),
      `verify-f1.sh must restore programs/${program}/src/lib.rs`,
    );
    assert.match(
      PREPARE,
      new RegExp(`\\b${program}\\b`),
      `prepare-ephemeral-program-ids.sh must generate a keypair for ${program}`,
    );
  }
  // Anchor.toml carries both ids and is rewritten by `anchor keys sync` too.
  assert.match(F1, /^\s+Anchor\.toml$/m);
});

test("F1 restores identities on every exit path and proves it", () => {
  assert.match(F1, /trap cleanup EXIT/, "restoration must not depend on success");
  assert.match(F1, /verify-devnet-readiness\.sh --repo-only/);
  assert.match(F1, /F1 did not restore the permanent program identities cleanly/);
  // The original exit status must survive the added assertion.
  assert.match(F1, /status=\$\?/);
  assert.match(F1, /exit "\$\{status\}"/);
});

test("the ephemeral keys F1 generates can never be committed", () => {
  const gitignore = readFileSync(join(REPO, ".gitignore"), "utf8");
  assert.match(gitignore, /^\*-keypair\.json$/m);
  assert.match(gitignore, /^target\/$/m);
  assert.match(PREPARE, /target\/deploy/, "ephemeral keys live under the ignored target directory");
});

test("the permanent ids appear identically everywhere they are written", () => {
  const anchorToml = readFileSync(join(REPO, "Anchor.toml"), "utf8");
  for (const [program, id] of Object.entries(PERMANENT_PROGRAM_IDS)) {
    const lib = readFileSync(join(REPO, "programs", program, "src", "lib.rs"), "utf8");
    assert.match(lib, new RegExp(`declare_id!\\("${id}"\\);`), `${program} declare_id!`);

    const declared = [...anchorToml.matchAll(new RegExp(`^${program} = "(.+)"$`, "gm"))].map(
      (match) => match[1],
    );
    assert.equal(declared.length, 2, `${program} must be named for localnet and devnet`);
    assert.deepEqual(new Set(declared), new Set([id]), `${program} Anchor.toml ids`);
  }
});

test("the identity comments describe permanent status, not a placeholder", () => {
  for (const program of PROGRAM_NAMES) {
    const lib = readFileSync(join(REPO, "programs", program, "src", "lib.rs"), "utf8");
    assert.doesNotMatch(lib, /Build-only placeholder/, `${program} still calls its id a placeholder`);
    assert.match(lib, /PERMANENT PROTOCOL IDENTITY/);
    assert.match(lib, /Do NOT run `anchor keys sync`/);
  }
});
