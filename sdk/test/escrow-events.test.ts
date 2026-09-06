import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  EVENT_IX_TAG,
  PPV_ESCROW_EVENT_NAMES,
  decodeEscrowEventData,
  decodeEventForProgram,
  decodePpvEventData,
  escrowEventDiscriminatorHex,
} from "../src/index.js";
import { encodePpvEvent } from "./helpers/ppv-events.js";
import {
  LIFECYCLE_FIXTURE,
  PROOF_APPROVED_FIXTURE,
  PROOF_FIXTURE,
  PROOF_REJECTED_FIXTURE,
  addressFromByte,
  encodeEscrowEvent,
  hexFromByte,
} from "./helpers/escrow-events.js";

test("every escrow event round-trips through the decoder", () => {
  const all = [
    ...LIFECYCLE_FIXTURE,
    PROOF_FIXTURE,
    PROOF_APPROVED_FIXTURE,
    PROOF_REJECTED_FIXTURE,
  ];
  for (const fixture of all) {
    assert.deepEqual(decodeEscrowEventData(encodeEscrowEvent(fixture)), fixture);
  }
  assert.equal(
    new Set(all.map((event) => event.name)).size,
    PPV_ESCROW_EVENT_NAMES.length,
    "the fixtures must exercise every escrow event",
  );
});

test("a proof event names the agreement it is bound to and the state it saw", () => {
  const decoded = decodeEscrowEventData(encodeEscrowEvent(PROOF_FIXTURE));
  assert.equal(decoded?.name, "ProofSubmitted");
  if (decoded?.name !== "ProofSubmitted") return;
  assert.equal(decoded.agreement, LIFECYCLE_FIXTURE[0]!.agreement);
  assert.equal(decoded.proofIndex, 0);
  // Anchoring evidence does not move the agreement, so the event reports the
  // state it was already in rather than a transition.
  assert.equal(decoded.agreementState, "Funded");
  assert.equal(decoded.metadataHash, "0".repeat(64), "no metadata commitment");
});

test("discriminators are the anchor derivation and nothing else", () => {
  for (const name of PPV_ESCROW_EVENT_NAMES) {
    const expected = createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
    assert.equal(escrowEventDiscriminatorHex(name), expected.toString("hex"));
  }
});

test("data that is not an escrow event decodes to null, not a guess", () => {
  assert.equal(decodeEscrowEventData(new Uint8Array(0)), null);
  assert.equal(decodeEscrowEventData(new Uint8Array(40).fill(7)), null);

  const unknown = new Uint8Array(40);
  unknown.set(EVENT_IX_TAG, 0);
  unknown.set(Uint8Array.of(9, 9, 9, 9, 9, 9, 9, 9), 8);
  assert.equal(decodeEscrowEventData(unknown), null);
});

test("malformed escrow events throw instead of decoding partially", () => {
  const encoded = encodeEscrowEvent(LIFECYCLE_FIXTURE[1]!);
  assert.throws(() => decodeEscrowEventData(encoded.subarray(0, encoded.length - 1)), /truncated/);
  assert.throws(
    () => decodeEscrowEventData(Uint8Array.from([...encoded, 0])),
    /trailing/,
  );

  const badState = Uint8Array.from(encoded);
  badState[encoded.length - 10] = 9; // previous_state
  assert.throws(() => decodeEscrowEventData(badState), /unknown agreement state/);
});

test("an escrow event is never mistaken for a commerce event of the same name", () => {
  // Anchor derives an event discriminator from the name alone, so
  // ppv_commerce's AgreementCreated and ppv_escrow's share one. Event identity
  // is the pair (program id, discriminator): the emitting program picks the
  // decoder, and the shared decoder must never return a plausible-looking
  // commerce event from escrow bytes.
  const encoded = encodeEscrowEvent(LIFECYCLE_FIXTURE[0]!);
  assert.equal(
    escrowEventDiscriminatorHex("AgreementCreated"),
    createHash("sha256").update("event:AgreementCreated").digest().subarray(0, 8).toString("hex"),
  );
  assert.throws(() => decodePpvEventData(encoded));

  assert.deepEqual(decodeEventForProgram("ppv_escrow", encoded), {
    program: "ppv_escrow",
    event: LIFECYCLE_FIXTURE[0],
  });
  assert.throws(() => decodeEventForProgram("ppv_commerce", encoded));
});

test("a commerce event decoded as escrow is refused, not reinterpreted", () => {
  const commerceExecuted = encodePpvEvent({
    name: "AgreementExecuted",
    agreement: addressFromByte(5),
    partyA: addressFromByte(1),
    partyB: addressFromByte(2),
    version: 3,
    contentHash: hexFromByte(4, 32),
    termsHash: hexFromByte(5, 32),
    executedAt: 1_700_000_002,
  });
  assert.equal(decodeEscrowEventData(commerceExecuted), null);
  assert.equal(decodeEventForProgram("ppv_escrow", commerceExecuted), null);
  assert.throws(() => decodeEventForProgram("ppv_core", commerceExecuted), /belongs to ppv_commerce/);
});

test("amounts stay bigint so a u64 cannot round", () => {
  const huge = { ...LIFECYCLE_FIXTURE[1]!, amount: 18_446_744_073_709_551_615n };
  const decoded = decodeEscrowEventData(encodeEscrowEvent(huge));
  assert.equal(decoded?.name, "AgreementFunded");
  assert.equal(decoded?.name === "AgreementFunded" ? decoded.amount : 0n, 18_446_744_073_709_551_615n);
});

test("a settlement can carry a proof reference without a layout change", () => {
  const settled = LIFECYCLE_FIXTURE[3]!;
  assert.equal(settled.name, "SettlementExecuted");
  const withProof = { ...settled, proof: "11111111111111111111111111111111" } as typeof settled;
  assert.deepEqual(decodeEscrowEventData(encodeEscrowEvent(withProof)), withProof);
});

test("approval and rejection are one shape told apart by their discriminator", () => {
  // A consumer should never have to reconcile two field layouts for one kind
  // of fact, and should never have to guess which decision it is reading.
  const approved = encodeEscrowEvent(PROOF_APPROVED_FIXTURE);
  const rejected = encodeEscrowEvent(PROOF_REJECTED_FIXTURE);
  assert.equal(approved.length, rejected.length);
  assert.deepEqual(approved.subarray(16), rejected.subarray(16), "identical fields");
  assert.notDeepEqual(approved.subarray(8, 16), rejected.subarray(8, 16), "different names");

  assert.equal(decodeEscrowEventData(approved)?.name, "ProofApproved");
  assert.equal(decodeEscrowEventData(rejected)?.name, "ProofRejected");
});
