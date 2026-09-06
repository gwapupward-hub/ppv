import assert from "node:assert/strict";
import test from "node:test";

import { encodeBase58 } from "@gwap/ppv-sdk";

import { accountKeysOf, deriveEventAuthority, extractEscrowEvents } from "../src/events.js";
import {
  EVENT_AUTHORITY,
  LIFECYCLE_FIXTURE,
  PROGRAM_ID,
  signatureFor,
  transactionFor,
} from "./helpers/chain-fixtures.js";

const options = { programId: PROGRAM_ID, eventAuthority: EVENT_AUTHORITY };

test("every event in a transaction is extracted with its chain coordinates", () => {
  const tx = transactionFor({ signature: signatureFor(1), slot: 500, events: [...LIFECYCLE_FIXTURE] });
  const envelopes = extractEscrowEvents(tx, options);

  assert.equal(envelopes.length, LIFECYCLE_FIXTURE.length);
  assert.deepEqual(
    envelopes.map((envelope) => envelope.event.name),
    LIFECYCLE_FIXTURE.map((event) => event.name),
  );
  for (const [index, envelope] of envelopes.entries()) {
    assert.equal(envelope.transactionSignature, signatureFor(1));
    assert.equal(envelope.slot, 500);
    assert.equal(envelope.instructionIndex, 0);
    assert.equal(envelope.innerInstructionIndex, index);
    assert.equal(envelope.programId, PROGRAM_ID);
    assert.equal(envelope.blockTime, 1_700_000_500);
  }
});

test("a failed transaction yields nothing", () => {
  // Nothing committed, so nothing happened. An indexer that read events from a
  // failed transaction would manufacture history out of an attempt.
  const tx = transactionFor({
    signature: signatureFor(2),
    slot: 501,
    events: [...LIFECYCLE_FIXTURE],
    err: { InstructionError: [0, { Custom: 6003 }] },
  });
  assert.deepEqual(extractEscrowEvents(tx, options), []);
});

test("a top-level instruction is never read as an event", () => {
  // An Anchor event CPI is the program invoking itself. A top-level
  // instruction carrying the same bytes is a request someone submitted, and
  // reading it as a fact would let anyone forge history for the price of a fee.
  const tx = transactionFor({
    signature: signatureFor(3),
    slot: 502,
    events: [...LIFECYCLE_FIXTURE],
    topLevel: true,
  });
  assert.deepEqual(extractEscrowEvents(tx, options), []);
});

test("an inner instruction without the event authority is not an event", () => {
  const tx = transactionFor({
    signature: signatureFor(4),
    slot: 503,
    events: [...LIFECYCLE_FIXTURE],
    withoutEventAuthority: true,
  });
  assert.deepEqual(extractEscrowEvents(tx, options), []);
});

test("another program's inner instructions are ignored", () => {
  const tx = transactionFor({
    signature: signatureFor(5),
    slot: 504,
    events: [...LIFECYCLE_FIXTURE],
    fromOtherProgram: true,
  });
  assert.deepEqual(extractEscrowEvents(tx, options), []);
});

test("non-event inner instructions are skipped without disturbing the rest", () => {
  const tx = transactionFor({
    signature: signatureFor(6),
    slot: 505,
    events: [LIFECYCLE_FIXTURE[1]!],
    noise: true,
  });
  const envelopes = extractEscrowEvents(tx, options);
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0]?.event.name, "AgreementFunded");
  // The token CPI sits at index 0, so the event's coordinate reflects its real
  // position — that is what makes the receipt id stable across a re-read.
  assert.equal(envelopes[0]?.innerInstructionIndex, 1);
});

test("addresses loaded from a lookup table resolve to the right program", () => {
  // On a versioned transaction the account list is static keys, then writable
  // loaded addresses, then readonly ones. Getting that order wrong reads the
  // wrong program id and silently drops every event.
  const tx = transactionFor({
    signature: signatureFor(7),
    slot: 506,
    events: [...LIFECYCLE_FIXTURE],
    viaLookupTable: true,
  });
  const keys = accountKeysOf(tx);
  assert.ok(keys.includes(PROGRAM_ID));
  assert.ok(keys.length > tx.transaction.message.accountKeys.length);
  assert.equal(extractEscrowEvents(tx, options).length, LIFECYCLE_FIXTURE.length);
});

test("the event authority is derived, not configured", () => {
  assert.equal(deriveEventAuthority(PROGRAM_ID), EVENT_AUTHORITY);
  // A different program has a different event authority, so events cannot be
  // attributed across programs even if their data were identical.
  assert.notEqual(deriveEventAuthority(encodeBase58(new Uint8Array(32).fill(11))), EVENT_AUTHORITY);
});

test("extraction works without a precomputed authority", () => {
  const tx = transactionFor({ signature: signatureFor(8), slot: 507, events: [LIFECYCLE_FIXTURE[0]!] });
  assert.equal(extractEscrowEvents(tx, { programId: PROGRAM_ID }).length, 1);
});

test("a transaction with no inner instructions is not an error", () => {
  const tx = transactionFor({ signature: signatureFor(9), slot: 508 });
  assert.deepEqual(extractEscrowEvents(tx, options), []);
});
