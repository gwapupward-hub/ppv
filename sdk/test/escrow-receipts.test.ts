import assert from "node:assert/strict";
import test from "node:test";

import {
  ReceiptError,
  escrowReceiptFromEvent,
  reconstructAgreementLifecycle,
  type EscrowEventEnvelope,
  type PpvEscrowEvent,
  type PpvEscrowReceiptV1,
} from "../src/index.js";
import {
  FIXTURE_ADDRESSES,
  LIFECYCLE_FIXTURE,
  addressFromByte,
  signatureFromByte,
} from "./helpers/escrow-events.js";

const PROGRAM_ID = addressFromByte(9);

function envelope(event: PpvEscrowEvent, index: number): EscrowEventEnvelope {
  return {
    event,
    programId: PROGRAM_ID,
    transactionSignature: signatureFromByte(index + 1),
    instructionIndex: 0,
    innerInstructionIndex: index,
    blockTime: event.timestamp,
  };
}

function lifecycleReceipts(): PpvEscrowReceiptV1[] {
  return LIFECYCLE_FIXTURE.map((event, index) => escrowReceiptFromEvent(envelope(event, index)));
}

test("a receipt is a pure function of the transaction that produced it", () => {
  const once = lifecycleReceipts();
  const twice = lifecycleReceipts();
  assert.deepEqual(once, twice);

  // Replaying the same delivery must not create a second receipt.
  const ids = new Set(once.map((receipt) => receipt.receiptId));
  assert.equal(ids.size, once.length);
  assert.equal(new Set([...once, ...twice].map((r) => r.receiptId)).size, once.length);
});

test("a receipt names the agreement, the parties, and the exact transition", () => {
  const [created, funded, completed, settled] = lifecycleReceipts();

  assert.equal(created?.action, "AGREEMENT_CREATED");
  assert.equal(created?.agreement, FIXTURE_ADDRESSES.AGREEMENT);
  assert.equal(created?.agreementId, 42n);
  assert.equal(created?.previousState, null);
  assert.equal(created?.newState, "Open");
  assert.equal(created?.amount, null, "creation moves no tokens");

  assert.equal(funded?.amount, 100_000_000n);
  assert.equal(funded?.destination, FIXTURE_ADDRESSES.VAULT);
  assert.equal(funded?.previousState, "Open");
  assert.equal(funded?.newState, "Funded");

  assert.equal(completed?.amount, null, "completion moves no tokens");
  assert.equal(completed?.actor, FIXTURE_ADDRESSES.SELLER);

  assert.equal(settled?.amount, 100_000_000n);
  assert.equal(settled?.destination, FIXTURE_ADDRESSES.SELLER_ATA);
  assert.equal(settled?.previousState, "Completed");
  assert.equal(settled?.newState, "Settled");
  assert.equal(settled?.proof, null);
});

test("an indexer rebuilds the lifecycle from receipts alone", () => {
  const lifecycle = reconstructAgreementLifecycle(lifecycleReceipts());
  assert.equal(lifecycle.agreement, FIXTURE_ADDRESSES.AGREEMENT);
  assert.equal(lifecycle.agreementId, 42n);
  assert.equal(lifecycle.buyer, FIXTURE_ADDRESSES.BUYER);
  assert.equal(lifecycle.seller, FIXTURE_ADDRESSES.SELLER);
  assert.equal(lifecycle.mint, FIXTURE_ADDRESSES.MINT);
  assert.equal(lifecycle.state, "Settled");
  assert.equal(lifecycle.fundedAmount, 100_000_000n);
  assert.equal(lifecycle.settledAmount, 100_000_000n);
  assert.equal(lifecycle.settlementDestination, FIXTURE_ADDRESSES.SELLER_ATA);
});

test("out-of-order and duplicated delivery produce identical history", () => {
  const receipts = lifecycleReceipts();
  const shuffled = [receipts[3]!, receipts[1]!, receipts[3]!, receipts[0]!, receipts[2]!, receipts[1]!];
  assert.deepEqual(
    reconstructAgreementLifecycle(shuffled),
    reconstructAgreementLifecycle(receipts),
  );
});

test("a partial history reports the state it actually reached", () => {
  const receipts = lifecycleReceipts();
  const lifecycle = reconstructAgreementLifecycle(receipts.slice(0, 2));
  assert.equal(lifecycle.state, "Funded");
  assert.equal(lifecycle.fundedAmount, 100_000_000n);
  assert.equal(lifecycle.settledAmount, null);
});

test("a history that does not chain is refused", () => {
  const receipts = lifecycleReceipts();
  // Settlement without the completion that legally precedes it.
  assert.throws(
    () => reconstructAgreementLifecycle([receipts[0]!, receipts[1]!, receipts[3]!]),
    ReceiptError,
  );
  // A lifecycle with no creation has no identity to describe.
  assert.throws(() => reconstructAgreementLifecycle(receipts.slice(1)), /missing its creation receipt/);
});

test("receipts from two agreements cannot be merged into one history", () => {
  const mine = lifecycleReceipts();
  const theirs = escrowReceiptFromEvent(
    envelope({ ...LIFECYCLE_FIXTURE[0]!, agreement: addressFromByte(11) }, 7),
  );
  assert.throws(() => reconstructAgreementLifecycle([...mine, theirs]), /more than one agreement/);
});

test("a settlement that disagrees with custody is refused", () => {
  const receipts = lifecycleReceipts();
  const tampered = { ...receipts[3]!, amount: 999_999_999n };
  assert.throws(
    () => reconstructAgreementLifecycle([receipts[0]!, receipts[1]!, receipts[2]!, tampered]),
    /settled amount does not match/,
  );
});

test("a receipt cannot be built without the chain coordinates that anchor it", () => {
  assert.throws(
    () => escrowReceiptFromEvent({ ...envelope(LIFECYCLE_FIXTURE[0]!, 0), transactionSignature: "" }),
    /transaction signature/,
  );
  assert.throws(
    () => escrowReceiptFromEvent({ ...envelope(LIFECYCLE_FIXTURE[0]!, 0), instructionIndex: -1 }),
    /instruction index/,
  );
});

test("the same event in a different transaction is a different receipt", () => {
  const first = escrowReceiptFromEvent(envelope(LIFECYCLE_FIXTURE[1]!, 1));
  const second = escrowReceiptFromEvent({
    ...envelope(LIFECYCLE_FIXTURE[1]!, 1),
    transactionSignature: signatureFromByte(200),
  });
  assert.notEqual(first.receiptId, second.receiptId);
});
