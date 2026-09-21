import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { REPO, ESCROW_ID } from "./helpers.mjs";

/**
 * Current-state prose about `ppv_escrow`, asserted rather than trusted.
 *
 * `ppv_escrow` is deployed to devnet and its upgrade authority is the custody
 * vault. Both facts are recorded in a committed evidence record. Before that
 * deployment the repository said, in a dozen places and correctly, that escrow
 * was not deployed and that the vault was its *intended future* authority.
 *
 * Those sentences did not stop being sentences when they stopped being true,
 * and a reader who lands on one has no way to know which sprint wrote it. This
 * suite is the mechanism that stops a stale one from surviving — or coming
 * back — once a release record exists:
 *
 *   * A doc may still discuss the pre-deployment state. It must label that
 *     discussion as historical, in the same paragraph, so the claim carries its
 *     own expiry date.
 *   * An unlabelled "escrow is not deployed" is a lie the repository is telling
 *     about live custody governance, and it fails here.
 *
 * The gate is the evidence record, not a date: with no committed Escrow
 * deployment record these assertions do not apply, because then the prose would
 * be right.
 */

const EVIDENCE_DIR = join(REPO, "deployments", "evidence");

/** Every committed devnet release record for ppv_escrow. */
function escrowReleaseRecords() {
  let entries;
  try {
    entries = readdirSync(EVIDENCE_DIR);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(EVIDENCE_DIR, name), "utf8")))
    .filter((record) => record.program === "ppv_escrow");
}

function filesUnder(dir, extensions, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "target" || entry === ".git") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) filesUnder(path, extensions, out);
    else if (extensions.some((ext) => entry.endsWith(ext))) out.push(path);
  }
  return out;
}

/**
 * This file defines the stale claims, so it necessarily contains every one of
 * them. Scanning it would make the guard permanently red on its own source.
 */
const SELF = join(REPO, "scripts", "test", "escrow-current-state-docs.test.mjs");

/**
 * Prose is prose wherever it lives.
 *
 * The first version of this guard scanned Markdown only. That was the whole
 * gap: `scripts/lib/identity.mjs` — the single record every release and
 * deployment gate reads — carried "Escrow is not deployed and no authority has
 * been transferred to this address" for four commits after both had happened,
 * and four of the patterns below matched it. A reader who opens the canonical
 * identity module is exactly the reader who must not be told that.
 *
 * So the scan follows the claim, not the file extension: Markdown, plus the
 * scripts that the gates actually execute.
 */
const SCANNED = [
  ...filesUnder(join(REPO, "docs"), [".md"]),
  join(REPO, "README.md"),
  join(REPO, "SECURITY.md"),
  ...filesUnder(join(REPO, "scripts"), [".mjs", ".sh"]).filter((path) => path !== SELF),
];

/**
 * Claims that are false the moment an Escrow release record exists.
 *
 * Deliberately phrase-level rather than word-level: "not deployed" on its own
 * appears in true sentences about mainnet, and a check that fired on those
 * would be turned off within a sprint.
 */
