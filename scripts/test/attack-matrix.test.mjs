import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { REPO } from "./helpers.mjs";

/**
 * The attack matrix cites evidence. These tests check the citations.
 *
 * A matrix that names a test which has been renamed or deleted is worse than
 * no matrix: it reads as coverage and is not. So every test name and every
 * file path it cites must resolve, and every residual risk it refers to must
 * exist in the register.
 *
 * This does not check that the tests *prove* what the matrix says they prove —
 * nothing automated can. It checks the much narrower thing that goes stale on
 * its own: that the evidence is still there.
 */

const MATRIX = readFileSync(
  join(REPO, "docs", "security", "ppv-escrow-attack-matrix.md"),
  "utf8",
);
const REGISTER = readFileSync(
  join(REPO, "docs", "security", "ppv-escrow-residual-risk.md"),
  "utf8",
);

/** Every file under a directory, recursively, as repo-relative paths. */
function walk(dir, acc = []) {
  for (const entry of readdirSync(join(REPO, dir))) {
    if (entry === "node_modules" || entry === "target" || entry === ".git") continue;
    const rel = `${dir}/${entry}`;
    if (statSync(join(REPO, rel)).isDirectory()) walk(rel, acc);
    else acc.push(rel);
  }
  return acc;
}

const SOURCES = [
  ...walk("programs"),
  ...walk("tests"),
  ...walk("scripts"),
  ...walk("indexer/test"),
]
  .filter((path) => /\.(rs|ts|mjs)$/.test(path))
  // This file names the things it forbids, so it cannot be part of the corpus
  // it searches.
  .filter((path) => !path.endsWith("attack-matrix.test.mjs"));

const ALL_SOURCE_TEXT = SOURCES.map((path) => readFileSync(join(REPO, path), "utf8")).join("\n");

test("every Rust test the matrix cites exists", () => {
  // Citations look like `file.rs::test_name` or a bare `test_name` in the
  // evidence column; the qualified form is the one worth checking mechanically.
  const cited = [...MATRIX.matchAll(/`([a-z_]+\.rs)::([a-z_0-9]+)`/g)];
  assert.ok(cited.length >= 8, `expected several Rust citations, found ${cited.length}`);
  // Several programs have a file called `agreement.rs`, so every candidate is
  // checked rather than the first one found. Matching only the first is how a
  // correct citation reads as missing.
  const missing = cited.filter(([, file, name]) => {
    const candidates = SOURCES.filter((path) => path.endsWith(`/${file}`));
    return !candidates.some((path) =>
      readFileSync(join(REPO, path), "utf8").includes(`fn ${name}(`),
    );
  });
  assert.deepEqual(
    missing.map(([whole]) => whole),
    [],
    "the attack matrix cites Rust tests that do not exist",
  );
});

test("every file the matrix and register cite exists", () => {
  const paths = new Set();
  for (const text of [MATRIX, REGISTER]) {
    for (const [, path] of text.matchAll(
      /`((?:scripts|tests|programs|indexer|docs)\/[A-Za-z0-9_./-]+)`/g,
    )) {
      paths.add(path);
    }
  }
  assert.ok(paths.size >= 5, `expected several file citations, found ${paths.size}`);
  const missing = [...paths].filter((path) => !existsSync(join(REPO, path)));
  assert.deepEqual(missing, [], "cited files do not exist");
});

test("every residual risk the matrix refers to is in the register", () => {
  const referenced = new Set(
    [...MATRIX.matchAll(/\bRR-(\d+)\b/g)].map(([, id]) => `RR-${id}`),
  );
  assert.ok(referenced.size >= 6, `expected several risk references, found ${referenced.size}`);
  const missing = [...referenced].filter(
    (id) => !new RegExp(`### ${id} — `).test(REGISTER),
  );
  assert.deepEqual(missing, [], "the matrix refers to risks the register does not define");
});

