import assert from "node:assert/strict";
import test from "node:test";
import {
  EVENT_IX_TAG,
  PPV_EVENT_NAMES,
  decodePpvEventData,
  eventDiscriminatorHex,
  programForEvent,
} from "../src/index.js";
import { FIXTURES, encodePpvEvent } from "./helpers/ppv-events.js";

// Pinned against programs/*/src/events.rs unit tests. A renamed event breaks
// both sides at the same time instead of one indexer at runtime.
const PINNED_DISCRIMINATORS = {
  ProofCreated: "10d53dd46fa025bf",
  ProofRevoked: "b4327f1cda1d232a",
  AgreementCreated: "8394cc12535c3912",
  AgreementRevised: "22ac9fe6955d1d17",
  AgreementSigned: "2728f17040dddbcb",
  AgreementExecuted: "4144f3def2bb1364",
  AgreementCancelled: "84c8be7df2040c92",
} as const;

test("event CPI tag is anchor's EVENT_IX_TAG_LE", () => {
  assert.equal(Buffer.from(EVENT_IX_TAG).toString("hex"), "e445a52e51cb9a1d");
});

test("every event discriminator is pinned", () => {
  for (const name of PPV_EVENT_NAMES) {
    assert.equal(eventDiscriminatorHex(name), PINNED_DISCRIMINATORS[name], name);
  }
});

test("every PPV event round-trips through the decoder", () => {
  for (const fixture of Object.values(FIXTURES)) {
    const decoded = decodePpvEventData(encodePpvEvent(fixture));
    assert.deepEqual(decoded, fixture, fixture.name);
  }
});

test("layout vectors match the Rust pins", () => {
  const created = encodePpvEvent(FIXTURES.proofCreated);
  assert.equal(created.length - 16, 32 + 32 + 16 + 32 + 32 + 1 + 8);
  assert.equal(created[16 + 144], 4, "ProofKind::Deliverable is 4");

  const revoked = encodePpvEvent(FIXTURES.proofRevoked);
  assert.equal(revoked.length - 16, 32 + 32 + 16 + 32 + 1 + 8);
  assert.equal(revoked[16 + 112], 1, "ProofKind::Document is 1");

  const executed = encodePpvEvent(FIXTURES.agreementExecuted);
  assert.equal(executed.length - 16, 32 * 3 + 4 + 32 * 2 + 8);

  const signed = encodePpvEvent(FIXTURES.agreementSigned);
  assert.equal(signed.length - 16, 32 * 4 + 4 + 32 * 2 + 8);

  const cancelled = encodePpvEvent(FIXTURES.agreementCancelled);
  assert.equal(cancelled.length - 16, 32 * 4 + 4 + 8);
});

test("non-PPV instruction data is not ours, malformed PPV data is an error", () => {
  assert.equal(decodePpvEventData(new Uint8Array(0)), null);
  assert.equal(decodePpvEventData(new Uint8Array(40).fill(7)), null);

  const unknownDiscriminator = encodePpvEvent(FIXTURES.proofCreated).slice();
  unknownDiscriminator[8] = (unknownDiscriminator[8] as number) ^ 0xff;
  assert.equal(decodePpvEventData(unknownDiscriminator), null);

  const truncated = encodePpvEvent(FIXTURES.proofCreated).subarray(0, 100);
  assert.throws(() => decodePpvEventData(truncated), /truncated/);

  const trailing = Uint8Array.from([...encodePpvEvent(FIXTURES.agreementExecuted), 0]);
  assert.throws(() => decodePpvEventData(trailing), /trailing/);

  const badKind = encodePpvEvent(FIXTURES.proofCreated).slice();
  badKind[16 + 144] = 9;
  assert.throws(() => decodePpvEventData(badKind), /proof kind/);
});

test("events are attributed to the program that owns them", () => {
  assert.equal(programForEvent("ProofCreated"), "ppv_core");
  assert.equal(programForEvent("ProofRevoked"), "ppv_core");
  assert.equal(programForEvent("AgreementExecuted"), "ppv_commerce");
});
