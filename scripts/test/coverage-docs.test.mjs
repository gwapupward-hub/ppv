import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { REPO } from "./helpers.mjs";

/**
 * The scope tables are claims about the property suite, and they went stale.
 *
 * `docs/property-testing.md` listed disputes, refunds, milestones, bounties
 * and `select_counterparty` as *not covered* for a sprint after the generator
 * started producing all of them, while `docs/invariants.md` described PPV-P10
 * as four legal edges when `LEGAL_EDGES` carried eleven. Both errors point a
 * reviewer away from the one path that genuinely is unmodelled.
 *
 * So understating coverage is checked as strictly as overstating it. A
 * generator change that closes a gap fails here until the table follows, and
 * one that opens a gap fails until the table admits it.
 *
 * The declarations are parsed out of the TypeScript source rather than
 * restated here, so this guard cannot describe a generator the suite no longer
 * has. It lives beside the other documentation guards, under plain node, for
 * the same reason they do.
 */

const PROPERTY_DOC = readFileSync(join(REPO, "docs", "property-testing.md"), "utf8");
const INVARIANTS_DOC = readFileSync(join(REPO, "docs", "invariants.md"), "utf8");
const ACTIONS_SRC = readFileSync(join(REPO, "tests", "invariants", "actions.ts"), "utf8");
const MODEL_SRC = readFileSync(join(REPO, "tests", "invariants", "model.ts"), "utf8");

/** The `ActionKind` union, read from its declaration. */
function actionKinds() {
  const start = ACTIONS_SRC.indexOf("export type ActionKind =");
  assert.ok(start >= 0, "the ActionKind union is gone");
  const block = ACTIONS_SRC.slice(start, ACTIONS_SRC.indexOf(";", start));
  return [...block.matchAll(/"([a-zA-Z]+)"/g)].map(([, name]) => name);
}

/** The `AGREEMENT_FLAVOURS` array, read from its declaration. */
function agreementFlavours() {
  const start = ACTIONS_SRC.indexOf("export const AGREEMENT_FLAVOURS");
  assert.ok(start >= 0, "AGREEMENT_FLAVOURS is gone");
  const block = ACTIONS_SRC.slice(start, ACTIONS_SRC.indexOf("];", start));
  return [...block.matchAll(/"([a-z]+)"/g)].map(([, name]) => name);
}

/** The `LEGAL_EDGES` table, read from its declaration. */
function legalEdges() {
  const start = MODEL_SRC.indexOf("export const LEGAL_EDGES");
  assert.ok(start >= 0, "LEGAL_EDGES is gone");
  const block = MODEL_SRC.slice(start, MODEL_SRC.indexOf("];", start));
  return [...block.matchAll(/\["([a-z]+)",\s*"([a-z]+)"\]/g)].map(([, a, b]) => [a, b]);
}

/** Instruction name for each generated action. Exhaustiveness is asserted below. */
const ACTION_TO_INSTRUCTION = {
  fund: "fund",
  complete: "mark_completed",
  settle: "settle",
  cancel: "cancel",
  refund: "refund",
  dispute: "open_dispute",
  resolve: "resolve_dispute",
  createMilestone: "create_milestone",
  submitMilestone: "submit_milestone",
  approveMilestone: "approve_milestone",
  rejectMilestone: "reject_milestone",
  settleMilestone: "settle_milestone",
  selectWinner: "select_counterparty",
};

/** Instructions the generator does not emit. Explicit on purpose. */
const UNMODELLED_INSTRUCTIONS = ["submit_proof", "approve_proof", "reject_proof"];

/** The scope table's two columns, as raw text. */
function scopeColumns() {
  const lines = PROPERTY_DOC.split("\n");
  const header = lines.findIndex((line) => line.startsWith("| Covered now |"));
  assert.ok(header >= 0, "the scope table is gone");
  const body = [];
  for (let i = header + 2; i < lines.length && lines[i].startsWith("| "); i += 1) {
    body.push(lines[i]);
  }
  assert.ok(body.length >= 6, `the scope table lost rows: ${body.length}`);
  return {
    covered: body.map((line) => line.split("|")[1] ?? "").join("\n"),
    notCovered: body.map((line) => line.split("|")[2] ?? "").join("\n"),
  };
}

