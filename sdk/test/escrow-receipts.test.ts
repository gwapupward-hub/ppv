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
  PROOF_APPROVED_FIXTURE,
  PROOF_FIXTURE,
  PROOF_REJECTED_FIXTURE,
  addressFromByte,
  signatureFromByte,
} from "./helpers/escrow-events.js";

const PROGRAM_ID = addressFromByte(9);

function envelope(event: PpvEscrowEvent, index: number): EscrowEventEnvelope {
  return {
    event,
    programId: PROGRAM_ID,
    transactionSignature: signatureFromByte(index + 1),
    slot: 1_000 + index,
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
    /never reached/,
  );
  // A lifecycle with no creation has no identity to describe.
  assert.throws(() => reconstructAgreementLifecycle(receipts.slice(1)), /missing its creation receipt/);
  // A settlement with no funding pays out custody that was never taken.
  assert.throws(
    () => reconstructAgreementLifecycle([receipts[0]!, { ...receipts[3]!, previousState: "Open" }]),
    /settlement without the funding/,
  );
});

test("order comes from the state chain, not from the order of arrival", () => {
  // The same four transitions delivered in reverse, with slots that agree,
  // must produce the same ordered history.
  const receipts = lifecycleReceipts();
  const lifecycle = reconstructAgreementLifecycle([...receipts].reverse());
  assert.deepEqual(
    lifecycle.receipts.map((receipt) => receipt.action),
    ["AGREEMENT_CREATED", "AGREEMENT_FUNDED", "WORK_COMPLETED", "SETTLEMENT_EXECUTED"],
  );
  assert.equal(lifecycle.lastSlot, 1_003);
});

test("a transition cannot commit before the transition it depends on", () => {
  // Causality is the one thing the state chain cannot check on its own: two
  // receipts can link perfectly and still describe an impossible history.
  const receipts = lifecycleReceipts();
  const backwards = [receipts[0]!, receipts[1]!, { ...receipts[2]!, slot: 5 }];
  assert.throws(() => reconstructAgreementLifecycle(backwards), /before the .* it follows/);
});

test("a forked history is refused rather than silently resolved", () => {
  const receipts = lifecycleReceipts();
  // Two different receipts both claiming to leave Funded.
  const rival = { ...receipts[2]!, receiptId: "ppvr_rival", actor: receipts[2]!.buyer };
  assert.throws(
    () => reconstructAgreementLifecycle([...receipts, rival]),
    /two transitions leave Funded/,
  );
});

