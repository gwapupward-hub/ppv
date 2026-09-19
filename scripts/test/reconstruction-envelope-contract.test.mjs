import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { ReceiptStore } from "@gwap/ppv-indexer";

import { ESCROW_PROGRAM_ID } from "../lib/escrow-instructions.mjs";
import { CustodyDefect } from "../lib/custody-runner.mjs";
import {
  ESCROW_EVENT_ENVELOPE_FIELDS_READ,
  assertEscrowEventEnvelope,
} from "../devnet-escrow-custody.mjs";
import { REPO } from "./helpers.mjs";

/**
 * Phase 12's reading of the indexer's envelope, held to the exported type.
 *
 * Live run 35457793117 completed the whole custody behaviour matrix — ordinary
 * escrow, cancel, refund, both dispute outcomes, milestones, bounty, proof
 * submit/approve/reject, a live CPI into ppv_core, the foreign-proof negative
 * and its cleanup, and the final proof-backed settlement, with every funded
 * vault back to zero — and then failed in reconstruction with
 *
 *     ordinaryEscrow: an event was attributed to undefined, not ppv_escrow
 *
 * `undefined` is the whole finding. `EscrowEventEnvelope` carries `programId`
 * and `transactionSignature`; the harness read `program` and `signature`,
 * which are not fields of it. Every event of every scenario failed a
 * comparison against a value that never existed.
 *
 * The consumer was wrong, not the envelope, so the consumer is what changed:
 * no `program: "ppv_escrow"` field was added to the public contract to make
 * the harness's old assumption true. These tests hold the fixed consumer to
 * the type the SDK exports, and fail if either side drifts.
 */

const PROGRAM_ID = ESCROW_PROGRAM_ID.toBase58();
const AGREEMENT = "5ZRmnSJVPKb9gWsDkL5jMiTkZwCmT2r1xHN8nJ2pQ4Vu";
const SIGNATURE =
  "4pC2mZmQ6Xq8sVRr1nJd9HcPtLwKfYbA3eTgUvNz7DxM2jRkSaWp5FhQyBn8LcEo3vTdZmXrJqUgKfNbHyPs1Aq";

/** A real AgreementOpened event, shaped as the SDK decoder emits one. */
const EVENT = Object.freeze({
  program: "ppv_escrow",
  name: "AgreementOpened",
  agreement: AGREEMENT,
  timestamp: 1_760_000_000,
  agreementId: 7n,
  creator: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  counterparty: "2wmVCSfPxGPjrnMMn7rchp4uaeoTqN39mXFC2zhPdri9",
  agreementType: "Standard",
  mint: "So11111111111111111111111111111111111111112",
  vault: "GsbwXfJraMomNxBcjK7xK2xQx5MQgQx8Nqx3EhPXqCWv",
  amount: 1_000n,
  termsHash: "11111111111111111111111111111111",
  newState: "Open",
});

/** The envelope exactly as `extractEscrowEvents` builds one. */
const envelope = (overrides = {}) => ({
  event: EVENT,
  programId: PROGRAM_ID,
  transactionSignature: SIGNATURE,
  slot: 400_000_001,
  instructionIndex: 0,
  innerInstructionIndex: 1,
  blockTime: 1_760_000_000,
  ...overrides,
});

/* ============================== 1-2. a real envelope, and it is accepted */

/**
 * The SDK type's field names, read out of the source the SDK actually exports.
 *
 * Parsed rather than restated, so this file cannot describe an envelope the
 * SDK no longer has.
 */
function declaredEnvelopeFields() {
  const source = readFileSync(join(REPO, "sdk", "src", "escrow", "receipts.ts"), "utf8");
  const start = source.indexOf("export type EscrowEventEnvelope = {");
  assert.ok(start > 0, "EscrowEventEnvelope is no longer exported from sdk/src/escrow/receipts.ts");
  const body = source.slice(start, source.indexOf("\n};", start));
  return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((match) => match[1]);
}

test("1. the fixture is a real EscrowEventEnvelope, field for field", () => {
  const fields = declaredEnvelopeFields();
  assert.deepEqual(
    Object.keys(envelope()).sort(),
    [...fields].sort(),
    "the fixture and the exported EscrowEventEnvelope disagree on fields",
  );
  // And the names the failed run went looking for are not among them. This is
  // the fact the harness got wrong.
  assert.ok(!fields.includes("program"), "EscrowEventEnvelope unexpectedly has a `program` field");
  assert.ok(!fields.includes("signature"), "EscrowEventEnvelope unexpectedly has a `signature` field");
  assert.ok(fields.includes("programId") && fields.includes("transactionSignature"));
});

test("1b. the real indexer accepts the same fixture", () => {
  // Not just shaped like an envelope: the indexer's own receipt store takes it
  // and projects the agreement from it.
  const store = new ReceiptStore();
  assert.equal(store.addEvents([envelope()]), 1);
  assert.equal(store.projectAgreement(AGREEMENT).state, "Open");
});

