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

function markdownFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) markdownFiles(path, out);
    else if (entry.endsWith(".md")) out.push(path);
  }
  return out;
}

const DOCS = [
  ...markdownFiles(join(REPO, "docs")),
  join(REPO, "README.md"),
  join(REPO, "SECURITY.md"),
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
  for (const path of DOCS) {
    const text = readFileSync(path, "utf8");
    for (const pattern of STALE_CLAIMS) {
      for (const match of text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))) {
        const paragraph = paragraphAt(text, match.index);
        if (HISTORICAL_MARKERS.some((marker) => marker.test(paragraph))) continue;
        offenders.push(`${relative(REPO, path)}: ${match[0].trim()}`);
      }
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
      assert.match(
        status,
        /no custody matrix has run/,
        `${doc} says attempts were made without saying what was not achieved`,
      );
    }
  }
});