test("a receipt cannot be built without a slot", () => {
  assert.throws(
    () => escrowReceiptFromEvent({ ...envelope(LIFECYCLE_FIXTURE[0]!, 0), slot: -1 }),
    /invalid slot/,
  );
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

test("evidence is recorded as an annotation, not as a transition", () => {
  const receipt = escrowReceiptFromEvent({
    event: PROOF_FIXTURE,
    programId: PROGRAM_ID,
    transactionSignature: signatureFromByte(90),
    slot: 1_001,
    instructionIndex: 0,
    innerInstructionIndex: 0,
    blockTime: PROOF_FIXTURE.timestamp,
  });

  assert.equal(receipt.kind, "annotation");
  assert.equal(receipt.action, "PROOF_SUBMITTED");
  assert.equal(receipt.amount, null, "anchoring evidence moves nothing");
  assert.equal(receipt.proof, FIXTURE_ADDRESSES.PROOF);
  assert.equal(receipt.proofIndex, 0);
  // Start and end in the same state: the agreement did not move.
  assert.equal(receipt.previousState, "Funded");
  assert.equal(receipt.newState, "Funded");
});

test("a proof lands in the history where it happened, without breaking the chain", () => {
  const receipts = lifecycleReceipts();
  const proof = escrowReceiptFromEvent({
    event: PROOF_FIXTURE,
    programId: PROGRAM_ID,
    transactionSignature: signatureFromByte(90),
    // After funding (slot 1001), before completion (slot 1002).
    slot: 1_001,
    instructionIndex: 0,
    innerInstructionIndex: 0,
    blockTime: PROOF_FIXTURE.timestamp,
  });

  const lifecycle = reconstructAgreementLifecycle([...receipts, proof]);
  assert.equal(lifecycle.state, "Settled", "an annotation cannot change the outcome");
  assert.deepEqual(
    lifecycle.receipts.map((entry) => entry.action),
    [
      "AGREEMENT_CREATED",
      "AGREEMENT_FUNDED",
      "PROOF_SUBMITTED",
      "WORK_COMPLETED",
      "SETTLEMENT_EXECUTED",
    ],
  );
  assert.equal(lifecycle.proofs.length, 1);
  assert.equal(lifecycle.proofs[0]?.proofIndex, 0);
  assert.equal(lifecycle.proofs[0]?.submitter, FIXTURE_ADDRESSES.SELLER);
  assert.equal(lifecycle.proofs[0]?.agreementState, "Funded");
});

test("annotations are placed identically however they arrive", () => {
  const receipts = lifecycleReceipts();
  const proofs = [1_001, 1_003, 1_002].map((slot, index) =>
    escrowReceiptFromEvent({
      event: { ...PROOF_FIXTURE, proofIndex: index },
      programId: PROGRAM_ID,
      transactionSignature: signatureFromByte(90 + index),
      slot,
      instructionIndex: 0,
      innerInstructionIndex: 0,
      blockTime: PROOF_FIXTURE.timestamp,
    }),
  );

  const forwards = reconstructAgreementLifecycle([...receipts, ...proofs]);
  const backwards = reconstructAgreementLifecycle([...proofs.reverse(), ...receipts.reverse()]);
  assert.deepEqual(backwards, forwards);
  assert.deepEqual(
    forwards.receipts.map((entry) => entry.action),
    [
      "AGREEMENT_CREATED",
      "AGREEMENT_FUNDED",
      "PROOF_SUBMITTED",
      "WORK_COMPLETED",
      "PROOF_SUBMITTED",
      "SETTLEMENT_EXECUTED",
      "PROOF_SUBMITTED",
    ],
  );
});

test("evidence cannot predate the agreement it annotates", () => {
  const receipts = lifecycleReceipts();
  const proof = escrowReceiptFromEvent({
    event: PROOF_FIXTURE,
    programId: PROGRAM_ID,
    transactionSignature: signatureFromByte(95),
    slot: 1,
    instructionIndex: 0,
    innerInstructionIndex: 0,
    blockTime: PROOF_FIXTURE.timestamp,
  });
  assert.throws(
    () => reconstructAgreementLifecycle([...receipts, proof]),
    /before this agreement existed/,
  );
});

function annotation(event: PpvEscrowEvent, slot: number, index: number) {
  return escrowReceiptFromEvent({
    event,
    programId: PROGRAM_ID,
    transactionSignature: signatureFromByte(120 + index),
    slot,
    instructionIndex: 0,
    innerInstructionIndex: 0,
    blockTime: event.timestamp,
  });
}

test("a proof carries the decision made about it", () => {
  const receipts = lifecycleReceipts();
  const lifecycle = reconstructAgreementLifecycle([
    ...receipts,
    annotation(PROOF_FIXTURE, 1_001, 0),
    annotation(PROOF_APPROVED_FIXTURE, 1_001, 1),
  ]);

  assert.equal(lifecycle.proofs.length, 1, "a decision is not a second proof");
  assert.equal(lifecycle.proofs[0]?.status, "Approved");
  assert.equal(lifecycle.proofs[0]?.decidedBy, FIXTURE_ADDRESSES.BUYER);
  assert.equal(lifecycle.proofs[0]?.submitter, FIXTURE_ADDRESSES.SELLER);
});

test("a rejected proof stays in the history as rejected", () => {
  const lifecycle = reconstructAgreementLifecycle([
    ...lifecycleReceipts(),
    annotation(PROOF_FIXTURE, 1_001, 0),
    annotation(PROOF_REJECTED_FIXTURE, 1_001, 1),
  ]);
  assert.equal(lifecycle.proofs[0]?.status, "Rejected");
  // Rejection is a fact, not an erasure: the submission is still there.
  assert.equal(lifecycle.receipts.filter((r) => r.action === "PROOF_SUBMITTED").length, 1);
});

test("a decision for evidence that was never submitted is refused", () => {
  assert.throws(
    () =>
      reconstructAgreementLifecycle([
        ...lifecycleReceipts(),
        annotation(PROOF_APPROVED_FIXTURE, 1_001, 1),
      ]),
    /never submitted/,
  );
});

test("evidence cannot be decided twice", () => {
  assert.throws(
    () =>
      reconstructAgreementLifecycle([
        ...lifecycleReceipts(),
        annotation(PROOF_FIXTURE, 1_001, 0),
        annotation(PROOF_APPROVED_FIXTURE, 1_001, 1),
        annotation(PROOF_REJECTED_FIXTURE, 1_002, 2),
      ]),
    /decided more than once/,
  );
});

test("a settlement can only cite evidence this history approved", () => {
  const receipts = lifecycleReceipts();
  const settled = receipts[3]!;
  const citing = { ...settled, proof: FIXTURE_ADDRESSES.PROOF };

  // Cited but never submitted.
  assert.throws(
    () => reconstructAgreementLifecycle([...receipts.slice(0, 3), citing]),
    /never saw/,
  );

  // Cited, submitted, but not approved.
  assert.throws(
    () =>
      reconstructAgreementLifecycle([
        ...receipts.slice(0, 3),
        citing,
        annotation(PROOF_FIXTURE, 1_001, 0),
      ]),
    /which is Submitted/,
  );

  // Cited, submitted, approved.
  const lifecycle = reconstructAgreementLifecycle([
    ...receipts.slice(0, 3),
    citing,
    annotation(PROOF_FIXTURE, 1_001, 0),
    annotation(PROOF_APPROVED_FIXTURE, 1_001, 1),
  ]);
  assert.equal(lifecycle.state, "Settled");
  assert.equal(lifecycle.receipts.at(-1)?.proof, FIXTURE_ADDRESSES.PROOF);
});