test("2. reconstruction accepts an envelope carrying programId and transactionSignature", () => {
  const good = envelope();
  assert.equal(assertEscrowEventEnvelope(good, { key: "ordinaryEscrow", programId: PROGRAM_ID }), good);
});

/* ======================================= 3-4. the two refusals that matter */

test("3. a wrong programId is refused", () => {
  assert.throws(
    () =>
      assertEscrowEventEnvelope(envelope({ programId: "9cWE41ZDNQChvFrRoVuPQDeoVLg46ACTiZRCZaBZzfwU" }), {
        key: "ordinaryEscrow",
        programId: PROGRAM_ID,
      }),
    (error) => {
      assert.ok(error instanceof CustodyDefect);
      assert.match(error.message, /attributed to program id 9cWE41ZDNQChvFrRoVuPQDeoVLg46ACTiZRCZaBZzfwU/);
      return true;
    },
  );
});

test("3b. an envelope with no programId at all is refused, and says so without saying 'undefined, not ppv_escrow'", () => {
  // The old check's own failure mode: it compared a field that does not exist
  // and reported the absence as an attribution. An absent programId is still a
  // refusal, but it now names the program id it wanted.
  const { programId, ...withoutProgramId } = envelope();
  assert.throws(
    () => assertEscrowEventEnvelope(withoutProgramId, { key: "ordinaryEscrow", programId: PROGRAM_ID }),
    (error) => {
      assert.ok(error instanceof CustodyDefect);
      assert.match(error.message, new RegExp(`not ${PROGRAM_ID}`));
      return true;
    },
  );
});

test("4. a missing transaction signature is refused", () => {
  for (const bad of [undefined, null, "", 12345]) {
    assert.throws(
      () =>
        assertEscrowEventEnvelope(envelope({ transactionSignature: bad }), {
          key: "ordinaryEscrow",
          programId: PROGRAM_ID,
        }),
      (error) => {
        assert.ok(error instanceof CustodyDefect);
        assert.match(error.message, /carries no transaction signature/);
        return true;
      },
      `transactionSignature ${JSON.stringify(bad)} was accepted`,
    );
  }
});

/* ============================ 5-6. the source, and the contract it reads */

const HARNESS = join(REPO, "scripts", "devnet-escrow-custody.mjs");

/** Comments stripped, so prose about the old fields is not read as code. */
function harnessCode() {
  return readFileSync(HARNESS, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

test("5. the harness never reads envelope.program or envelope.signature again", () => {
  const code = harnessCode();
  const read = [...code.matchAll(/\benvelope\s*\??\.\s*(\w+)/g)].map((match) => match[1]);
  assert.ok(read.length > 0, "no envelope field accesses found; the scan is broken");
  for (const field of ["program", "signature"]) {
    assert.ok(
      !read.includes(field),
      `scripts/devnet-escrow-custody.mjs reads envelope.${field}, which EscrowEventEnvelope does ` +
        "not have; this is exactly run 35457793117",
    );
  }
  assert.ok(read.includes("programId"));
  assert.ok(read.includes("transactionSignature"));
});

test("6. every envelope field the harness reads exists on the exported type", () => {
  const fields = new Set(declaredEnvelopeFields());
  // The declared list first: it is what the harness claims to read.
  for (const field of ESCROW_EVENT_ENVELOPE_FIELDS_READ) {
    assert.ok(
      fields.has(field),
      `the harness declares it reads envelope.${field}, which EscrowEventEnvelope no longer has`,
    );
  }
  // Then the source, against the declaration: a new access that nobody added
  // to the list fails here even if the field happens to exist.
  const code = harnessCode();
  for (const [, field] of code.matchAll(/\benvelope\s*\??\.\s*(\w+)/g)) {
    assert.ok(
      ESCROW_EVENT_ENVELOPE_FIELDS_READ.includes(field),
      `envelope.${field} is read but not declared in ESCROW_EVENT_ENVELOPE_FIELDS_READ`,
    );
  }
  // And `replay.events` really is an array of these, which is what makes the
  // two lists comparable at all.
  const replay = readFileSync(join(REPO, "indexer", "src", "replay.ts"), "utf8");
  assert.match(replay, /events:\s*EscrowEventEnvelope\[\];/);
});

test("6b. the rest of the Phase 12 reads match the indexer's ReplayResult", () => {
  const code = harnessCode();
  const phase12 = code.slice(code.indexOf("export async function reconstruct"));
  const replay = readFileSync(join(REPO, "indexer", "src", "replay.ts"), "utf8");
  const declared = new Set(
    [...replay.slice(replay.indexOf("export type ReplayResult = {")).matchAll(/^\s{2}(\w+):/gm)].map(
      (match) => match[1],
    ),
  );
  const read = new Set([...phase12.matchAll(/\breplay\.(\w+)/g)].map((match) => match[1]));
  assert.ok(read.size > 0, "no replay field accesses found; the scan is broken");
  for (const field of read) {
    assert.ok(declared.has(field), `reconstruct() reads replay.${field}, absent from ReplayResult`);
  }
});
