import assert from "node:assert/strict";
import test from "node:test";

import { escrowReceiptFromEvent, type EscrowEventEnvelope } from "@gwap/ppv-sdk";

import { ReceiptStore } from "../src/projections.js";
import { extractEscrowEvents } from "../src/events.js";
import {
  OPENED_EVENT,
  EVENT_AUTHORITY,
  FIXTURE_ADDRESSES,
  LIFECYCLE_FIXTURE,
  PROGRAM_ID,
  addressFromByte,
  signatureFor,
  transactionFor,
} from "./helpers/chain-fixtures.js";

const options = { programId: PROGRAM_ID, eventAuthority: EVENT_AUTHORITY };

function envelopes(): EscrowEventEnvelope[] {
  return LIFECYCLE_FIXTURE.flatMap((event, index) =>
    extractEscrowEvents(
      transactionFor({ signature: signatureFor(index + 1), slot: 100 + index, events: [event] }),
      options,
    ),
  );
}

test("the same delivery seen many times is one receipt", () => {
  const store = new ReceiptStore();
  const found = envelopes();

  assert.equal(store.addEvents(found), 4);
  assert.equal(store.addEvents(found), 0, "a redelivery adds nothing");
  assert.equal(store.addEvents([...found].reverse()), 0);
  assert.equal(store.size, 4);
});

test("a store converges on the same projection whatever order it was fed", () => {
  const found = envelopes();
  const forwards = new ReceiptStore();
  forwards.addEvents(found);

  const backwards = new ReceiptStore();
  backwards.addEvents([...found].reverse());
  backwards.addEvents(found.slice(1, 3));

  assert.deepEqual(
    backwards.projectAgreement(FIXTURE_ADDRESSES.AGREEMENT),
    forwards.projectAgreement(FIXTURE_ADDRESSES.AGREEMENT),
  );
});

test("a receipt id that resolves to different content is refused", () => {
  // Two different facts cannot share an id. If they appear to, one of them did
  // not come from the transaction it names, and picking a winner would bake
  // the wrong one into the projection.
  const store = new ReceiptStore();
  const [first] = envelopes();
  const receipt = escrowReceiptFromEvent(first!);
  store.add(receipt);

  assert.throws(
    () => store.add({ ...receipt, agreement: addressFromByte(31) }),
    /replayed with different content/,
  );
});

test("one store holds many agreements and projects each separately", () => {
  const other = addressFromByte(30);
  const store = new ReceiptStore();
  store.addEvents(envelopes());
  store.addEvents(
    extractEscrowEvents(
      transactionFor({
        signature: signatureFor(60),
        slot: 200,
        events: [{ ...OPENED_EVENT, agreement: other, agreementId: 43n }],
      }),
      options,
    ),
  );

  const projections = store.project();
  assert.equal(projections.size, 2);
  assert.equal(projections.get(FIXTURE_ADDRESSES.AGREEMENT)?.state, "Settled");
  assert.equal(projections.get(other)?.state, "Open");
  assert.equal(projections.get(other)?.agreementId, 43n);
  assert.equal(store.forAgreement(other).length, 1);
});

test("an inconsistent history fails the projection instead of being reported", () => {
  const store = new ReceiptStore();
  const found = envelopes();
  // Settlement delivered without the completion it must follow.
  store.addEvents([found[0]!, found[1]!, found[3]!]);
  assert.throws(() => store.projectAgreement(FIXTURE_ADDRESSES.AGREEMENT), /never reached/);
});