test("the register classifies every risk it defines", () => {
  const defined = [...REGISTER.matchAll(/### (RR-\d+) — /g)].map(([, id]) => id);
  assert.ok(defined.length >= 10, `expected the register to define many risks, found ${defined.length}`);
  assert.equal(new Set(defined).size, defined.length, "duplicate risk ids");

  // Every id must sit under one of the classification headings the register
  // declares, so a risk cannot be added without being given a severity.
  const sections = [...REGISTER.matchAll(/^## (.+)$/gm)].map(([, name]) => name);
  for (const required of ["CRITICAL", "MEDIUM", "LOW", "DEFERRED"]) {
    assert.ok(
      sections.some((name) => name.includes(required)),
      `the register has no ${required} section`,
    );
  }
  const criticalBody = REGISTER.split("## CRITICAL")[1].split("## ")[0];
  const highBody = REGISTER.split("## HIGH")[1].split("## ")[0];
  assert.match(criticalBody, /\*\*None\.\*\*/, "the CRITICAL section must state None explicitly");
  assert.match(highBody, /\*\*None\.\*\*/, "the HIGH section must state None explicitly");
});

test("no row claims live devnet verification, because no row is mapped to a transaction", () => {
  // The one claim that would be false rather than merely stale. Checked on
  // table rows only: the prose says the words in order to rule them out.
  //
  // The reason has narrowed twice — the program is deployed, and the custody
  // matrix has run with committed evidence — so the check is now on the
  // surviving condition rather than on the original premise.
  const rows = MATRIX.split("\n").filter((line) => line.startsWith("|"));
  const claiming = rows.filter((line) => line.includes("LIVE DEVNET VERIFIED"));
  assert.deepEqual(
    claiming,
    [],
    "a row claims LIVE DEVNET VERIFIED, but no row is mapped to a transaction in the committed run",
  );
  assert.match(MATRIX, /\*\*No row here is LIVE DEVNET VERIFIED\*\*/);
  assert.match(
    MATRIX,
    /no row below is mapped to a transaction in that\s+evidence/,
    "the matrix must state the surviving reason, not a premise that has become false",
  );
});

/**
 * A row's evidence column is a claim about a test, and a claim about a test
 * goes stale the same way any other claim does.
 *
 * `every Rust test the matrix cites exists` checks the Rust citations. This
 * checks the quoted JavaScript ones: a row that cites `foo.test.mjs` and then
 * quotes "some test name" must be quoting a test that file actually defines.
 * Deployment-surface rows drifted exactly this way once — G-1 and G-3 cited
 * `custody-gate.test.mjs` for defences that file had come to assert the
 * negation of — so the citation shape is now mechanically checked.
 */
test("every quoted JavaScript test the matrix cites is defined in the file cited beside it", () => {
  const rows = MATRIX.split("\n").filter((line) => line.startsWith("| "));
  const checked = [];
  const missing = [];
  for (const row of rows) {
    const files = [...row.matchAll(/`(scripts\/[A-Za-z0-9_./-]+\.mjs)`/g)].map(([, f]) => f);
    if (files.length === 0) continue;
    const quoted = [...row.matchAll(/"([^"]{8,})"/g)].map(([, q]) => q);
    for (const name of quoted) {
      checked.push(name);
      const defined = files.some((file) => {
        const path = join(REPO, file);
        return existsSync(path) && readFileSync(path, "utf8").includes(`test("${name}"`);
      });
      if (!defined) missing.push(`${files.join(", ")} :: "${name}"`);
    }
  }
  assert.ok(
    checked.length >= 4,
    `expected several quoted JS citations to check, found ${checked.length}`,
  );
  assert.deepEqual(
    missing,
    [],
    "the matrix quotes tests that the file it cites does not define",
  );
});

/**
 * Residual-risk references in a row must agree with the register's own
 * headline for that risk.
 *
 * G-8 said "NOT COVERED — see RR-7" for a sprint after RR-7 closed for the
 * custody multisig. A row may still point at a risk that is closed *in part*,
 * but it may not point at one the register calls CLOSED outright while
 * claiming the risk is uncovered.
 */
test("a row citing a risk the register calls closed does not also call it NOT COVERED", () => {
  const rows = MATRIX.split("\n").filter((line) => line.startsWith("| "));
  const contradictions = [];
  for (const row of rows) {
    if (!row.includes("NOT COVERED")) continue;
    for (const [, id] of row.matchAll(/\bRR-(\d+)\b/g)) {
      const heading = REGISTER.split("\n").find((line) =>
        line.startsWith(`### RR-${id} —`),
      );
      if (!heading) continue;
      const closedOutright =
        /\*\*CLOSED\*\*/.test(heading) || /\(CLOSED\)/.test(heading);
      if (closedOutright) contradictions.push(`RR-${id}: ${heading.trim()}`);
    }
  }
  assert.deepEqual(
    contradictions,
    [],
    "a NOT COVERED row cites a residual risk the register records as closed",
  );
});

test("the token-program scope is stated and matches the code", () => {
  assert.match(MATRIX, /TOKEN-2022 = OUT OF CURRENT SECURITY CLAIM/);
  // The claim is only true while every custody instruction pins classic Token.
  const custody = readFileSync(
    join(REPO, "programs", "ppv_escrow", "src", "instructions", "custody.rs"),
    "utf8",
  );
  assert.match(custody, /Program<'info, Token>/);
  assert.ok(
    !ALL_SOURCE_TEXT.includes("anchor_spl::token_2022::"),
    "a source file uses token_2022 while the matrix claims classic-token-only scope",
  );
});