const STALE_CLAIMS = [
  /ppv_escrow`? is \*\*not deployed/i,
  /escrow is not deployed/i,
  /not deployed to any cluster/i,
  /no authority has been transferred/i,
  /no upgrade authority has been transferred/i,
  /has no upgrade authority yet/i,
  /is the \*?intended future\*? upgrade\s+authority/i,
  /the \*intended future\* upgrade/i,
  /escrow (?:is|was) not deployed (?:and|,)/i,
];

/**
 * A paragraph that says "this was true then" rather than "this is true".
 *
 * Checked over the whole paragraph rather than the matching line, because the
 * label naturally sits in its own sentence next to the claim it qualifies.
 */
const HISTORICAL_MARKERS = [
  /\bhistorical\b/i,
  /\bhistorically\b/i,
  /previously read/i,
  /previously said/i,
  /originally read/i,
  /used to (?:say|read|be)/i,
  /at the time of (?:this|the) (?:assessment|freeze|writing)/i,
  /as assessed/i,
  /\bwas true (?:when|until)\b/i,
  /\buntil (?:the Sprint 4 deployment|2026-09-15)\b/i,
];

/** The paragraph (blank-line delimited block) a given offset falls inside. */
function paragraphAt(text, offset) {
  const start = text.lastIndexOf("\n\n", offset);
  const end = text.indexOf("\n\n", offset);
  return text.slice(start === -1 ? 0 : start + 2, end === -1 ? text.length : end);
}

/**
 * Every unlabelled stale claim in one piece of text.
 *
 * Extracted from the file scan so a tamper case can ask the question directly
 * rather than writing a defect into the repository to see the guard fire.
 */
export function staleClaimsIn(text) {
  const found = [];
  for (const pattern of STALE_CLAIMS) {
    for (const match of text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))) {
      const paragraph = paragraphAt(text, match.index);
      if (HISTORICAL_MARKERS.some((marker) => marker.test(paragraph))) continue;
      found.push(match[0].trim());
    }
  }
  return found;
}

const RECORDS = escrowReleaseRecords();

test("a committed ppv_escrow release record exists and names the deployed program", () => {
  assert.ok(
    RECORDS.length > 0,
    "no committed ppv_escrow release record; the rest of this suite is vacuous by design",
  );
  for (const record of RECORDS) {
    assert.equal(record.programId, ESCROW_ID);
    assert.equal(record.cluster, "devnet");
    assert.equal(record.upgradeAuthority, "FD2spnsMVgsuddPSRWAe3ee4DMbgDx5ivpvVfvKcNrLE");
  }
});

test("no document makes an unlabelled pre-deployment claim about ppv_escrow", () => {
  if (RECORDS.length === 0) return;
  const offenders = [];
  for (const path of SCANNED) {
    for (const claim of staleClaimsIn(readFileSync(path, "utf8"))) {
      offenders.push(`${relative(REPO, path)}: ${claim}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "ppv_escrow is deployed to devnet with its authority on the custody vault. " +
      "These claims contradict that and are not labelled historical:\n  " +
      offenders.join("\n  "),
  );
});

/** The facts the three current-state docs must state, not merely not-contradict. */
const CURRENT_TRUTH = [
  ["the program id", ESCROW_ID],
  ["the ProgramData address", "2bWfopyJ8LxJ6azd9ZhaGmfs9S2gGRQKx6TX88ddULAa"],
  ["the upgrade authority", "FD2spnsMVgsuddPSRWAe3ee4DMbgDx5ivpvVfvKcNrLE"],
  ["the finalized transfer", "FINALIZED"],
  ["the closed provenance", "ppv-escrow-devnet-231dceb.json"],
  ["the closed custody gate", "**Custody gate** | **CLOSED**"],
  ["the open independent review", "Independent security review (RR-13) | OPEN"],
  ["the open legal review", "Legal review | OPEN"],
  ["no mainnet authorization", "Mainnet authorized | NO"],
];