test("every ActionKind is mapped, so a new action cannot slip past this guard", () => {
  const unmapped = actionKinds().filter((kind) => !(kind in ACTION_TO_INSTRUCTION));
  assert.deepEqual(unmapped, [], "an ActionKind exists that this guard does not know about");
  assert.equal(
    actionKinds().length,
    Object.keys(ACTION_TO_INSTRUCTION).length,
    "the mapping and the union have drifted apart",
  );
});

test("every generated instruction is named on the covered side and only there", () => {
  const { covered, notCovered } = scopeColumns();
  const misplaced = [];
  for (const instruction of Object.values(ACTION_TO_INSTRUCTION)) {
    // Backticked and exact: `settle` must not be satisfied by `settlement_proof`,
    // which is a different claim on the other side of the table.
    if (notCovered.includes(`\`${instruction}\``)) {
      misplaced.push(`${instruction} is generated but listed as not covered`);
    }
    if (!covered.includes(`\`${instruction}\``)) {
      misplaced.push(`${instruction} is generated but not named in the covered column`);
    }
  }
  assert.deepEqual(
    misplaced,
    [],
    `docs/property-testing.md misstates coverage:\n  ${misplaced.join("\n  ")}`,
  );
});

test("every unmodelled instruction stays on the not-covered side", () => {
  const { covered, notCovered } = scopeColumns();
  const overclaimed = [];
  for (const instruction of UNMODELLED_INSTRUCTIONS) {
    if (!notCovered.includes(`\`${instruction}\``)) {
      overclaimed.push(`${instruction} is not generated but is missing from the not-covered column`);
    }
    if (covered.includes(`\`${instruction}\``)) {
      overclaimed.push(`${instruction} is not generated but is claimed as covered`);
    }
  }
  assert.deepEqual(
    overclaimed,
    [],
    `docs/property-testing.md overstates coverage:\n  ${overclaimed.join("\n  ")}`,
  );
});

test("the proof lifecycle really is absent from the generator", () => {
  assert.ok(
    !actionKinds().some((kind) => /proof/i.test(kind)),
    "a proof action now exists; the scope table and the RR-13 package both claim it does not",
  );
});

test("Token-2022 stays outside the current security claim", () => {
  assert.match(
    scopeColumns().notCovered,
    /Token-2022/,
    "Token-2022 must remain on the not-covered side",
  );
});

test("the agreement types the generator builds match the scope table", () => {
  const { covered, notCovered } = scopeColumns();
  assert.deepEqual(agreementFlavours(), ["escrow", "milestone", "bounty"]);
  for (const named of ["Escrow", "MilestoneContract", "Bounty"]) {
    assert.ok(covered.includes(named), `${named} is generated but not listed as covered`);
  }
  for (const unimplemented of ["Invoice", "Contract", "ProofOnly"]) {
    assert.ok(
      notCovered.includes(unimplemented),
      `${unimplemented} is unimplemented and must stay on the not-covered side`,
    );
  }
});

test("PPV-P10 lists exactly the edges LEGAL_EDGES carries", () => {
  const row = INVARIANTS_DOC.split("\n").find((line) => line.startsWith("| PPV-P10 |"));
  assert.ok(row, "PPV-P10 is gone from docs/invariants.md");

  const STATE = {
    open: "Open",
    funded: "Funded",
    completed: "Completed",
    settled: "Settled",
    cancelled: "Cancelled",
    disputed: "Disputed",
    refunded: "Refunded",
  };
  const edges = legalEdges();
  assert.equal(edges.length, 11, "the edge count changed; PPV-P10's wording must follow");

  const missing = edges.filter(([from, to]) => !row.includes(`${STATE[from]} → ${STATE[to]}`));
  assert.deepEqual(
    missing.map(([a, b]) => `${a} → ${b}`),
    [],
    "LEGAL_EDGES carries edges PPV-P10 does not list",
  );
  assert.match(row, /the eleven in `LEGAL_EDGES`/, "PPV-P10 must state the count it claims");
});