for (const doc of [
  "docs/deployment-gates.md",
  "docs/security/ppv-escrow-surface.md",
  "docs/security/ppv-escrow-residual-risk.md",
]) {
  test(`${doc} states the current state of ppv_escrow`, () => {
    const text = readFileSync(join(REPO, doc), "utf8");
    assert.match(text, /## Current state — `ppv_escrow` on devnet/);
    for (const [label, fact] of CURRENT_TRUTH) {
      assert.ok(text.includes(fact), `${doc} does not state ${label} (${fact})`);
    }
  });
}

/**
 * The live-custody row has exactly two legitimate shapes, and "NOT RUN" is no
 * longer one of them.
 *
 * It was, while nothing had ever been dispatched. Since then several controlled
 * executions have run and sent disposable wallet, mint and associated-token-
 * account transactions to devnet before stopping on infrastructure. "NOT RUN"
 * understates that, and a reader who finds it and then finds those runs has to
 * work out for themselves which is wrong.
 *
 * The narrower claim is the accurate one and is what the row must carry:
 * attempts happened, and no complete custody matrix has run. `PASS` stays
 * bounded exactly as before — it requires the evidence reference that proves
 * it, because a status nobody can check is not a status.
 */
test("the current-state block does not claim a live custody validation that has not run", () => {
  for (const doc of [
    "docs/deployment-gates.md",
    "docs/security/ppv-escrow-surface.md",
    "docs/security/ppv-escrow-residual-risk.md",
  ]) {
    const text = readFileSync(join(REPO, doc), "utf8");
    const row = text.match(/\| Live devnet custody validation \| ([^|]+)\|/);
    assert.ok(row, `${doc} has no live-custody-validation row`);
    const status = row[1].trim();
    assert.ok(
      /^ATTEMPTED — NOT COMPLETED\b/.test(status) || /^PASS — /.test(status),
      `${doc} reports live custody validation as ${JSON.stringify(status)}; ` +
        "it must be ATTEMPTED — NOT COMPLETED, or PASS followed by the evidence " +
        "reference that proves it",
    );
    if (status.startsWith("ATTEMPTED")) {
      // An ATTEMPTED row must still say what was not achieved. The accurate
      // answer moved once run 35465469908 executed the whole behaviour matrix
      // and stopped in read-only reconstruction: "no custody matrix has run"
      // became false, and leaving it there would have been the drift this
      // guard exists to catch. The bound is unchanged — one of these phrases
      // must be present — only the vocabulary is wider.
      assert.match(
        status,
        /no custody matrix has run|history reconstruction did not complete/,
        `${doc} says attempts were made without saying what was not achieved`,
      );
      assert.match(
        status,
        /CANONICAL_LIVE_CUSTODY_EVIDENCE=NONE|`deployments\/validation\//,
        `${doc} claims an attempt without saying where the evidence stands`,
      );
    }
  }
});

/**
 * Tamper cases.
 *
 * A guard nobody has watched fail is a guard nobody has tested. These restore
 * the exact sentences this suite exists to catch and require it to catch them
 * — without writing a defect into the repository to find out.
 */

/** The sentence `scripts/lib/identity.mjs` carried, verbatim, until it did not. */
const RESTORED_IDENTITY_COMMENT = `  /**
   * Vault index 0, and the *intended future* upgrade authority for
   * \`ppv_escrow\`. Escrow is not deployed and no authority has been transferred
   * to this address; recording it here is what lets every gate check the same
   * destination, not a claim that it holds anything yet.
   */`;

test("restoring the identity.mjs pre-deployment comment fails the guard", () => {
  const claims = staleClaimsIn(RESTORED_IDENTITY_COMMENT);
  assert.ok(
    claims.length >= 3,
    `expected the restored comment to trip several patterns, tripped ${claims.length}`,
  );
  for (const expected of [
    /escrow is not deployed/i,
    /no authority has been transferred/i,
    /intended future/i,
  ]) {
    assert.ok(
      claims.some((claim) => expected.test(claim)),
      `the restored comment did not trip ${expected}`,
    );
  }
});

test("a historical label rescues the same sentence, and only in its own paragraph", () => {
  const labelled = `Historical note: this was true until 2026-09-15.\n${RESTORED_IDENTITY_COMMENT}`;
  assert.deepEqual(
    staleClaimsIn(labelled),
    [],
    "a labelled historical claim must be allowed",
  );

  const labelElsewhere = `Historical note: this was true until 2026-09-15.\n\n${RESTORED_IDENTITY_COMMENT}`;
  assert.ok(
    staleClaimsIn(labelElsewhere).length > 0,
    "a label in a different paragraph must not rescue the claim",
  );
});

test("the guard scans the scripts that the gates execute, not only Markdown", () => {
  const scanned = new Set(SCANNED.map((path) => relative(REPO, path)));
  assert.ok(
    scanned.has("scripts/lib/identity.mjs"),
    "the canonical identity module is not scanned; that was the original gap",
  );
  const shapes = [".md", ".mjs", ".sh"].filter((ext) =>
    [...scanned].some((path) => path.endsWith(ext)),
  );
  assert.deepEqual(shapes, [".md", ".mjs", ".sh"], "a whole file shape is unscanned");
  assert.ok(
    !scanned.has("scripts/test/escrow-current-state-docs.test.mjs"),
    "this file defines the patterns and must exclude itself",
  );
});
